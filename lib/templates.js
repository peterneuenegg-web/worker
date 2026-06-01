/**
 * Tweet-Templates für Unwetterwarnungen — DE / FR / IT.
 *
 * Eingabe: Liste aktive Alarme aus der meteo-and-hail.json-API.
 * Ausgabe: { de: '...', fr: '...', it: '...' } — fertige Tweet-Texte je Sprache,
 *          alle unter 280 Zeichen.
 *
 * Bündelungsregel:
 *   Alarme werden nach Typ + Stufe gruppiert; pro Gruppe werden Regionen
 *   komma-separiert aufgelistet. Sortierung absteigend nach Stufe.
 */

// warn_code → Übersetzung pro Sprache
const WARN_LABELS = {
    frost:        { de: 'Frost',     fr: 'Gel',      it: 'Gelo' },
    thunderstorm: { de: 'Gewitter',  fr: 'Orage',    it: 'Temporale' },
    slipperiness: { de: 'Glatteis',  fr: 'Verglas',  it: 'Ghiaccio' },
    rain:         { de: 'Regen',     fr: 'Pluie',    it: 'Pioggia' },
    snow:         { de: 'Schnee',    fr: 'Neige',    it: 'Neve' },
    wind:         { de: 'Sturm',     fr: 'Tempête',  it: 'Tempesta' },
    hail:         { de: 'Hagel',     fr: 'Grêle',    it: 'Grandine' }
};

// Die offizielle Skala kennt drei Stufen (Mappings aus dem Unwetterkarte-Widget).
// Stufe 1 erscheint NICHT im Tweet (siehe MIN_LEVEL_FOR_TWEET) — wird trotzdem
// auf der Karte als gelbe Fläche dargestellt.
const LEVEL_LABELS = {
    1: { de: 'Mässige Gefahr',    fr: 'Danger modéré',  it: 'Pericolo moderato' },
    2: { de: 'Erhebliche Gefahr', fr: 'Danger marqué',  it: 'Pericolo marcato' },
    3: { de: 'Grosse Gefahr',     fr: 'Grand danger',   it: 'Grande pericolo' }
};

// Emoji pro Stufe — im Tweet erscheinen nur 2 und 3.
const LEVEL_EMOJI = {
    1: '🟡',
    2: '🟠',
    3: '🔴'
};

// Sprach-Header (sprachneutral was Anzahl betrifft — die "2 Warnungen Schweiz"-
// Schreibweise ist irreführend, da dieselbe Wetterlage in vielen Regionen als
// separater Alarm zählt). Pro Sprache gibt's zwei Varianten:
//   normal     — Standard-Lage
//   nationwide — >70% der Schweiz betroffen (Stufe-3-Modus)
const HEADER = {
    de: { normal: '⚠️ Unwetterwarnungen Schweiz',  nationwide: '⚠️ Schweizweite Unwetterlage' },
    fr: { normal: '⚠️ Alertes météo Suisse',       nationwide: '⚠️ Situation météo nationale' },
    it: { normal: '⚠️ Avvisi meteo Svizzera',      nationwide: '⚠️ Situazione meteo nazionale' }
};

// Footer-Variante A1: Hinweis "Updates folgen" wird IMMER mitgegeben, weil der Bot
// alle 5 Min nachsieht und bei neuen/wegfallenden Alarmen erneut postet.
const FOOTER = {
    de: 'ℹ️ Updates folgen\n🔗 wetteralarm.ch/unwetterwarnungen.html',
    fr: 'ℹ️ Mises à jour à suivre\n🔗 alarmemeteo.ch/alerte-intemperies.html',
    it: 'ℹ️ Aggiornamenti a seguire\n🔗 allarmemeteo.ch/avvisi-di-maltempo.html'
};

