/**
 * Hauptlogik des X-Unwetterwarnungs-Workers.
 *
 * Ablauf:
 *   1. Alarme von der API (Stage oder Prod) abholen.
 *   2. Aktive Alarme filtern (now zwischen valid_from und valid_to, priority >= 2).
 *   3. Mit posted.json abgleichen: gibt's NEUE alarm.id?
 *   4. Wenn ja:
 *        a) Render-Seite via Playwright → JPEG-Screenshot.
 *        b) Tweet-Texte für DE/FR/IT bauen.
 *        c) Bild auf alle drei X-Accounts hochladen + Tweet posten.
 *        d) State aktualisieren, neuen State committen (durch Workflow).
 *   5. Wenn keine neuen Alarme → nichts tun.
 *
 * Vor Schritt 1 läuft bei jedem Run das Aufräumen: Tweets aus dem Register
 * (state._tweets), deren deleteAfter erreicht ist, werden auf X gelöscht.
 * Warnungs-Posts: deleteAfter = max(valid_to der enthaltenen Alarme) +
 * TWEET_RETENTION_DAYS. Entwarnung/Vorinfo: Post-Zeitpunkt + TWEET_RETENTION_DAYS.
 *
 * DRY_RUN=true → keine Tweets, kein Bild-Upload, kein Löschen; State trotzdem
 *                updaten, damit Stage-Testläufe nicht jedes Mal als "neu" rendern.
 *
 * Environment-Variablen:
 *   ENV               = 'prod' | 'stage'  (Default: 'prod')
 *   RENDER_BASE_URL   = z.B. https://tool.wetteralarm.ch/x-warnungen
 *   DRY_RUN           = 'true' für Testlauf ohne Posting
 *   TWEET_RETENTION_DAYS = Tage nach Gültigkeitsende, bis ein Post gelöscht
 *                       wird (Default: 14)
 *   X_TOKENS_DE       = JSON-String mit { apiKey, apiSecret, accessToken, accessSecret }
 *   X_TOKENS_FR       = "
 *   X_TOKENS_IT       = "
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import {
    buildTweets,
    buildClearTweets,
    buildPreInfoTweets,
    detectPreInfoCondition,
    filterActiveAlarms,
    hasAnyActiveAlarmAllLevels
} from './lib/templates.js';
import {
    loadState,
    saveState,
    findNewAlarms,
    markPosted,
    getLastPostedAt,
    getLastPostType,
    getFirstSeenAt,
    setFirstSeenAt,
    clearFirstSeenAt,
    recordTweets,
    getTweetsDueForDeletion,
    removeTweet
} from './lib/dedupe.js';
import { captureMap } from './render-screenshot.js';

const ENV = process.env.ENV === 'stage' ? 'stage' : 'prod';
const RENDER_BASE_URL = process.env.RENDER_BASE_URL || 'https://tool.wetteralarm.ch/x-warnungen';
const DRY_RUN = process.env.DRY_RUN === 'true';

// Aufbewahrung: Posts werden TWEET_RETENTION_DAYS nach Gültigkeitsende gelöscht.
const TWEET_RETENTION_DAYS = Number.parseInt(process.env.TWEET_RETENTION_DAYS || '14', 10);
const TWEET_RETENTION_MS = (Number.isFinite(TWEET_RETENTION_DAYS) && TWEET_RETENTION_DAYS > 0
    ? TWEET_RETENTION_DAYS : 14) * 24 * 60 * 60 * 1000;
// Rate-Limit DELETE /2/tweets/:id ist 50 / 15 min pro Account — pro Run
// deutlich darunter bleiben, Rest wird beim nächsten 5-Min-Run abgearbeitet.
const MAX_DELETES_PER_RUN = 20;

const API_HOSTS = {
    prod:  'https://my.wetteralarm.ch',
    stage: 'https://sta.my.wetteralarm.ch'
};
const ALARMS_URL = `${API_HOSTS[ENV]}/v7/alarms/meteo-and-hail.json`;

const STATE_FILE = path.join(process.cwd(), 'state', 'posted.json');

const LANGS = ['de', 'fr', 'it'];

// ===========================================
// API-Fetch
// ===========================================

async function fetchAlarms() {
    console.log(`[main] Hole Alarme: ${ALARMS_URL}`);
    const resp = await fetch(ALARMS_URL, {
        headers: { 'Accept': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Alarms-API ${resp.status}: ${resp.statusText}`);
    const data = await resp.json();
    return data.meteo_alarms || [];
}

// ===========================================
// Twitter-Client pro Sprache
// ===========================================

function loadTwitterClient(lang) {
    const envName = `X_TOKENS_${lang.toUpperCase()}`;
    const raw = process.env[envName];
    if (!raw) {
        console.warn(`[main] ${envName} nicht gesetzt — überspringe ${lang}`);
        return null;
    }
    let tokens;
    try {
        tokens = JSON.parse(raw);
    } catch (e) {
        console.error(`[main] ${envName} ist kein gültiges JSON:`, e.message);
        return null;
    }
    const { apiKey, apiSecret, accessToken, accessSecret } = tokens;
    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
        console.error(`[main] ${envName} unvollständig — apiKey/apiSecret/accessToken/accessSecret nötig`);
        return null;
    }
    return new TwitterApi({
        appKey:       apiKey,
        appSecret:    apiSecret,
        accessToken:  accessToken,
        accessSecret: accessSecret
    });
}

// ===========================================
// Posting
// ===========================================

async function postToX(client, lang, text, imageBuffer) {
    if (!client) {
        console.log(`[post:${lang}] Skip — kein Client konfiguriert.`);
        return { ok: false, reason: 'no-client' };
    }
    try {
        // 1. Media uploaden (V1.1 — V2 unterstützt kein Media-Upload)
        const mediaId = await client.v1.uploadMedia(imageBuffer, { mimeType: 'image/jpeg' });
        // 2. Tweet mit Media-Referenz (V2)
        const result = await client.v2.tweet({
            text,
            media: { media_ids: [mediaId] }
        });
        console.log(`[post:${lang}] ✓ Tweet ID ${result.data?.id}`);
        return { ok: true, id: result.data?.id };
    } catch (e) {
        console.error(`[post:${lang}] ✗ Fehler:`, e.data || e.message || e);
        return { ok: false, reason: e.message || String(e) };
    }
}

// ===========================================
// Löschen alter Posts
// ===========================================

/**
 * deleteAfter für einen Warnungs-Post: Ende der spätesten Alarm-Gültigkeit
 * plus Aufbewahrungsfrist. Ohne auswertbares valid_to → ab Post-Zeitpunkt.
 */
