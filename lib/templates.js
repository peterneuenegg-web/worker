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

// priority → Stufentext pro Sprache (Mappings aus dem Unwetterkarte-Widget)
const LEVEL_LABELS = {
    1: { de: 'Mässige Gefahr',      fr: 'Danger modéré',         it: 'Pericolo moderato' },
    2: { de: 'Erhebliche Gefahr',   fr: 'Danger marqué',         it: 'Pericolo marcato' },
    3: { de: 'Grosse Gefahr',       fr: 'Grand danger',          it: 'Grande pericolo' },
    4: { de: 'Sehr grosse Gefahr',  fr: 'Très grand danger',     it: 'Pericolo molto grande' },
    5: { de: 'Extreme Gefahr',      fr: 'Danger extrême',        it: 'Pericolo estremo' }
};

// priority → Emoji (Tweet-optisch)
const LEVEL_EMOJI = {
    2: '🟠',
    3: '🔴',
    4: '🟤',
    5: '🟣'
};

// Sprach-Header und Footer
const HEADER = {
    de: count => `⚠️ ${count} aktive ${count === 1 ? 'Unwetterwarnung' : 'Unwetterwarnungen'} Schweiz`,
    fr: count => `⚠️ ${count} ${count === 1 ? 'alerte météo active' : 'alertes météo actives'} Suisse`,
    it: count => `⚠️ ${count} ${count === 1 ? 'avviso meteo attivo' : 'avvisi meteo attivi'} Svizzera`
};

const FOOTER = {
    de: '🔗 wetteralarm.ch/unwetterwarnungen.html',
    fr: '🔗 alarmemeteo.ch/alerte-intemperies.html',
    it: '🔗 allarmemeteo.ch/avvisi-di-maltempo.html'
};

const MIN_LEVEL_FOR_TWEET = 2; // Stufe 1 (Mässig) wird im Tweet ignoriert
const TWEET_MAX_LENGTH = 280;

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
                regions: new Set(),
                from: new Date(a.valid_from).getTime(),
                to:   new Date(a.valid_to).getTime()
            };
        }
        groups[key].regions.add(regionName(a, lang));
        const aFrom = new Date(a.valid_from).getTime();
        const aTo   = new Date(a.valid_to).getTime();
        if (aFrom < groups[key].from) groups[key].from = aFrom;
        if (aTo   > groups[key].to)   groups[key].to   = aTo;
    }
    return Object.values(groups).sort((a, b) => b.level - a.level);
}

// ===========================================
// Zeile pro Gruppe bauen
// ===========================================

function buildLine(group, lang) {
    const emoji = LEVEL_EMOJI[group.level] || '🟠';
    const type  = (WARN_LABELS[group.code] && WARN_LABELS[group.code][lang]) || group.code;
    const level = (LEVEL_LABELS[group.level] && LEVEL_LABELS[group.level][lang]) || '';
    const regions = Array.from(group.regions).join(', ');
    const time = formatValidityRange(group.from, group.to);
    return `${emoji} ${type} – ${level} – ${regions} (${time})`;
}

// ===========================================
// Tweet-Builder mit Length-Trimmer
// ===========================================

/**
 * Baut den Tweet aus Header + Zeilen + Footer.
 * Wenn zu lang: kürzt die Liste schrittweise und ersetzt überzählige Zeilen durch
 * "+N weitere" (lokalisiert).
 */
function buildTweet(groups, lang, totalAlarmCount) {
    const moreLabel = { de: 'weitere', fr: 'autres', it: 'altri' }[lang];
    const lines = groups.map(g => buildLine(g, lang));

    function assemble(visible, hiddenCount) {
        const linesPart = visible.slice();
        if (hiddenCount > 0) linesPart.push(`… +${hiddenCount} ${moreLabel}`);
        const header = HEADER[lang](totalAlarmCount);
        const footer = FOOTER[lang];
        return `${header}\n\n${linesPart.join('\n')}\n\n${footer}`;
    }

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
 * Filtert aktive Alarme (now zwischen valid_from und valid_to) und ab MIN_LEVEL_FOR_TWEET.
 */
export function filterActiveAlarms(alarms, now = new Date()) {
    return (alarms || []).filter(a => {
        const lvl = Number(a.priority) || 0;
        if (lvl < MIN_LEVEL_FOR_TWEET) return false;
        const from = new Date(a.valid_from);
        const to   = new Date(a.valid_to);
        return now >= from && now <= to;
    });
}

/**
 * Erzeugt Tweet-Texte für alle drei Sprachen.
 */
export function buildTweets(alarms) {
    const active = filterActiveAlarms(alarms);
    const total = active.length;
    if (total === 0) return null; // → nichts zu tweeten

    const result = {};
    for (const lang of ['de', 'fr', 'it']) {
        const groups = groupAlarms(active, lang);
        if (groups.length === 0) {
            result[lang] = null;
            continue;
        }
        result[lang] = buildTweet(groups, lang, total);
    }
    return result;
}