// Entwarnungs-Tweet — gepostet wenn ALLE Alarme (auch Stufe 1) weg sind und
// der letzte Post ein Warnungs-Post war (siehe lib/dedupe.js _lastPostType).
const CLEAR_TEXT = {
    de: '✅ Entwarnung – alle Unwetterwarnungen aufgehoben\n\n🔗 wetteralarm.ch/unwetterwarnungen.html',
    fr: '✅ Fin d\'alerte – toutes les alertes météo levées\n\n🔗 alarmemeteo.ch/alerte-intemperies.html',
    it: '✅ Fine allerta – tutti gli avvisi meteo revocati\n\n🔗 allarmemeteo.ch/avvisi-di-maltempo.html'
};

const MIN_LEVEL_FOR_TWEET = 2; // Stufe 1 (Mässig) wird im Tweet ignoriert
const TWEET_MAX_LENGTH = 280;

// Warn-Codes, die der Bot ignoriert. 'hail' kommt aus einer separaten Pipeline
// (wetteralarm-hail-fetcher) und soll hier nicht behandelt werden — sonst
// hätten wir Doppel-Posts.
const EXCLUDED_WARN_CODES = new Set(['hail']);

// === Vorinformations-Post ===
// Wenn morgen breitflächig Stufe-1-Gewitter erwartet werden, soll der Bot eine
// Vorinformation rausgeben — die Lage kann sich später noch verschärfen (auf 2/3
// heraufgestuft werden) und Followers sind so schon vorgewarnt.
// Aktuell nur Gewitter — andere warn_codes könnten später ergänzt werden.
const PREINFO_WARN_CODES   = new Set(['thunderstorm']);
const PREINFO_LEVEL        = 1;        // Stufe-1-Vorwarnung als Trigger
const PREINFO_RATIO        = 0.60;     // >60% der 172 Schweizer Warnregionen
const PREINFO_MIN_LEAD_MS  = 12 * 60 * 60 * 1000; // ≥12 h Vorlauf

const PREINFO_HEADER = {
    de: '🌩️ Gewitter-Vorinformation Schweiz',
    fr: '🌩️ Pré-information orages Suisse',
    it: '🌩️ Preinformazione temporali Svizzera'
};

const PREINFO_MIDDLE = {
    de: (when, count, ratio) => `${when} werden verbreitet Gewitter erwartet — ${ratio}% der Schweiz betroffen (${count} Warnregionen).`,
    fr: (when, count, ratio) => `${when} des orages sont attendus sur de larges parties du pays — ${ratio}% de la Suisse concernée (${count} régions d'alerte).`,
    it: (when, count, ratio) => `${when} sono attesi temporali su vaste zone — ${ratio}% della Svizzera coinvolta (${count} regioni di allerta).`
};

const PREINFO_TAIL = {
    de: 'Die Lage kann sich kurzfristig verschärfen.',
    fr: 'La situation peut s\'aggraver à court terme.',
    it: 'La situazione può aggravarsi a breve termine.'
};

// "morgen" / "demain" / "domani" — alles andere als Datum ausschreiben.
const PREINFO_TOMORROW_LABEL = { de: 'Morgen', fr: 'Demain', it: 'Domani' };
const LOCALES = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH' };

// Schwellenwerte für die drei Detail-Modi:
const TOTAL_REGIONS = 172;                  // aus meteo.geojson (Stand 2026)
const NATIONWIDE_THRESHOLD = 0.7;           // >70% der Regionen → Stufe 3
const DETAILED_MAX_GROUPS = 3;              // mehr Gruppen → Stufe 2
const DETAILED_MAX_REGIONS_PER_GROUP = 4;   // mehr Regionen in einer Gruppe → Stufe 2

// "N Warnung(en)" / "N alerte(s)" / "N avviso/i" — für Compact-/Nationwide-Modus,
// wo wir Alarme zählen (nicht Regionen). Eine Region mit 3 Sturm-Warnungen von
// 3 Versicherungs-Quellen zählt also 3×.
const ALARM_PHRASE = {
    de: n => `${n} ${n === 1 ? 'Warnung' : 'Warnungen'}`,
    fr: n => `${n} ${n === 1 ? 'alerte' : 'alertes'}`,
    it: n => `${n} ${n === 1 ? 'avviso' : 'avvisi'}`
};