function computeDeleteAfter(alarms, now = Date.now()) {
    let latestValidTo = 0;
    for (const a of alarms || []) {
        const to = new Date(a.valid_to).getTime();
        if (Number.isFinite(to) && to > latestValidTo) latestValidTo = to;
    }
    return Math.max(latestValidTo, now) + TWEET_RETENTION_MS;
}

/**
 * Löscht fällige Tweets aus dem Register. Wird bei jedem Run aufgerufen,
 * unabhängig von der Alarmlage. Erfolg oder 404 (Tweet schon weg) → Eintrag
 * raus; jeder andere Fehler → Eintrag bleibt, Retry beim nächsten Run.
 * Rückgabe: true, wenn sich der State geändert hat.
 */
async function deleteExpiredTweets(state) {
    const due = getTweetsDueForDeletion(state);
    if (due.length === 0) return false;
    console.log(`[cleanup] ${due.length} Tweet(s) fällig zum Löschen.`);

    const clients = {};
    let changed = false;
    let done = 0;
    for (const t of due) {
        if (done >= MAX_DELETES_PER_RUN) {
            console.log(`[cleanup] Limit ${MAX_DELETES_PER_RUN}/Run erreicht — Rest beim nächsten Run.`);
            break;
        }
        const ageDays = Math.round((Date.now() - t.postedAt) / 86400000);
        if (DRY_RUN) {
            console.log(`[cleanup:${t.lang}] DRY_RUN — würde löschen: ${t.id} (${t.type}, ${ageDays} d alt)`);
            continue;
        }
        if (!(t.lang in clients)) clients[t.lang] = loadTwitterClient(t.lang);
        const client = clients[t.lang];
        if (!client) {
            console.warn(`[cleanup:${t.lang}] Kein Client — ${t.id} bleibt im Register.`);
            continue;
        }
        try {
            await client.v2.deleteTweet(t.id);
            console.log(`[cleanup:${t.lang}] ✓ gelöscht: ${t.id} (${t.type}, ${ageDays} d alt)`);
            removeTweet(state, t.id);
            changed = true;
        } catch (e) {
            if (e && e.code === 404) {
                console.log(`[cleanup:${t.lang}] ${t.id} existiert nicht mehr (404) — aus Register entfernt.`);
                removeTweet(state, t.id);
                changed = true;
            } else {
                console.error(`[cleanup:${t.lang}] ✗ ${t.id}:`, e.data || e.message || e);
            }
        }
        done++;
    }
    return changed;
}

