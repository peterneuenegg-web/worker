/**
 * Screenshot der Render-Seite via Playwright (Headless Chromium).
 *
 * Erwartet, dass die Render-Seite window.unwetterkarte_ready = true setzt,
 * sobald Tiles und Warnpolygone vollständig geladen sind.
 *
 * Output: JPEG-Buffer (~150–300 kB) optimiert auf 1200×675 (Twitter-16:9).
 */

import { chromium } from 'playwright';
import sharp from 'sharp';

const VIEWPORT = { width: 1200, height: 675 };
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
            deviceScaleFactor: 1,
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