// "+N weitere" für Stufe-1-Regions-Trimmer
const MORE_REGIONS_PHRASE = {
    de: n => `+${n} weitere`,
    fr: n => `+${n} autres`,
    it: n => `+${n} altre`
};
const STUFE1_REGIONS_PER_LINE = 3;          // ab 4 Regionen wird "+N weitere" verwendet

// ===========================================
// Hilfsfunktionen
// ===========================================

function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * Formatiert Gültigkeitszeitraum: "13.05. 10:00 – 17.05. 14:00"
 * Wenn from und to am gleichen Tag: "13.05. 10:00 – 18:00"
 */
function formatValidityRange(fromIso, toIso) {
    const from = new Date(fromIso);
    const to   = new Date(toIso);
    const fromStr = `${pad2(from.getDate())}.${pad2(from.getMonth() + 1)}. ${pad2(from.getHours())}:${pad2(from.getMinutes())}`;
    const sameDay = from.getFullYear() === to.getFullYear()
                 && from.getMonth() === to.getMonth()
                 && from.getDate() === to.getDate();
    const toStr = sameDay
        ? `${pad2(to.getHours())}:${pad2(to.getMinutes())}`
        : `${pad2(to.getDate())}.${pad2(to.getMonth() + 1)}. ${pad2(to.getHours())}:${pad2(to.getMinutes())}`;
    return `${fromStr} – ${toStr}`;
}

function regionName(alarm, lang) {
    return (alarm.region && alarm.region[lang] && alarm.region[lang].name)
        || (alarm.region && alarm.region.de && alarm.region.de.name)
        || 'Schweiz';
}

// ===========================================
// Gruppierung
// ===========================================

/**
 * Gruppiert Alarme nach (warn_code + priority), sammelt pro Gruppe die Regionen
 * und den Zeitraum (min valid_from – max valid_to).
 * Rückgabe ist absteigend nach priority sortiert.
 */
function groupAlarms(alarms, lang) {
    const groups = {};
    for (const a of alarms) {
        const lvl = Number(a.priority) || 0;
        if (lvl < MIN_LEVEL_FOR_TWEET) continue;
        const code = a.warn_code || 'thunderstorm';
        const key = `${code}-${lvl}`;
        if (!groups[key]) {
            groups[key] = {
                code, level: lvl,
                regions: new Set(),  // für detailed-Mode (Region-Namen)
                alarmCount: 0,        // für compact-/nationwide-Mode (jeder Alarm zählt)
                from: new Date(a.valid_from).getTime(),
                to:   new Date(a.valid_to).getTime()
            };
        }
        groups[key].regions.add(regionName(a, lang));
        groups[key].alarmCount += 1;
        const aFrom = new Date(a.valid_from).getTime();
        const aTo   = new Date(a.valid_to).getTime();
        if (aFrom < groups[key].from) groups[key].from = aFrom;
        if (aTo   > groups[key].to)   groups[key].to   = aTo;
    }
    return Object.values(groups).sort((a, b) => b.level - a.level);
}

// ===========================================
// Modus-Wahl
// ===========================================

/**
 * Zählt eindeutige Regionen über alle Gruppen.
 * (Eine Region kann in mehreren Gruppen vorkommen, wenn dort verschiedene
 *  Warn-Typen aktiv sind — wir zählen sie einmal.)
 */
function countUniqueRegions(groups) {
    const set = new Set();
    for (const g of groups) for (const r of g.regions) set.add(r);
    return set.size;
}

function selectMode(groups) {
    const affected = countUniqueRegions(groups);
    if (affected / TOTAL_REGIONS > NATIONWIDE_THRESHOLD) return 'nationwide';
    const maxRegionsInAnyGroup = Math.max(0, ...groups.map(g => g.regions.size));
    if (groups.length > DETAILED_MAX_GROUPS || maxRegionsInAnyGroup > DETAILED_MAX_REGIONS_PER_GROUP) {
        return 'compact';
    }
    return 'detailed';
}

