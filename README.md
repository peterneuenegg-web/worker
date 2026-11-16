# wetteralarm-x-poster

GitHub-Action-Worker für den X-Unwetterwarnungs-Bot (DE / FR / IT).

Architektur, Datenfluss, Cooldown- und Entwarnungs-Logik sind im
[Haupt-README](../README.md) erklärt — diese Datei beschreibt nur das
Setup und den lokalen Testlauf.

## Setup

### 1. Repo public auf GitHub

GitHub Actions sind im public repo unbegrenzt kostenlos. Achtung: keine
Secrets in den Code committen (siehe Punkt 2).

### 2. Secrets in GitHub Actions

Settings → Secrets and variables → Actions → New secret. Drei Secrets,
jeweils ein **JSON-String** mit allen vier OAuth-1.0a-Werten:

- `X_TOKENS_DE`
  ```json
  {"apiKey":"…","apiSecret":"…","accessToken":"…","accessSecret":"…"}
  ```
- `X_TOKENS_FR` — dito für `@alarmemeteo`
- `X_TOKENS_IT` — dito für `@allarmemeteo`

Tokens werden im [X Developer Portal](https://developer.x.com) erzeugt,
**Permissions = Read + Write**, App in einem Pay-Per-Use-Projekt
(Free Tier wurde am 06.02.2026 abgeschafft).

### 3. Render-Seite muss erreichbar sein

`https://tool.wetteralarm.ch/x-warnungen/render.html?env=prod|stage`
liegt im Schwesterverzeichnis [`../render/`](../render/) und muss auf
Infomaniak deployed sein. Sie liefert das Bild, das in den Tweet kommt.

## Lokaler Testlauf

```powershell
npm install
npx playwright install chromium

# Dry-Run — keine Tweets, Screenshot in state/screenshot-dry-*.jpg
$env:DRY_RUN = "true"
$env:ENV = "stage"
$env:RENDER_BASE_URL = "https://tool.wetteralarm.ch/x-warnungen"
npm run post

# Live (nur mit echten Tokens als env-vars):
$env:DRY_RUN = "false"
$env:X_TOKENS_DE = '{"apiKey":"…","apiSecret":"…","accessToken":"…","accessSecret":"…"}'
npm run post
```

## Alt-Posts einmalig aufräumen

Lokal (Dry-Run ist Default — listet nur auf):

```powershell
$env:X_TOKENS_DE = '{"apiKey":"…","apiSecret":"…","accessToken":"…","accessSecret":"…"}'
$env:X_TOKENS_FR = '…'
$env:X_TOKENS_IT = '…'
npm run cleanup-old-posts

# Scharf (löscht + schreibt Register nach state/posted.json — danach committen/pushen!):
$env:DRY_RUN = "false"
npm run cleanup-old-posts
```

Optional `$env:LANGS = "de"` für einen einzelnen Account. Einfacher: Workflow
"Alte Posts auf X aufräumen (einmalig)" im Actions-Tab — der committet den
State selbst.

## Manueller Trigger via GitHub-UI

Actions-Tab → Workflow "Unwetterwarnungen auf X posten" → "Run workflow":

- `env`: `prod` oder `stage`
- `dry_run`: `true` für Testlauf (Screenshot als Workflow-Artefakt,
  keine Tweets) oder `false` für echtes Posting.

## Files

| Datei                          | Zweck                                                |
|--------------------------------|------------------------------------------------------|
| `post.js`                      | Hauptlogik (Cron-Entry, Cooldown, Entwarnung, Löschen alter Posts) |
| `cleanup-old-posts.js`         | Einmal-Script: Alt-Posts via Timeline löschen/registrieren |
| `lib/templates.js`             | Tweet-Builder (DE/FR/IT, 3 Detail-Modi, Clear-Tweet) |
| `lib/dedupe.js`                | State-Management (`posted.json` + Meta-Felder)       |
| `render-screenshot.js`         | Playwright-Wrapper für den 1200×675-Screenshot       |
| `state/posted.json`            | De-Dup-State + Tweet-Register, vom Workflow committed |
| `.github/workflows/post.yml`   | Cron-Workflow (alle 5 Min)                           |
| `.github/workflows/cleanup-old-posts.yml` | Manueller Workflow fürs einmalige Aufräumen |

## Environment-Variablen

| Var               | Pflicht | Default                                       | Wirkung                          |
|-------------------|---------|-----------------------------------------------|----------------------------------|
| `ENV`             | nein    | `prod`                                        | API-Umgebung (`prod` / `stage`)  |
| `DRY_RUN`         | nein    | `false`                                       | Kein X-Post; State + Screenshot bleiben |
| `RENDER_BASE_URL` | nein    | `https://tool.wetteralarm.ch/x-warnungen`     | Basis-URL der Render-Seite       |
| `TWEET_RETENTION_DAYS` | nein | `14`                                     | Tage nach Gültigkeitsende, bis ein Post gelöscht wird |
| `X_TOKENS_DE`     | ja*     | —                                             | JSON-String OAuth-1.0a DE-Account|
| `X_TOKENS_FR`     | ja*     | —                                             | JSON-String OAuth-1.0a FR-Account|
| `X_TOKENS_IT`     | ja*     | —                                             | JSON-String OAuth-1.0a IT-Account|

\* Im Live-Modus mindestens **eines** der drei Token-Sets. Sprachen ohne
gültige Tokens werden übersprungen, der Run schlägt aber nicht fehl, solange
mindestens ein Account postbar ist.
