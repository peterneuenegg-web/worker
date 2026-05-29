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

// Meta-Felder (Underscore-Prefix) werden NIE als Alarm-ID interpretiert und
// NIE durch die TTL-Purge entfernt. Aktuell:
//   _lastPostedAt — Unix-ms letzter Tweet (für Cooldown-Berechnung in post.js)
//   _lastPostType — 'warning' | 'clear' (für Entwarnungs-Single-Shot-Logik)
//   _firstSeenAt  — Unix-ms Erstsichtung der aktuellen Alarm-Welle.
//                   Wird genutzt, damit der Cooldown auch beim allerersten Post
//                   greift, wenn ein Alarm genügend Vorlauf hat (kein
//                   _lastPostedAt vorhanden → falle auf _firstSeenAt zurück).
//                   Wird bei markPosted() oder wenn keine neuen Alarme mehr
//                   anstehen, gelöscht.
function isMetaKey(key) {
    return typeof key === 'string' && key.startsWith('_');
}

function purgeExpired(state) {
    const cutoff = Date.now() - STATE_TTL_MS;
    const cleaned = {};
    for (const [key, value] of Object.entries(state)) {
        if (isMetaKey(key)) {
            cleaned[key] = value; // Meta-Felder immer behalten
            continue;
        }
        if (typeof value === 'number' && value >= cutoff) cleaned[key] = value;
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
 *
 * postType = 'warning' (Standard) oder 'clear' (Entwarnung). Wird im State
 * als _lastPostType vermerkt, damit der nächste Run weiss, ob bereits eine
 * Entwarnung gepostet wurde (verhindert Endlos-Entwarnungs-Posts).
 */
export function markPosted(state, activeAlarms, postType = 'warning') {
    const now = Date.now();
    for (const a of activeAlarms) {
        if (a.id != null) state[String(a.id)] = now;
    }
    state._lastPostedAt = now;
    state._lastPostType = postType;
    // Mit dem Post ist die aktuelle Welle "verarbeitet" — der Cooldown läuft
    // ab jetzt von _lastPostedAt, also _firstSeenAt nicht mehr nötig.
    delete state._firstSeenAt;
    return state;
}

export function getLastPostedAt(state) {
    return (state && typeof state._lastPostedAt === 'number') ? state._lastPostedAt : 0;
}

export function getLastPostType(state) {
    return (state && typeof state._lastPostType === 'string') ? state._lastPostType : null;
}

export function getFirstSeenAt(state) {
    return (state && typeof state._firstSeenAt === 'number') ? state._firstSeenAt : 0;
}

export function setFirstSeenAt(state, ts) {
    state._firstSeenAt = ts;
    return state;
}

export function clearFirstSeenAt(state) {
    delete state._firstSeenAt;
    return state;
}
