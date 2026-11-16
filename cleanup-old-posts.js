/**
 * Einmal-Script: Alt-Posts dieses Bots auf X aufräumen.
 *
 * Hintergrund: Vor Einführung des Tweet-Registers (state._tweets) wurden die
 * Tweet-IDs nicht gespeichert — post.js kann diese Posts nicht selbst löschen.
 * Dieses Script liest die Timeline jedes Accounts, erkennt Bot-Posts anhand
 * der festen Kopfzeilen aus lib/templates.js und:
 *
 *   - löscht Bot-Posts, die älter als TWEET_RETENTION_DAYS sind,
 *   - trägt jüngere Bot-Posts ins Register ein (deleteAfter = created_at +
 *     TWEET_RETENTION_DAYS), damit post.js sie später regulär löscht,
 *   - lässt alles andere (manuelle Posts des Accounts) unangetastet.
 *
 * Nur Posts, deren Text mit einer bekannten Bot-Kopfzeile beginnt, werden
 * überhaupt angefasst. Für Alt-Posts ist das Gültigkeitsende der Alarme nicht
 * mehr bekannt → als Näherung gilt der Post-Zeitpunkt.
 *
 * Sicherheitsnetz: DRY_RUN ist hier standardmässig AN. Erst mit DRY_RUN=false
 * wird wirklich gelöscht.
 *
 * Environment-Variablen:
 *   DRY_RUN              = 'false' zum echten Löschen (Default: 'true')
 *   TWEET_RETENTION_DAYS = Aufbewahrung in Tagen (Default: 14)
 *   LANGS                = z.B. 'de,fr' um nur einzelne Accounts zu bearbeiten
 *   X_TOKENS_DE/FR/IT    = wie in post.js
 *
 * Betrieb: Timeline-Reads und Deletes sind auf dem Pay-per-Use-Tier
 * kostenpflichtig. Timeline liefert max. die letzten 3200 Posts je Account.
 */

import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { classifyBotTweetText } from './lib/templates.js';
import { loadState, saveState } from './lib/dedupe.js';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const TWEET_RETENTION_DAYS = Number.parseInt(process.env.TWEET_RETENTION_DAYS || '14', 10);
const TWEET_RETENTION_MS = (Number.isFinite(TWEET_RETENTION_DAYS) && TWEET_RETENTION_DAYS > 0
    ? TWEET_RETENTION_DAYS : 14) * 24 * 60 * 60 * 1000;
const LANGS = (process.env.LANGS || 'de,fr,it').split(',').map(s => s.trim()).filter(Boolean);
const STATE_FILE = path.join(process.cwd(), 'state', 'posted.json');

function loadTwitterClient(lang) {
    const envName = `X_TOKENS_${lang.toUpperCase()}`;
    const raw = process.env[envName];
    if (!raw) {
        console.warn(`[cleanup] ${envName} nicht gesetzt — überspringe ${lang}`);
        return null;
    }
    let tokens;
    try {
        tokens = JSON.parse(raw);
    } catch (e) {
        console.error(`[cleanup] ${envName} ist kein gültiges JSON:`, e.message);
        return null;
    }
    const { apiKey, apiSecret, accessToken, accessSecret } = tokens;
    if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
        console.error(`[cleanup] ${envName} unvollständig.`);
        return null;
    }
    return new TwitterApi({ appKey: apiKey, appSecret: apiSecret, accessToken, accessSecret });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Löscht einen Tweet; bei 429 wird bis zum Rate-Limit-Reset gewartet und
 * einmal erneut versucht. 404 gilt als "schon weg".
 */
async function deleteWithRetry(client, id) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await client.v2.deleteTweet(id);
            return 'deleted';
        } catch (e) {
            if (e && e.code === 404) return 'gone';
            if (e && e.code === 429 && attempt === 0) {
                const resetMs = e.rateLimit && e.rateLimit.reset
                    ? e.rateLimit.reset * 1000 - Date.now() + 2000
                    : 15 * 60 * 1000;
                const waitMs = Math.min(Math.max(resetMs, 5000), 16 * 60 * 1000);
                console.log(`[cleanup] Rate-Limit — warte ${Math.round(waitMs / 1000)} s …`);
                await sleep(waitMs);
                continue;
            }
            throw e;
        }
    }
    return 'failed';
}

