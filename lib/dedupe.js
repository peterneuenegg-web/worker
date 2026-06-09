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

// Inhaltlicher Dedup: wenn ein Alarm mit gleichem (region, warn_code, priority)
// innerhalb dieses Fensters schon gepostet wurde, wird ein neuer Alarm mit
// derselben Signatur ignoriert — auch wenn er eine andere alarm.id hat.
//
// Hintergrund: Meteorologen erstellen gelegentlich denselben Alarm doppelt
// (z.B. Update / Re-Publish), wodurch der Bot ihn als "neu" sehen würde.
// 12h deckt typische "derselbe Tag, anderes Bulletin"-Fälle ab; eine echte
// Neulage am nächsten Tag wird wieder gepostet.
const CONTENT_DEDUP_TTL_MS = 12 * 60 * 60 * 1000;

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
//   _lastPostedAt   — Unix-ms letzter Tweet (für Cooldown-Berechnung in post.js)
//   _lastPostType   — 'warning' | 'clear' (für Entwarnungs-Single-Shot-Logik)
//   _firstSeenAt    — Unix-ms Erstsichtung der aktuellen Alarm-Welle (Cooldown-
//                     Timer auch beim allerersten Post). Wird bei markPosted()
//                     oder wenn keine neuen Alarme mehr anstehen, gelöscht.
//   _contentHashes  — { 'srfId|warnCode|priority': ts } — inhaltlicher Dedup.
//                     Verhindert Doppelpost wenn der Meteorologe denselben
//                     Alarm 2× erstellt (z.B. 331033 + 331035 für Liestal/
//                     Rheinfelden mit gleichem warn_code+prio).
function isMetaKey(key) {
    return typeof key === 'string' && key.startsWith('_');
}

/**
 * Inhalts-Hash eines Alarms — (region.srf_id, warn_code, priority).
 * Zwei Alarme mit gleichem Hash gelten als "selbe Lage", auch wenn ihre
 * `alarm.id` unterschiedlich ist.
 */
function contentHash(alarm) {
    const srf  = alarm && alarm.region && alarm.region.srf_id;
    const code = alarm && alarm.warn_code;
    const prio = alarm && alarm.priority;
    if (srf == null || !code || prio == null) return null;
    return `${srf}|${code}|${prio}`;
}

function isContentRecentlyPosted(alarm, state, now = Date.now()) {
    const h = contentHash(alarm);
    if (!h) return false;
    const map = state && state._contentHashes;
    if (!map || typeof map !== 'object') return false;
    const ts = map[h];
    return typeof ts === 'number' && (now - ts) < CONTENT_DEDUP_TTL_MS;
}

function purgeExpired(state) {
    const cutoff = Date.now() - STATE_TTL_MS;
    const cleaned = {};
    for (const [key, value] of Object.entries(state)) {
        if (isMetaKey(key)) {
            cleaned[key] = value; // Meta-Felder grundsätzlich behalten
            continue;
        }
        if (typeof value === 'number' && value >= cutoff) cleaned[key] = value;
    }
    // _postedPreInfoDates ist selbst ein Object { 'YYYY-MM-DD': ts } — innerhalb
    // davon Einträge älter als die TTL trotzdem aufräumen, damit das Set nicht
    // unbegrenzt wächst.
    if (cleaned._postedPreInfoDates && typeof cleaned._postedPreInfoDates === 'object') {
        const kept = {};
        for (const [date, ts] of Object.entries(cleaned._postedPreInfoDates)) {
            if (typeof ts === 'number' && ts >= cutoff) kept[date] = ts;
        }
        cleaned._postedPreInfoDates = kept;
    }
    // _contentHashes — eigenes (kürzeres) TTL: Einträge älter als
    // CONTENT_DEDUP_TTL_MS bringen nichts mehr und werden gelöscht.
    if (cleaned._contentHashes && typeof cleaned._contentHashes === 'object') {
        const contentCutoff = Date.now() - CONTENT_DEDUP_TTL_MS;
        const kept = {};
        for (const [hash, ts] of Object.entries(cleaned._contentHashes)) {
            if (typeof ts === 'number' && ts >= contentCutoff) kept[hash] = ts;
        }
        cleaned._contentHashes = kept;
    }
    return cleaned;
}

/**
 * Filtert die Liste aktiver Alarme: nur "wirklich neue" Alarme zurückgeben.
 * Zwei Stufen Dedup:
 *  1. ID: alarm.id darf nicht schon im State stehen.
 *  2. Inhalt: (region, warn_code, priority) darf in den letzten 12 h nicht
 *     schon mit anderer ID gepostet worden sein. Verhindert Doppelposts wenn
 *     der Meteorologe denselben Alarm 2× erstellt.
 */
export function findNewAlarms(activeAlarms, state) {
    return activeAlarms.filter(a => {
        const id = String(a.id);
        if (!id || state[id] !== undefined) return false;
        if (isContentRecentlyPosted(a, state)) return false;
        return true;
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
    if (!state._contentHashes) state._contentHashes = {};
    for (const a of activeAlarms) {
        if (a.id != null) state[String(a.id)] = now;
        // Inhalts-Hash mitspeichern, damit ein später eintreffender Duplikat
        // (gleiche Region+Code+Stufe, andere ID) erkannt wird.
        const h = contentHash(a);
        if (h) state._contentHashes[h] = now;
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
