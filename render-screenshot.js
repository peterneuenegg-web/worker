/**
 * Screenshot der Render-Seite via Playwright (Headless Chromium).
 *
 * Erwartet, dass die Render-Seite window.unwetterkarte_ready = true setzt,
 * sobald Tiles und Warnpolygone vollständig geladen sind.
 *
 * Output: JPEG-Buffer optimiert auf 2400×1350 Px (Twitter-16:9 @2x).
 *
 * Warum 2x?
 *   1. Fullscreen auf Retina-/HiDPI-Displays bleibt scharf — X skaliert sonst
 *      die 1200×675 hoch und das wirkt weichgezeichnet.
 *   2. Bei fractional Leaflet-Zoom (8.25) entstehen bei DSF=1 zwischen Tile-
 *      Reihen 1-px-Naht-Artefakte — bei DSF=2 sind die Tile-Pixel-Grenzen
 *      ganzzahlig und das Phänomen verschwindet.
 */

import { chromium } from 'playwright';
import sharp from 'sharp';

// CSS-Viewport bleibt 1200×675 — nur die Pixel-Dichte verdoppelt sich.
// Tatsächlicher Screenshot-Output ist 2400×1350 px.
const VIEWPORT = { width: 1200, height: 675 };
const DEVICE_SCALE_FACTOR = 2;
const READY_TIMEOUT_MS = 25_000;
// Sicherheits-Puffer NACH dem Ready-Flag — manchmal sind Tiles noch leicht am Nachladen.
const SETTLE_DELAY_MS = 800;

/**
 * @param {string} renderUrl    URL der Render-Seite, z.B.
 *                              https://tool.wetteralarm.ch/x-warnungen/render.html?env=prod
 * @returns {Promise<{ jpeg: Buffer, error: string|null }>}
 */
export async function captureMap(renderUrl) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--disable-blink-features=AutomationControlled']
    });
    let page;
    try {
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: DEVICE_SCALE_FACTOR,
            userAgent: 'Wetter-Alarm-X-Poster/1.0 (+https://wetteralarm.ch)'
        });
        page = await context.newPage();

        page.on('console', msg => {
            // Render-Seiten-Logs zur Worker-Console weiterreichen — hilft beim Debug.
            const type = msg.type();
            if (type === 'error' || type === 'warning') {
                console.warn(`[render-page ${type}]`, msg.text());
            } else {
                console.log(`[render-page]`, msg.text());
            }
        });

        console.log(`[screenshot] Öffne ${renderUrl}`);
        await page.goto(renderUrl, { waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS });

        // Warten bis die Render-Seite ihr Bereit-Flag setzt.
        await page.waitForFunction(
            () => window.unwetterkarte_ready === true,
            { timeout: READY_TIMEOUT_MS }
        );

        // Prüfen, ob die Render-Seite einen Fehler gemeldet hat.
        const errorMsg = await page.evaluate(() => window.unwetterkarte_error || null);
        if (errorMsg) {
            return { jpeg: null, error: 'Render-Seite meldet: ' + errorMsg };
        }

        await page.waitForTimeout(SETTLE_DELAY_MS);

        const rawPng = await page.screenshot({
            type: 'png',
            fullPage: false,
            clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height }
        });

        // PNG → JPEG (Twitter mag JPEG, kleinere Datei, schnellerer Upload)
        const jpeg = await sharp(rawPng)
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer();

        console.log(`[screenshot] OK — ${jpeg.length} bytes`);
        return { jpeg, error: null };

    } catch (err) {
        return { jpeg: null, error: 'Screenshot-Fehler: ' + (err.message || err) };
    } finally {
        if (page) await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}