async function processLang(lang, state, now) {
    const client = loadTwitterClient(lang);
    if (!client) return;

    const me = await client.v2.me();
    const userId = me.data.id;
    console.log(`\n[cleanup:${lang}] Account @${me.data.username} (${userId})`);

    const known = new Set((state._tweets || []).map(t => String(t.id)));
    const stats = { scanned: 0, foreign: 0, deleted: 0, gone: 0, imported: 0, alreadyKnown: 0, failed: 0 };

    const timeline = await client.v2.userTimeline(userId, {
        max_results: 100,
        exclude: ['retweets', 'replies'],
        'tweet.fields': ['created_at', 'text']
    });

    for await (const tweet of timeline) {
        stats.scanned++;
        const type = classifyBotTweetText(tweet.text, lang);
        if (!type) {
            // Kein Bot-Post → wird nie angefasst. Im Dry-Run sichtbar auflisten,
            // damit man vor dem Scharfschalten sieht, was stehen bleibt.
            stats.foreign++;
            if (DRY_RUN) {
                const firstLine = (tweet.text || '').split('\n')[0].slice(0, 80);
                console.log(`[cleanup:${lang}]   belassen (fremd): ${tweet.id} "${firstLine}"`);
            }
            continue;
        }
        const createdAt = new Date(tweet.created_at).getTime();
        const firstLine = tweet.text.split('\n')[0];
        const ageDays = Math.round((now - createdAt) / 86400000);
        const deleteAfter = createdAt + TWEET_RETENTION_MS;

        if (deleteAfter > now) {
            // Noch innerhalb der Aufbewahrung → ins Register, post.js löscht später.
            if (known.has(String(tweet.id))) {
                stats.alreadyKnown++;
                continue;
            }
            console.log(`[cleanup:${lang}] → Register: ${tweet.id} (${type}, ${ageDays} d) "${firstLine}"`);
            if (!DRY_RUN) {
                if (!Array.isArray(state._tweets)) state._tweets = [];
                state._tweets.push({ id: String(tweet.id), lang, type, postedAt: createdAt, deleteAfter });
                known.add(String(tweet.id));
            }
            stats.imported++;
            continue;
        }

        if (DRY_RUN) {
            console.log(`[cleanup:${lang}] würde löschen: ${tweet.id} (${type}, ${ageDays} d) "${firstLine}"`);
            stats.deleted++;
            continue;
        }
        try {
            const result = await deleteWithRetry(client, tweet.id);
            if (result === 'deleted') {
                stats.deleted++;
                console.log(`[cleanup:${lang}] ✓ gelöscht: ${tweet.id} (${type}, ${ageDays} d) "${firstLine}"`);
            } else if (result === 'gone') {
                stats.gone++;
            } else {
                stats.failed++;
            }
            // Falls der Tweet (z.B. durch einen früheren Teil-Lauf) doch im
            // Register steht: dort ebenfalls entfernen.
            if (result !== 'failed' && known.has(String(tweet.id))) {
                state._tweets = state._tweets.filter(t => String(t.id) !== String(tweet.id));
            }
        } catch (e) {
            stats.failed++;
            console.error(`[cleanup:${lang}] ✗ ${tweet.id}:`, e.data || e.message || e);
        }
    }

    console.log(
        `[cleanup:${lang}] Timeline ${stats.scanned} Posts — fremd ${stats.foreign},` +
        ` ${DRY_RUN ? 'zu löschen' : 'gelöscht'} ${stats.deleted}, schon weg ${stats.gone},` +
        ` ins Register ${stats.imported} (bekannt ${stats.alreadyKnown}), Fehler ${stats.failed}`
    );
}

async function main() {
    console.log(`[cleanup] Start — DRY_RUN=${DRY_RUN} Aufbewahrung=${TWEET_RETENTION_DAYS} d Accounts=${LANGS.join(',')}`);
    const now = Date.now();
    const state = await loadState(STATE_FILE);

    for (const lang of LANGS) {
        try {
            await processLang(lang, state, now);
        } catch (e) {
            console.error(`[cleanup:${lang}] Abbruch für diesen Account:`, e.data || e.message || e);
            process.exitCode = 1;
        }
    }

    if (!DRY_RUN) {
        await saveState(STATE_FILE, state);
        console.log('[cleanup] State persistiert.');
    } else {
        console.log('[cleanup] DRY_RUN — nichts gelöscht, State unverändert. Mit DRY_RUN=false scharf schalten.');
    }
}

main().catch(err => {
    console.error('[cleanup] Fataler Fehler:', err);
    process.exit(1);
});