// ===========================================
// Cooldown — orientiert sich am ÄLTESTEN noch nicht geposteten Alarm.
// ===========================================
//
// Idee: Wenn neue Alarme rein-tröpfeln und der frühste erst in einigen Stunden
//       aktiv wird, lohnt es sich abzuwarten und mehrere Alarme zu bündeln.
//       Wenn er aber unmittelbar bevorsteht (≤2h), sofort raus damit.
//
//   Lead-Time bis valid_from des ältesten neuen Alarms:
//     ≤ 2h   → kein Cooldown (sofort posten)
//     2–6h   → 30 min Cooldown seit letztem Post
//     > 6h   → 60 min Cooldown
//
// "Ältester noch nicht geposteter Alarm" = der mit dem frühsten valid_from
// in der Liste der NEUEN Alarme (findNewAlarms).
const COOLDOWN_TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const COOLDOWN_SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function computeCooldownMs(newAlarms, now = new Date()) {
    if (!Array.isArray(newAlarms) || newAlarms.length === 0) return 0;
    const earliestValidFrom = Math.min(
        ...newAlarms.map(a => new Date(a.valid_from).getTime())
    );
    const leadTimeMs = earliestValidFrom - now.getTime();
    // Bereits aktiv oder in <2h aktiv: nicht warten.
    if (leadTimeMs <= COOLDOWN_TWO_HOURS_MS) return 0;
    if (leadTimeMs <= COOLDOWN_SIX_HOURS_MS) return 30 * 60 * 1000;
    return 60 * 60 * 1000;
}

