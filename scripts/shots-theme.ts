/**
 * Screenshots of the catalogue-first views at three widths, plus a 2× desktop
 * capture — the artefacts the theme review is scored against.
 *
 *   BUILDOBJECTS_URL=http://localhost:3001 npx tsx scripts/shots-theme.ts [outDir]
 */
import { chromium, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
const OUT = process.argv[2] ?? path.join(process.cwd(), 'docs', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const VIEWS: Array<{ name: string; width: number; height: number; dpr: number }> = [
  { name: 'desktop', width: 1440, height: 900, dpr: 1 },
  { name: 'desktop@2x', width: 1440, height: 900, dpr: 2 },
  { name: 'tablet', width: 1024, height: 1366, dpr: 1 },
  { name: 'phone', width: 390, height: 844, dpr: 2 },
];

const PAGES: Array<{ name: string; path: string; full?: boolean; after?: (p: Page) => Promise<void> }> = [
  { name: 'home', path: '/', full: true },
  { name: 'cement', path: '/c/cement', full: false },
  { name: 'cement-filtered', path: '/c/cement?f.cement_type=OPC&f.brand=UltraTech', full: false },
  { name: 'search', path: '/search?q=8mm%20tmt', full: false },
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  // Fonts, images, and the first fetch of the listing.
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  // Walk the page once so lazy images below the fold are requested and
  // decoded before a full-page capture — the capture itself does not scroll.
  await page.evaluate(async () => {
    const h = document.documentElement.scrollHeight;
    for (let y = 0; y < h; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch();
  for (const v of VIEWS) {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.dpr,
      reducedMotion: 'reduce',
      colorScheme: 'dark',
    });
    const page = await ctx.newPage();
    for (const p of PAGES) {
      await page.goto(BASE + p.path, { waitUntil: 'domcontentloaded' });
      await settle(page);
      if (p.after) await p.after(page);
      const file = path.join(OUT, `${p.name}-${v.name}.png`);
      await page.screenshot({ path: file, fullPage: !!p.full });
      console.log('wrote', path.relative(process.cwd(), file));
    }
    await ctx.close();
  }
  await browser.close();
})();