// ===========================================
// Stufe 1 — detailliert: pro Gruppe eine Zeile mit Region-Namen
// ===========================================

function buildDetailedLine(group, lang) {
    const emoji = LEVEL_EMOJI[group.level] || '🟠';
    const type  = (WARN_LABELS[group.code] && WARN_LABELS[group.code][lang]) || group.code;
    const level = (LEVEL_LABELS[group.level] && LEVEL_LABELS[group.level][lang]) || '';
    const allRegions = Array.from(group.regions);
    // Bei >3 Regionen pro Gruppe: erste 2 + "+N weitere"
    let regions;
    if (allRegions.length <= STUFE1_REGIONS_PER_LINE) {
        regions = allRegions.join(', ');
    } else {
        const head = allRegions.slice(0, 2).join(', ');
        const more = MORE_REGIONS_PHRASE[lang](allRegions.length - 2);
        regions = `${head}, ${more}`;
    }
    const time = formatValidityRange(group.from, group.to);
    return `${emoji} ${type} – ${level} – ${regions} (${time})`;
}

// ===========================================
// Stufe 2 — kompakt: pro Warnstufe eine Zeile, Typen mit Anzahl Regionen
// ===========================================

function buildCompactLines(groups, lang) {
    // Pro Level alle Gruppen sammeln, nach Alarm-Anzahl absteigend sortieren.
    // Zähler ist die Anzahl Alarme (g.alarmCount), nicht eindeutige Regionen —
    // eine Region mit 3 Sturm-Warnungen zählt also 3× mit.
    const byLevel = {};
    for (const g of groups) {
        if (!byLevel[g.level]) byLevel[g.level] = [];
        byLevel[g.level].push(g);
    }
    const levels = Object.keys(byLevel).map(Number).sort((a, b) => b - a);
    return levels.map(lvl => {
        const emoji = LEVEL_EMOJI[lvl] || '🟠';
        const levelText = (LEVEL_LABELS[lvl] && LEVEL_LABELS[lvl][lang]) || '';
        const items = byLevel[lvl]
            .slice()
            .sort((a, b) => b.alarmCount - a.alarmCount)
            .map(g => {
                const type = (WARN_LABELS[g.code] && WARN_LABELS[g.code][lang]) || g.code;
                return `${type} (${g.alarmCount})`;
            })
            .join(', ');
        return `${emoji} ${levelText}: ${items}`;
    });
}

// ===========================================
// Stufe 3 — nationwide: pro Warnstufe nur Region-Anzahl, kein Detail
// ===========================================

function buildNationwideLines(groups, lang) {
    // Pro Level Alarm-Anzahl aufsummieren (Alarme, nicht eindeutige Regionen —
    // analog zum compact-Mode).
    const alarmsPerLevel = {};
    for (const g of groups) {
        alarmsPerLevel[g.level] = (alarmsPerLevel[g.level] || 0) + g.alarmCount;
    }
    const levels = Object.keys(alarmsPerLevel).map(Number).sort((a, b) => b - a);
    return levels.map(lvl => {
        const emoji = LEVEL_EMOJI[lvl] || '🟠';
        const levelText = (LEVEL_LABELS[lvl] && LEVEL_LABELS[lvl][lang]) || '';
        return `${emoji} ${levelText}: ${ALARM_PHRASE[lang](alarmsPerLevel[lvl])}`;
    });
}

// ===========================================
// Tweet-Builder mit Length-Trimmer + Mode-Wahl
// ===========================================

