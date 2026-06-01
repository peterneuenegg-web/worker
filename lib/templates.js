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

const PREINFO_MAIN = {
    de: (when, count) => `${when} werden verbreitet Gewitter erwartet — grosse Gebiete der Schweiz betroffen (${count} Warnregionen).`,
    fr: (when, count) => `${when} des orages sont attendus sur de larges parties de la Suisse (${count} régions d'alerte).`,
    it: (when, count) => `${when} sono attesi temporali su vaste aree della Svizzera (${count} regioni di allerta).`
};

// Zusatz-Zeile, wenn schon vor dem Hauptereignis erste Alarme aktiv sind
// (z.B. Tessin-Front heute Abend, Hauptlage morgen). Die API liefert die
// betroffenen Kantone als 2-Buchstaben-Codes (TI, GR, …), die wir hier in
// lesbare Namen pro Sprache übersetzen.
const PREINFO_EARLY = {
    de: (earlyDay, time, cantons) => `Erste Zellen bereits ${earlyDay} ab ${time} Uhr: ${cantons}.`,
    fr: (earlyDay, time, cantons) => `Premières cellules dès ${earlyDay} ${time} : ${cantons}.`,
    it: (earlyDay, time, cantons) => `Prime celle già ${earlyDay} dalle ${time}: ${cantons}.`
};

const PREINFO_TAIL = {
    de: 'Die Lage kann sich kurzfristig verschärfen.',
    fr: 'La situation peut s\'aggraver à court terme.',
    it: 'La situazione può aggravarsi a breve termine.'
};

// Kantons-Namen pro Sprache (BFS-Kantonscodes als Schlüssel).
const CANTON_NAMES = {
    AG: { de: 'Aargau',                   fr: 'Argovie',                       it: 'Argovia' },
    AI: { de: 'Appenzell Innerrhoden',    fr: 'Appenzell Rhodes-Intérieures',  it: 'Appenzello Interno' },
    AR: { de: 'Appenzell Ausserrhoden',   fr: 'Appenzell Rhodes-Extérieures',  it: 'Appenzello Esterno' },
    BE: { de: 'Bern',                     fr: 'Berne',                         it: 'Berna' },
    BL: { de: 'Basel-Landschaft',         fr: 'Bâle-Campagne',                 it: 'Basilea Campagna' },
    BS: { de: 'Basel-Stadt',              fr: 'Bâle-Ville',                    it: 'Basilea Città' },
    FR: { de: 'Freiburg',                 fr: 'Fribourg',                      it: 'Friburgo' },
    GE: { de: 'Genf',                     fr: 'Genève',                        it: 'Ginevra' },
    GL: { de: 'Glarus',                   fr: 'Glaris',                        it: 'Glarona' },
    GR: { de: 'Graubünden',               fr: 'Grisons',                       it: 'Grigioni' },
    JU: { de: 'Jura',                     fr: 'Jura',                          it: 'Giura' },
    LU: { de: 'Luzern',                   fr: 'Lucerne',                       it: 'Lucerna' },
    NE: { de: 'Neuenburg',                fr: 'Neuchâtel',                     it: 'Neuchâtel' },
    NW: { de: 'Nidwalden',                fr: 'Nidwald',                       it: 'Nidvaldo' },
    OW: { de: 'Obwalden',                 fr: 'Obwald',                        it: 'Obvaldo' },
    SG: { de: 'St. Gallen',               fr: 'Saint-Gall',                    it: 'San Gallo' },
    SH: { de: 'Schaffhausen',             fr: 'Schaffhouse',                   it: 'Sciaffusa' },
    SO: { de: 'Solothurn',                fr: 'Soleure',                       it: 'Soletta' },
    SZ: { de: 'Schwyz',                   fr: 'Schwytz',                       it: 'Svitto' },
    TG: { de: 'Thurgau',                  fr: 'Thurgovie',                     it: 'Turgovia' },
    TI: { de: 'Tessin',                   fr: 'Tessin',                        it: 'Ticino' },
    UR: { de: 'Uri',                      fr: 'Uri',                           it: 'Uri' },
    VD: { de: 'Waadt',                    fr: 'Vaud',                          it: 'Vaud' },
    VS: { de: 'Wallis',                   fr: 'Valais',                        it: 'Vallese' },
    ZG: { de: 'Zug',                      fr: 'Zoug',                          it: 'Zugo' },
    ZH: { de: 'Zürich',                   fr: 'Zurich',                        it: 'Zurigo' }
};
const CANTONS_LIST_AND = { de: ' und ', fr: ' et ', it: ' e ' };
const CANTONS_MANY = {
    de: 'mehrere Kantone',
    fr: 'plusieurs cantons',
    it: 'più cantoni'
};
const MAX_NAMED_CANTONS = 3;

