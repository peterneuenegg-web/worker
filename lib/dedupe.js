/**
 * De-Dup-State-Management — verhindert doppelte Tweets für dieselbe Warnung.
 *
 * Regel (aus User-Spezifikation):
 *   "Re-Post nur bei neuer alarm.id" — eine bereits gepostete ID wird nicht
 *   nochmal angefasst, auch wenn sich Stufe ändert.
 *
 * State-File: state/posted.json — wird committed.
 *   { "<alarmId>": <unixTimestamp>, ... }
 *
 * Cleanup: Einträge älter als STATE_TTL_DAYS werden bei jedem Run geputzt,
 *          damit die Datei nicht unbegrenzt wächst.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_TTL_DAYS = 14;
const STATE_TTL_MS = STATE_TTL_DAYS * 24 * 60 * 60 * 1000;

export async function loadState(stateFile) {
    try {
        const raw = await fs.readFile(stateFile, 'utf8');
        const data = JSON.parse(raw);
        return (typeof data === 'object' && data !== null) ? data : {};
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        console.warn('[dedupe] Konnte State nicht lesen, beginne leer:', err.message);
        return {};
    }
}

export async function saveState(stateFile, state) {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const purged = purgeExpired(state);
    await fs.writeFile(stateFile, JSON.stringify(purged, null, 2) + '\n', 'utf8');
}

function purgeExpired(state) {
    const cutoff = Date.now() - STATE_TTL_MS;
    const cleaned = {};
    for (const [id, ts] of Object.entries(state)) {
        if (typeof ts === 'number' && ts >= cutoff) cleaned[id] = ts;
    }
    return cleaned;
}

/**
 * Filtert die Liste aktiver Alarme: nur solche zurückgeben, deren ID
 * NICHT bereits im State steht. Diese sind "neu" und triggern den Tweet.
 */
export function findNewAlarms(activeAlarms, state) {
    return activeAlarms.filter(a => {
        const id = String(a.id);
        return id && state[id] === undefined;
    });
}

/**
 * Markiert ALLE aktuell aktiven Alarme als gepostet — auch jene, die schon
 * im State waren (Timestamp wird aktualisiert, damit sie nicht gepurgt werden
 * solange sie aktiv sind).
 */
export function markPosted(state, activeAlarms) {
    const now = Date.now();
    for (const a of activeAlarms) {
        if (a.id != null) state[String(a.id)] = now;
    }
    return state;
}