function formatDurationMs(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ===========================================
// Screenshot-Helper — wird sowohl für Warnungs- als auch Entwarnungs-Tweets
// gebraucht (bei Entwarnung ist die Karte einfach leer — User-Spez: "Zeige
// auch hier die Karte").
// ===========================================
async function takeScreenshot(label) {
    const renderUrl = `${RENDER_BASE_URL}/render.html?env=${ENV}`;
    const { jpeg, error } = await captureMap(renderUrl);
    if (error) {
        console.error(`[main:${label}] Screenshot fehlgeschlagen:`, error);
    }
    if (jpeg) {
        const mode = DRY_RUN ? 'dry' : 'live';
        const shotPath = path.join(
            process.cwd(),
            'state',
            `screenshot-${mode}-${label}-${Date.now()}.jpg`
        );
        await fs.writeFile(shotPath, jpeg);
        console.log(`[main:${label}] Screenshot abgelegt: ${shotPath}`);
    }
    return { jpeg, error };
}

// Setzt _firstSeenAt zurück, falls gerade keine neuen Alarme anstehen — damit
// die nächste Welle nicht fälschlich gegen einen alten Timer geprüft wird.
async function resetFirstSeenIfSet(state) {
    if (getFirstSeenAt(state) > 0) {
        clearFirstSeenAt(state);
        await saveState(STATE_FILE, state);
        console.log('[main] _firstSeenAt zurückgesetzt (keine offenen Alarme).');
    }
}

async function postAllLangs(tweets, jpeg) {
    const results = {};
    for (const lang of LANGS) {
        const text = tweets[lang];
        if (!text) {
            results[lang] = { ok: false, reason: 'no-text' };
            continue;
        }
        const client = loadTwitterClient(lang);
        results[lang] = await postToX(client, lang, text, jpeg);
    }
    return results;
}

// ===========================================
// Main
// ===========================================

async function main() {
    console.log(`[main] Start — ENV=${ENV} DRY_RUN=${DRY_RUN}`);

    const alarms = await fetchAlarms();
    const active = filterActiveAlarms(alarms);
    const anyActiveAllLevels = hasAnyActiveAlarmAllLevels(alarms);
    console.log(
        `[main] ${active.length} aktive Alarme (Stufe >= 2) von ${alarms.length}` +
        ` — anyActiveAllLevels=${anyActiveAllLevels}`
    );

    const state = await loadState(STATE_FILE);
    const lastPostedAt = getLastPostedAt(state);
    const lastPostType = getLastPostType(state);

    // ---------------------------------------------------------------
    // 0) Aufräumen: fällige alte Posts auf X löschen (unabhängig von der Lage).
    //    Sofort persistieren — main() hat viele frühe return-Pfade.
    // ---------------------------------------------------------------
    if (await deleteExpiredTweets(state)) {
        await saveState(STATE_FILE, state);
        console.log('[cleanup] Register persistiert.');
    }

    // ---------------------------------------------------------------
    // 1) Entwarnungs-Logik
    // ---------------------------------------------------------------
    // Es gibt KEINEN aktiven Alarm mehr (auch keine Stufe 1), aber der letzte
    // Post war eine Warnung — also einmalig Entwarnung posten.
    if (!anyActiveAllLevels) {
        // Welle vorbei → ggf. hängenden _firstSeenAt-Timer aufräumen.
        await resetFirstSeenIfSet(state);
        if (lastPostType === 'warning') {
            console.log('[main] Keine aktiven Warnungen mehr → Entwarnungs-Tweet.');
            const tweets = buildClearTweets();
            for (const lang of LANGS) {
                console.log(
                    `\n[tweet:${lang}] (clear, ${tweets[lang].length} Zeichen)\n${tweets[lang]}\n`
                );
            }
            const { jpeg, error: shotError } = await takeScreenshot('clear');
            if (shotError && !DRY_RUN) {
                console.error('[main] Entwarnung: ohne Bild kein Post → abbrechen.');
                return;
            }

            if (DRY_RUN) {
                markPosted(state, [], 'clear');
                await saveState(STATE_FILE, state);
                console.log('[main] DRY_RUN clear: State aktualisiert. Kein Tweet gesendet.');
                return;
            }

            const results = await postAllLangs(tweets, jpeg);
            const anySuccess = Object.values(results).some(r => r.ok);
            if (anySuccess) {
                markPosted(state, [], 'clear');
                recordTweets(state, results, 'clear', Date.now() + TWEET_RETENTION_MS);
                await saveState(STATE_FILE, state);
                console.log('[main] Entwarnung gepostet, State persistiert.');
            } else {
                console.error('[main] Entwarnung: kein Tweet erfolgreich → State NICHT aktualisiert.');
                process.exitCode = 1;
            }
            return;
        }
        console.log('[main] Keine aktiven Warnungen, letzter Post war auch keine Warnung → nichts zu tun.');
        return;
    }

    // ---------------------------------------------------------------
    // 2) Warnungs-Logik (es gibt Stufe-2/3-Alarme — nur diese triggern Posts)
    // ---------------------------------------------------------------
    if (active.length === 0) {
        // Keine Stufe-2/3-Alarme aktiv. Aber vielleicht ist die Stufe-1-Lage
        // breitflächig genug für eine Vorinformation (siehe templates.js).
        const preInfo = detectPreInfoCondition(alarms, state);
        if (preInfo.shouldPost) {
            console.log(
                `[main] Vorinformation: ${preInfo.regionCount} Regionen (${preInfo.regionRatio}%)` +
                ` — target=${preInfo.targetDate}`
            );
            const tweets = buildPreInfoTweets(preInfo);
            for (const lang of LANGS) {
                console.log(
                    `\n[tweet:${lang}] (preinfo, ${tweets[lang].length} Zeichen)\n${tweets[lang]}\n`
                );
            }
            const { jpeg, error: shotError } = await takeScreenshot('preinfo');
            if (shotError && !DRY_RUN) {
                console.error('[main] Vorinfo: ohne Bild kein Post → abbrechen.');
                return;
            }
            // Helper: in das geposteten-Set einfügen (sowohl Hauptlage- als
            // auch frühster-Alarm-Tag — beide Schlüssel zählen als "abgedeckt",
            // damit auch nach Code-/Semantik-Änderungen kein Doppelpost passiert).
            const markPreInfoPosted = () => {
                if (!state._postedPreInfoDates) state._postedPreInfoDates = {};
                const ts = Date.now();
                state._postedPreInfoDates[preInfo.targetDate] = ts;
                if (preInfo.firstDate && preInfo.firstDate !== preInfo.targetDate) {
                    state._postedPreInfoDates[preInfo.firstDate] = ts;
                }
                state._lastPreInfoTargetDate = preInfo.targetDate; // backwards-compat
            };

            if (DRY_RUN) {
                markPreInfoPosted();
                await saveState(STATE_FILE, state);
                console.log('[main] DRY_RUN preinfo: State aktualisiert. Kein Tweet gesendet.');
                return;
            }
            const results = await postAllLangs(tweets, jpeg);
            const anySuccess = Object.values(results).some(r => r.ok);
            if (anySuccess) {
                // _lastPostType wird NICHT auf 'preinfo' gesetzt — Entwarnung soll nur
                // nach echten Warnungs-Posts ausgelöst werden, nicht nach Vorinformationen.
                markPreInfoPosted();
                recordTweets(state, results, 'preinfo', Date.now() + TWEET_RETENTION_MS);
                await saveState(STATE_FILE, state);
                console.log('[main] Vorinformation gepostet, State persistiert.');
            } else {
                console.error('[main] Vorinfo: kein Tweet erfolgreich → State NICHT aktualisiert.');
                process.exitCode = 1;
            }
            return;
        }
        // Es laufen nur Stufe-1-Alarme, aber Vorinfo-Bedingung nicht erfüllt
        // (zu wenige Regionen, zu kurzer Vorlauf, oder schon gepostet).
        console.log('[main] Nur Stufe-1-Alarme aktiv → kein Post, keine Entwarnung.');
        await resetFirstSeenIfSet(state);
        return;
    }

    const newOnes = findNewAlarms(active, state);
    console.log(`[main] ${newOnes.length} davon sind NEU (nicht im posted.json)`);

    if (newOnes.length === 0) {
        console.log('[main] Keine neuen Alarm-IDs → kein Post.');
        await resetFirstSeenIfSet(state);
        return;
    }

    // Intelligenter Cooldown: berechnet aus Lead-Time des ÄLTESTEN neuen Alarms.
    //
    // Referenzzeitpunkt für die "ist der Cooldown schon abgelaufen?"-Frage:
    //   1. _lastPostedAt — wenn schon einmal gepostet wurde
    //   2. _firstSeenAt  — wenn noch nie gepostet wurde, aber die Welle bereits
    //                      einmal gesehen wurde (Timer aus vorherigem Run)
    //   3. now           — Erstsichtung: Timer setzen und beim nächsten Run posten
    const cooldownMs = computeCooldownMs(newOnes);
    let cooldownRef = lastPostedAt;
    let cooldownRefLabel = 'letztem Post';
    if (cooldownRef === 0 && cooldownMs > 0) {
        cooldownRef = getFirstSeenAt(state);
        cooldownRefLabel = 'erster Sichtung';
        if (cooldownRef === 0) {
            // Erstsichtung — Timer starten, State speichern, warten bis nächster Run.
            const now = Date.now();
            setFirstSeenAt(state, now);
            await saveState(STATE_FILE, state);
            console.log(
                `[main] Erste Sichtung der Welle — Cooldown ${formatDurationMs(cooldownMs)}` +
                ` startet jetzt. Nächster Run prüft erneut.`
            );
            return;
        }
    }

    if (cooldownMs > 0 && cooldownRef > 0) {
        const elapsed = Date.now() - cooldownRef;
        if (elapsed < cooldownMs) {
            const remaining = cooldownMs - elapsed;
            console.log(
                `[main] Cooldown aktiv: ${formatDurationMs(cooldownMs)} verlangt,` +
                ` ${formatDurationMs(elapsed)} seit ${cooldownRefLabel} —` +
                ` warte noch ${formatDurationMs(remaining)}.`
            );
            return;
        }
        console.log(
            `[main] Cooldown ${formatDurationMs(cooldownMs)} seit ${cooldownRefLabel}` +
            ` abgelaufen → poste.`
        );
    } else {
        console.log('[main] Kein Cooldown (älterer Alarm ist akut → sofort posten).');
    }

    // Tweet-Texte vorbereiten (vollständiges aktives Set, nicht nur die neuen).
    const tweets = buildTweets(active);
    if (!tweets) {
        console.log('[main] buildTweets() gab null zurück — überspringe.');
        return;
    }
    for (const lang of LANGS) {
        if (tweets[lang]) {
            console.log(`\n[tweet:${lang}] (${tweets[lang].length} Zeichen)\n${tweets[lang]}\n`);
        }
    }

    // Screenshot.
    const { jpeg, error: shotError } = await takeScreenshot('warning');
    if (shotError && !DRY_RUN) {
        console.error('[main] Warnung: ohne Bild kein Post → abbrechen.');
        return;
    }

    if (DRY_RUN) {
        markPosted(state, active, 'warning');
        await saveState(STATE_FILE, state);
        console.log('[main] DRY_RUN: State aktualisiert. Keine Tweets gesendet.');
        return;
    }

    const results = await postAllLangs(tweets, jpeg);
    const anySuccess = Object.values(results).some(r => r.ok);
    if (anySuccess) {
        markPosted(state, active, 'warning');
        recordTweets(state, results, 'warning', computeDeleteAfter(active));
        await saveState(STATE_FILE, state);
        console.log('[main] State persistiert.');
    } else {
        console.error('[main] Kein Tweet erfolgreich → State NICHT aktualisiert (retry beim nächsten Run).');
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error('[main] Fataler Fehler:', err);
    process.exit(1);
});