// Lokalisierung der Zeit-/Datumsangaben für die Vorinformation.
// Bezugspunkt: erster Gewitter-Alarm (frühster valid_from). Tag/Uhrzeit werden
// in Europe/Zurich gerechnet, damit "Heute"/"Morgen" der lokalen Sicht
// entsprechen — auch wenn die API valid_from in UTC liefert.
const SWISS_TZ        = 'Europe/Zurich';
const LOCALES         = { de: 'de-CH', fr: 'fr-CH', it: 'it-CH' };
const RELATIVE_DAY    = {
    de: { today: 'Heute', tomorrow: 'Morgen' },
    fr: { today: 'Aujourd\'hui', tomorrow: 'Demain' },
    it: { today: 'Oggi', tomorrow: 'Domani' }
};
const TIME_CONNECTOR  = { de: 'ab', fr: 'dès', it: 'dalle' };
const TIME_SUFFIX     = { de: ' Uhr', fr: '', it: '' };

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
    // Dedup: gleiche Warnung (srf_id + warn_code + priority) wird in der API
    // oft mehrfach geliefert (pro betroffener Kantonsversicherung) — wir
    // zählen sie nur einmal. Sonst wären die Tweet-Counts höher als die
    // tatsächliche Anzahl Warnungen.
    const seenTriples = new Set();
    for (const a of alarms) {
        const lvl = Number(a.priority) || 0;
        if (lvl < MIN_LEVEL_FOR_TWEET) continue;
        const code = a.warn_code || 'thunderstorm';
        const rid = a.region && a.region.srf_id;
        if (rid == null) continue;
        const dedupKey = rid + '|' + code + '|' + lvl;
        if (seenTriples.has(dedupKey)) continue;
        seenTriples.add(dedupKey);

        const key = `${code}-${lvl}`;
        if (!groups[key]) {
            groups[key] = {
                code, level: lvl,
                regions: new Set(),  // für detailed-Mode (Region-Namen)
                alarmCount: 0,        // für compact-/nationwide-Mode
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

// "YYYY-MM-DD" — Datum in Schweizer Zeit (Europe/Zurich).
function swissDateKey(d) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: SWISS_TZ,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
}

// "HH:MM" — Uhrzeit in Schweizer Zone, 24h-Format.
function swissTimeLabel(d) {
    return new Intl.DateTimeFormat('de-CH', {
        timeZone: SWISS_TZ,
        hour: '2-digit', minute: '2-digit', hour12: false
    }).format(d);
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
    // Schritt 1: Kandidaten = alle Stufe-1-Gewitter, noch nicht abgelaufen.
    // Kein Lead-Filter pro Alarm — sonst würde eine Region, die mit kurzem
    // Lead schon heute beginnt, gar nicht mitgezählt, obwohl sie betroffen ist.
    const candidates = (alarms || []).filter(a => {
        if (!PREINFO_WARN_CODES.has(a.warn_code)) return false;
        if (Number(a.priority) !== PREINFO_LEVEL) return false;
        const to = new Date(a.valid_to);
        return now <= to;
    });
    if (candidates.length === 0) return { shouldPost: false };

    // Schritt 2: Eindeutige Regionen (= "X % der Schweiz betroffen").
    const uniqueRegions = new Set();
    for (const a of candidates) {
        if (a.region && a.region.srf_id != null) uniqueRegions.add(a.region.srf_id);
    }
    const regionCount = uniqueRegions.size;
    const regionRatio = regionCount / TOTAL_REGIONS;
    if (regionRatio < PREINFO_RATIO) return { shouldPost: false };

    // Schritt 3: Lead-Bedingung — die "Hauptlast" der Lage muss noch >= 12 h
    // entfernt sein. Median der valid_from-Zeitpunkte, damit einzelne früh
    // anlaufende Alarme die Vorinformation für die Hauptlage nicht blockieren.
    const validFromTimes = candidates.map(a => new Date(a.valid_from).getTime()).sort((a, b) => a - b);
    const medianValidFrom = validFromTimes[Math.floor(validFromTimes.length / 2)];
    if (medianValidFrom - now.getTime() < PREINFO_MIN_LEAD_MS) return { shouldPost: false };

    // Schritt 4: Erster und "Mehrheits"-Tag bestimmen (lokal Schweiz).
    // Der Hauptlage-Tag bestimmt den State-Dedup-Schlüssel sowie die Tag-Phrase
    // im Tweet. Wenn der frühste Alarm an einem anderen Tag startet, geben wir
    // im Text zusätzlich darauf einen Hinweis ("Erste Zellen bereits …").
    const firstValidFrom = validFromTimes[0];
    // Häufigster Tag = Hauptlage-Tag. Pro Kandidat denselben Lookup machen,
    // damit wir auch die "frühen" (= vor der Hauptlage) Kandidaten identifizieren
    // können und deren cantons aggregieren.
    const dateCounts = {};
    const candidateDates = candidates.map(a => swissDateKey(new Date(a.valid_from)));
    for (const d of candidateDates) {
        dateCounts[d] = (dateCounts[d] || 0) + 1;
    }
    const majorityDate = Object.entries(dateCounts).sort((a, b) => b[1] - a[1])[0][0];
    const firstDate = swissDateKey(new Date(firstValidFrom));

    // Kantone der "frühen" Alarme (an einem anderen Tag als die Hauptlage).
    // Bleibt leer wenn firstDate === majorityDate.
    const earlyCantons = new Set();
    for (let i = 0; i < candidates.length; i++) {
        if (candidateDates[i] === majorityDate) continue;
        const a = candidates[i];
        if (Array.isArray(a.cantons)) {
            for (const c of a.cantons) earlyCantons.add(c);
        }
    }

    // Dedup-Check: wir tracken ALLE bereits geposteten target-dates (nicht nur
    // den letzten). So kann sich die targetDate-Semantik im Code ändern, ohne
    // dass alte State-Einträge zu Doppelposts führen.
    //
    // Wir schauen sowohl in `_postedPreInfoDates` (neues Set) als auch in
    // `_lastPreInfoTargetDate` (altes Einzelfeld) — Backwards-compat für
    // existierende state-Files.
    const postedSet = (state && state._postedPreInfoDates) || {};
    if (postedSet[majorityDate]) return { shouldPost: false };
    if (state && state._lastPreInfoTargetDate === majorityDate) return { shouldPost: false };
    // Falls der frühste Alarm-Tag bereits abgedeckt ist (z.B. wir hatten
    // gestern eine Vor-Front-Lage als Vorinfo für heute gepostet), keinen
    // Folge-Post mit demselben firstDate machen.
    if (postedSet[firstDate]) return { shouldPost: false };

    return {
        shouldPost: true,
        targetDate: majorityDate,
        majorityDate,
        firstValidFrom,
        firstDate,
        earlyCantons: Array.from(earlyCantons),
        regionCount,
        regionRatio: Math.round(regionRatio * 100)
    };
}

/**
 * Liefert ein reines Tag-Label für einen Schweizer Datums-Key ohne Uhrzeit:
 *   DE: "Heute" / "Morgen" / "Donnerstag, 4. Juni"
 *   FR: "Aujourd'hui" / "Demain" / "Jeudi 4 juin"
 *   IT: "Oggi" / "Domani" / "Giovedì 4 giugno"
 *
 * Genutzt für den Hauptsatz ("Morgen werden verbreitet Gewitter erwartet")
 * sowie für den Early-Zusatz ("Erste Zellen bereits heute …").
 */
function formatDayLabel(dateKey, lang, now = new Date()) {
    const todayKey = swissDateKey(now);
    const tomorrowKey = swissDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    if (dateKey === todayKey) return RELATIVE_DAY[lang].today;
    if (dateKey === tomorrowKey) return RELATIVE_DAY[lang].tomorrow;
    try {
        const d = new Date(dateKey + 'T12:00:00Z');
        const formatted = new Intl.DateTimeFormat(LOCALES[lang], {
            timeZone: SWISS_TZ,
            weekday: 'long', day: 'numeric', month: 'long'
        }).format(d);
        return formatted.charAt(0).toUpperCase() + formatted.slice(1);
    } catch (e) {
        return dateKey;
    }
}

/**
 * Erzeugt Vorinformations-Tweet-Texte für alle drei Sprachen.
 *
 * Pfade:
 *  - Wenn alle Kandidaten am selben Schweizer Tag starten (firstDate === majorityDate):
 *    Single-line "Morgen werden verbreitet Gewitter erwartet — …"
 *  - Wenn der frühste Alarm vor der Hauptlage liegt (Tessin-Vor-Front-Pattern):
 *    Zusätzliche Zeile "Erste Zellen bereits heute ab 23:00 Uhr möglich."
 *
 * Bild: derselbe Karten-Screenshot wie für Warnungen — die Karte zeigt durch
 * den erweiterten Filter (siehe filterActiveAlarms / renderWarnings) bereits
 * alle Vorlauf-Alarme.
 */
function formatCantonsList(cantonCodes, lang) {
    const codes = Array.isArray(cantonCodes) ? cantonCodes.slice() : [];
    if (codes.length === 0) return null;
    if (codes.length > MAX_NAMED_CANTONS) return CANTONS_MANY[lang];
    // Stabile Reihenfolge nach Code, damit Tweets reproduzierbar sind.
    codes.sort();
    const names = codes.map(c => (CANTON_NAMES[c] && CANTON_NAMES[c][lang]) || c);
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(', ') + CANTONS_LIST_AND[lang] + names[names.length - 1];
}

export function buildPreInfoTweets({ firstValidFrom, firstDate, majorityDate, earlyCantons, regionCount }, now = new Date()) {
    const result = {};
    const earlyTime = swissTimeLabel(new Date(firstValidFrom));
    const isSplit = firstDate !== majorityDate;

    for (const lang of ['de', 'fr', 'it']) {
        const mainDay = formatDayLabel(majorityDate, lang, now);
        const main = PREINFO_MAIN[lang](mainDay, regionCount);
        let middle = main;
        if (isSplit) {
            const earlyDay = formatDayLabel(firstDate, lang, now).toLowerCase();
            const cantonsStr = formatCantonsList(earlyCantons, lang);
            // Wenn keine Kantons-Info verfügbar (sollte selten passieren),
            // posten wir trotzdem die Hauptzeile — ohne Early-Zusatz.
            if (cantonsStr) {
                const early = PREINFO_EARLY[lang](earlyDay, earlyTime, cantonsStr);
                middle = `${main}\n${early}`;
            }
        }
        result[lang] = `${PREINFO_HEADER[lang]}\n\n${middle}\n\n${PREINFO_TAIL[lang]}\n\n${FOOTER[lang]}`;
    }
    return result;
}
