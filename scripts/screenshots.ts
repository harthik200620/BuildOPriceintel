/**
 * Screenshots of the finished UI, into screenshots/.
 *
 * Drives the real running app with Playwright rather than mocking anything, so
 * every figure in these images is a price actually in data/buildobjects.db.
 *
 *   npx playwright install chromium     (once)
 *   npm run shots
 */
import { chromium, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
const OUT = path.join(process.cwd(), 'screenshots');
const VIEWPORT = { width: 1512, height: 950 };

async function settle(page: Page, ms = 700) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function shot(page: Page, name: string, full = false) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  console.log(`  ${name}.png`);
  return file;
}

async function main() {
  const browser = await chromium.launch();
  // Patina is a dark theme. The emulated scheme decides how the headless
  // browser paints native <select> popups and checkbox chrome, so a 'light'
  // context would shoot white widgets the real page never renders.
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();

  console.log(`capturing from ${BASE}\n`);

  // ── 1. search dropdown, with a unit-bearing query ────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 1200);
  await page.click('input[role="combobox"]');
  await page.type('input[role="combobox"]', '8mm tmt', { delay: 55 });
  await page.waitForTimeout(650);
  await shot(page, '01-search-dropdown');

  // ── 2. results with filters applied ──────────────────────────────────────
  await page.keyboard.press('Escape');
  await page.fill('input[role="combobox"]', '');
  await settle(page, 500);
  // Cement, then tick a type so the rail is visibly doing work. Shot on cement
  // rather than TMT because TMT has one supplier in this dataset, and a
  // vendor-led list with one seller is a single card — accurate, but it shows
  // nothing about how the rail and the results interact.
  const cementChip = page.locator('button', { hasText: /^Cement/ }).first();
  if (await cementChip.count()) { await cementChip.click(); await settle(page, 800); }
  const ppc = page.locator('label', { hasText: /^PPC/ }).first();
  if (await ppc.count()) { await ppc.click(); await settle(page, 800); }
  await shot(page, '02-results-filtered');

  // ── 3. the product card, close up ────────────────────────────────────────
  // Shot on cement, not the TMT set above: the detail sheet's whole claim is
  // "every vendor, none truncated", and cement is the category with enough
  // sellers on one SKU to actually show that. Pick the deepest card.
  await page.keyboard.press('Escape');

  const deepest = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('article')];
    let bestIdx = 0, bestN = -1;
    cards.forEach((c, i) => {
      const m = c.textContent?.match(/\+(\d+)\s+more/);
      const n = m ? Number(m[1]) : 0;
      if (n > bestN) { bestN = n; bestIdx = i; }
    });
    return { bestIdx, bestN };
  });
  console.log(`  (detail sheet on card #${deepest.bestIdx}, +${deepest.bestN} more vendors)`);

  const card = page.locator('article').nth(deepest.bestIdx);
  if (await card.count()) {
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(250);
    // Hold the hover long enough for the picture rotation to advance past the
    // first frame — the progress bars are only meaningful mid-cycle.
    await card.hover();
    await page.waitForTimeout(1500);
    fs.mkdirSync(OUT, { recursive: true });
    await card.screenshot({ path: path.join(OUT, '03-product-card.png') });
    console.log('  03-product-card.png');
  }

  // ── 4. the detail sheet with the vendor table ────────────────────────────
  await card.locator('button').first().click();
  // Wait for real content, not just the dialog frame — otherwise this captures
  // the skeleton, which is a state we shoot deliberately elsewhere.
  await page.waitForSelector('[role="dialog"] h1', { timeout: 15000 }).catch(() => {});
  await page.waitForFunction(
    () => !!document.querySelector('[role="dialog"]')?.textContent?.includes('Every vendor'),
    { timeout: 15000 },
  ).catch(() => {});
  await settle(page, 900);
  await shot(page, '04-detail-sheet');

  // Scroll the sheet to the specification table so provenance badges are visible.
  //
  // This used to be `scrollTop = scrollHeight * 0.42`. That fraction was tuned
  // against one rendering: the sheet's height is a stack of unpinned line boxes,
  // so any change of typeface moves it and 42% lands somewhere else — with no
  // error, just a screenshot of the wrong section. Scrolling to the thing the
  // shot is actually of is face-independent.
  const sheet = page.locator('[role="dialog"]').first();
  if (await sheet.count()) {
    const spec = sheet.getByRole('heading', { name: /^Specification/i }).first();
    if (await spec.count()) await spec.scrollIntoViewIfNeeded().catch(() => {});
    else await sheet.evaluate((el) => { el.scrollTop = el.scrollHeight * 0.42; });
    await page.waitForTimeout(600);
    await shot(page, '05-detail-sheet-provenance');
  }
  await page.keyboard.press('Escape');
  await settle(page, 500);

  // ── 5. compare tray ──────────────────────────────────────────────────────
  const cards = page.locator('article');
  const n = Math.min(3, await cards.count());
  for (let i = 0; i < n; i++) {
    const c = cards.nth(i);
    await c.hover();
    await page.waitForTimeout(160);
    await c.locator('button[aria-pressed]').first().click().catch(() => {});
  }
  await settle(page, 700);
  await shot(page, '06-compare-tray');

  // ── 6. zero-result state ─────────────────────────────────────────────────
  await page.fill('input[role="combobox"]', 'xyzzy nonexistent widget 999');
  await settle(page, 900);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await shot(page, '07-zero-result');

  // ── 7. one seller's stock, drilled into ─────────────────────────────────
  // A category supplied by a single vendor renders as one card, so the roll-up
  // control has to be a real way in. This is that state.
  // Clear the state the previous two shots left behind — the nonsense query and
  // the compare selections — or this frame documents a mess rather than a state.
  await page.fill('input[role="combobox"]', '');
  await page.keyboard.press('Escape');
  const clearAll = page.locator('button', { hasText: /^clear all$/ }).first();
  if (await clearAll.count()) { await clearAll.click(); await settle(page, 400); }
  const allChip = page.locator('button', { hasText: /^All$/ }).first();
  if (await allChip.count()) { await allChip.click(); await settle(page, 600); }
  const tmt = page.locator('button', { hasText: /^TMT steel/ }).first();
  if (await tmt.count()) { await tmt.click(); await settle(page, 900); }
  const rollUp = page.locator('button', { hasText: /^\+\d+ more from this seller$/ }).first();
  if (await rollUp.count()) { await rollUp.click(); await settle(page, 1100); }
  await shot(page, '08-vendor-drilldown');

  // ── 8. water pipes, the category that used to be empty ──────────────────
  // This was the designed empty state for most of the build. It is not empty
  // any more — the scoped sweep filled it — so the shot shows what is actually
  // there rather than preserving a screenshot of a gap that has closed.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('buildobjects:set-category', { detail: 'water_pipes' }));
  });
  await settle(page, 1400);
  await shot(page, '09-water-pipes');

  await browser.close();
  console.log(`\n${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} screenshots → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
