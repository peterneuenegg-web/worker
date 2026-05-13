# wetteralarm-x-poster

Automatischer X/Twitter-Bot für aktive Wetter-Alarm-Unwetterwarnungen in DE/FR/IT.

## Funktionsweise

Alle 15 Min via GitHub-Actions-Cron:

1. Holt aktive Alarme von `my.wetteralarm.ch/v7/alarms/meteo-and-hail.json`.
2. Filtert Stufe 1 (Mässig) aus, behält Stufe ≥ 2.
3. Vergleicht mit `state/posted.json` — gibt es **neue** `alarm.id`?
4. Wenn ja:
   - Playwright öffnet `tool.wetteralarm.ch/x-warnungen/render.html` → Screenshot.
   - Tweet-Texte für DE / FR / IT werden gebaut (Stufenfarben, Bündelung, Gültigkeitszeitraum).
   - Bild + Text auf alle drei X-Accounts.
   - State wird aktualisiert und committed.
5. Wenn nein: nichts.

## Setup

### 1. Repo public auf GitHub

GitHub Actions sind im public repo unbegrenzt kostenlos.

### 2. Secrets in GitHub Actions

Settings → Secrets and variables → Actions → New secret. Drei Secrets, jeweils ein JSON-String:

- `X_TOKENS_DE`:
  ```json
  {"apiKey":"…","apiSecret":"…","accessToken":"…","accessSecret":"…"}
  ```
- `X_TOKENS_FR`: dito für `@alarmemeteo`
- `X_TOKENS_IT`: dito für `@allarmemeteo`

Die vier Werte je Account werden im [X Developer Portal](https://developer.x.com) erzeugt (Read+Write-Permissions auf der App).

### 3. Render-Seite muss laufen

`tool.wetteralarm.ch/x-warnungen/render.html` (siehe `../render/`) muss erreichbar sein und auf `?env=prod`/`?env=stage` reagieren.

## Lokaler Testlauf

```bash
npm install
npx playwright install chromium

# Dry-Run — keine Tweets, Bild als JPEG in state/dry-run-*.jpg
DRY_RUN=true ENV=stage RENDER_BASE_URL=https://tool.wetteralarm.ch/x-warnungen npm run post

# Live (nur mit echten Tokens als env-vars):
ENV=stage X_TOKENS_DE='{"apiKey":…}' npm run post
```

## Manueller Trigger via GitHub-UI

Actions-Tab → Workflow „Unwetterwarnungen auf X posten" → „Run workflow":
- `env: stage` oder `prod`
- `dry_run: true` für Test (Screenshot wird als Artifact hochgeladen, keine Tweets)

## Files

- `post.js` — Hauptlogik
- `lib/templates.js` — Tweet-Text-Builder (DE/FR/IT)
- `lib/dedupe.js` — State-Management
- `render-screenshot.js` — Playwright-Wrapper für den Karten-Screenshot
- `state/posted.json` — De-Dup-State (wird vom Workflow commited)
- `.github/workflows/post.yml` — Cron-Workflow
