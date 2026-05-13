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
 * DRY_RUN=true → keine Tweets, kein Bild-Upload; State trotzdem updaten,
 *                damit Stage-Testläufe nicht jedes Mal als "neu" rendern.
 *
 * Environment-Variablen:
 *   ENV               = 'prod' | 'stage'  (Default: 'prod')
 *   RENDER_BASE_URL   = z.B. https://tool.wetteralarm.ch/x-warnungen
 *   DRY_RUN           = 'true' für Testlauf ohne Posting
 *   X_TOKENS_DE       = JSON-String mit { apiKey, apiSecret, accessToken, accessSecret }
 *   X_TOKENS_FR       = "
 *   X_TOKENS_IT       = "
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { buildTweets, filterActiveAlarms } from './lib/templates.js';
import { loadState, saveState, findNewAlarms, markPosted } from './lib/dedupe.js';
import { captureMap } from './render-screenshot.js';

const ENV = process.env.ENV === 'stage' ? 'stage' : 'prod';
const RENDER_BASE_URL = process.env.RENDER_BASE_URL || 'https://tool.wetteralarm.ch/x-warnungen';
const DRY_RUN = process.env.DRY_RUN === 'true';

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
// Main
// ===========================================

async function main() {
    console.log(`[main] Start — ENV=${ENV} DRY_RUN=${DRY_RUN}`);

    const alarms = await fetchAlarms();
    const active = filterActiveAlarms(alarms);
    console.log(`[main] ${active.length} aktive Alarme (Stufe >= 2) von insgesamt ${alarms.length}`);

    if (active.length === 0) {
        console.log('[main] Keine aktiven Warnungen → kein Post nötig.');
        return;
    }

    const state = await loadState(STATE_FILE);
    const newOnes = findNewAlarms(active, state);
    console.log(`[main] ${newOnes.length} davon sind NEU (nicht im posted.json)`);

    if (newOnes.length === 0) {
        console.log('[main] Keine neuen Alarm-IDs → kein Post.');
        return;
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

    // Screenshot bauen.
    const renderUrl = `${RENDER_BASE_URL}/render.html?env=${ENV}`;
    const { jpeg, error: shotError } = await captureMap(renderUrl);
    if (shotError) {
        console.error('[main] Screenshot fehlgeschlagen:', shotError);
        if (!DRY_RUN) {
            // Im Live-Modus: ohne Bild keinen Tweet schicken.
            return;
        }
    }

    if (DRY_RUN) {
        if (jpeg) {
            // Bild als Artifact für den Workflow speichern.
            const dbgPath = path.join(process.cwd(), 'state', `dry-run-${Date.now()}.jpg`);
            await fs.writeFile(dbgPath, jpeg);
            console.log(`[main] DRY_RUN: Bild abgelegt unter ${dbgPath}`);
        }
        // State updaten, damit beim nächsten Dry-Run nicht alles als "neu" erscheint.
        markPosted(state, active);
        await saveState(STATE_FILE, state);
        console.log('[main] DRY_RUN: State aktualisiert. Keine Tweets gesendet.');
        return;
    }

    // Live-Posting auf allen drei Accounts.
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

    // Nur wenn mindestens ein Tweet erfolgreich gepostet wurde, State aktualisieren.
    const anySuccess = Object.values(results).some(r => r.ok);
    if (anySuccess) {
        markPosted(state, active);
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