function buildTweet(groups, lang) {
    const mode = selectMode(groups);
    const header = mode === 'nationwide' ? HEADER[lang].nationwide : HEADER[lang].normal;
    const footer = FOOTER[lang];

    let lines;
    if (mode === 'detailed')        lines = groups.map(g => buildDetailedLine(g, lang));
    else if (mode === 'compact')    lines = buildCompactLines(groups, lang);
    else /* nationwide */           lines = buildNationwideLines(groups, lang);

    function assemble(visible, hiddenCount) {
        const moreLabel = { de: 'weitere', fr: 'autres', it: 'altri' }[lang];
        const linesPart = visible.slice();
        if (hiddenCount > 0) linesPart.push(`… +${hiddenCount} ${moreLabel}`);
        return `${header}\n\n${linesPart.join('\n')}\n\n${footer}`;
    }

    // Falls trotz Mode-Wahl noch zu lang (z.B. Stufe-2 mit sehr vielen Typen):
    // Zeilen schrittweise abschneiden bis 280 Zeichen erreicht.
    let visible = lines.slice();
    let hidden = 0;
    let text = assemble(visible, hidden);
    while (text.length > TWEET_MAX_LENGTH && visible.length > 0) {
        visible = visible.slice(0, -1);
        hidden++;
        text = assemble(visible, hidden);
    }
    return text;
}

// ===========================================
// Public API
// ===========================================

/**
 * Filtert relevante Alarme: noch nicht abgelaufen (now <= valid_to), Stufe >=
 * MIN_LEVEL_FOR_TWEET, kein ausgeschlossener Warn-Code. Vorlauf-Alarme
 * (valid_from in der Zukunft) werden bewusst mit einbezogen — die Cooldown-
 * Logik in post.js entscheidet anhand der Lead-Time, ob jetzt gepostet wird
 * oder noch gewartet wird, um zusammenhängende Alarme zu bündeln.
 */
export function filterActiveAlarms(alarms, now = new Date()) {
    return (alarms || []).filter(a => {
        const lvl = Number(a.priority) || 0;
        if (lvl < MIN_LEVEL_FOR_TWEET) return false;
        if (EXCLUDED_WARN_CODES.has(a.warn_code)) return false;
        const to = new Date(a.valid_to);
        return now <= to;
    });
}

/**
 * Erzeugt Tweet-Texte für alle drei Sprachen.
 * Der Header passt sich automatisch an die Lage an:
 *   detailed   — wenige Gruppen, wenige Regionen → Region-Namen ausgeschrieben
 *   compact    — mehrere Gruppen ODER >4 Regionen pro Gruppe → Typ (Anzahl)
 *   nationwide — >70% der Schweiz betroffen → nur Stufe + Region-Anzahl
 */
export function buildTweets(alarms) {
    const active = filterActiveAlarms(alarms);
    if (active.length === 0) return null; // → nichts zu tweeten

    const result = {};
    for (const lang of ['de', 'fr', 'it']) {
        const groups = groupAlarms(active, lang);
        if (groups.length === 0) {
            result[lang] = null;
            continue;
        }
        result[lang] = buildTweet(groups, lang);
    }
    return result;
}

/**
 * Prüft, ob IRGENDEIN Alarm noch relevant ist (alle Stufen, also auch Stufe 1
 * — aber ohne ausgeschlossene Warn-Codes wie 'hail'). Relevant = noch nicht
 * abgelaufen; Vorlauf-Alarme zählen mit, damit keine Entwarnung gepostet wird,
 * solange schon die nächste Welle in der Pipeline steht.
 */
export function hasAnyActiveAlarmAllLevels(alarms, now = new Date()) {
    return (alarms || []).some(a => {
        if (EXCLUDED_WARN_CODES.has(a.warn_code)) return false;
        const to = new Date(a.valid_to);
        return now <= to;
    });
}

/**
 * Erzeugt Entwarnungs-Tweet-Texte für alle drei Sprachen.
 * Wird vom Worker zusammen mit dem aktuellen (leeren) Karten-Screenshot gepostet.
 */
export function buildClearTweets() {
    return {
        de: CLEAR_TEXT.de,
        fr: CLEAR_TEXT.fr,
        it: CLEAR_TEXT.it
    };
}

// ===========================================
// Vorinformations-Post (Pre-Info)
// ===========================================

function tomorrowUtcDateString(now = new Date()) {
    const t = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return t.toISOString().slice(0, 10);
}

/**
 * Prüft, ob eine Vorinformation gepostet werden soll.
 *
 * Bedingungen (ALLE müssen erfüllt sein):
 *   1. Es gibt Alarme mit warn_code aus PREINFO_WARN_CODES (Default: nur Gewitter)
 *      und priority === PREINFO_LEVEL (Stufe 1).
 *   2. Diese Alarme decken mindestens PREINFO_RATIO (60%) der TOTAL_REGIONS ab.
 *   3. Der früheste valid_from liegt mindestens PREINFO_MIN_LEAD_MS (12h) in der
 *      Zukunft — sonst macht eine "Vorinformation" keinen Sinn mehr.
 *   4. Für das daraus berechnete target-date (UTC-Datum des frühesten
 *      valid_from) wurde noch keine Vorinformation gepostet
 *      (state._lastPreInfoTargetDate).
 *
 * Rückgabe: { shouldPost: bool, targetDate, regionCount, regionRatio }
 */
export function detectPreInfoCondition(alarms, state = {}, now = new Date()) {
    const candidates = (alarms || []).filter(a => {
        if (!PREINFO_WARN_CODES.has(a.warn_code)) return false;
        if (Number(a.priority) !== PREINFO_LEVEL) return false;
        const from = new Date(a.valid_from);
        const to   = new Date(a.valid_to);
        if (now > to) return false;
        const leadMs = from.getTime() - now.getTime();
        if (leadMs < PREINFO_MIN_LEAD_MS) return false;
        return true;
    });
    if (candidates.length === 0) return { shouldPost: false };

    const uniqueRegions = new Set();
    for (const a of candidates) {
        if (a.region && a.region.srf_id != null) uniqueRegions.add(a.region.srf_id);
    }
    const regionCount = uniqueRegions.size;
    const regionRatio = regionCount / TOTAL_REGIONS;
    if (regionRatio < PREINFO_RATIO) return { shouldPost: false };

    const earliestValidFrom = Math.min(...candidates.map(a => new Date(a.valid_from).getTime()));
    const targetDate = new Date(earliestValidFrom).toISOString().slice(0, 10);

    if (state && state._lastPreInfoTargetDate === targetDate) return { shouldPost: false };

    return {
        shouldPost: true,
        targetDate,
        regionCount,
        regionRatio: Math.round(regionRatio * 100)
    };
}

function formatTargetLabel(targetDate, lang, now = new Date()) {
    if (targetDate === tomorrowUtcDateString(now)) return PREINFO_TOMORROW_LABEL[lang];
    // Sonst: "Donnerstag, 4. Juni" — lokalisiert nach Sprache.
    const d = new Date(targetDate + 'T12:00:00Z'); // 12:00 UTC vermeidet TZ-Datumssprung
    try {
        const str = d.toLocaleDateString(LOCALES[lang], { weekday: 'long', day: 'numeric', month: 'long' });
        // Erstbuchstabe gross (für Satzanfang)
        return str.charAt(0).toUpperCase() + str.slice(1);
    } catch (e) {
        // Fallback: einfach das ISO-Datum
        return targetDate;
    }
}

/**
 * Erzeugt Vorinformations-Tweet-Texte für alle drei Sprachen.
 *
 * Aufrufer: post.js, wenn detectPreInfoCondition().shouldPost === true.
 *
 * Bild: derselbe Karten-Screenshot wie für Warnungen — die Karte zeigt durch
 * den erweiterten Filter (siehe filterActiveAlarms / renderWarnings) bereits
 * alle Vorlauf-Alarme.
 */
export function buildPreInfoTweets({ targetDate, regionCount, regionRatio }, now = new Date()) {
    const result = {};
    for (const lang of ['de', 'fr', 'it']) {
        const when = formatTargetLabel(targetDate, lang, now);
        const middle = PREINFO_MIDDLE[lang](when, regionCount, regionRatio);
        result[lang] = `${PREINFO_HEADER[lang]}\n\n${middle}\n\n${PREINFO_TAIL[lang]}\n\n${FOOTER[lang]}`;
    }
    return result;
}
