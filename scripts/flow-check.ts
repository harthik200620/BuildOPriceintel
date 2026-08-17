/**
 * The catalogue flow, end to end, in a real browser:
 *
 *   home → card → category listing (URL, heading, rail) → facet → URL carries
 *   it → reload keeps it → back returns home → typing on home lands in search
 *   with focus kept → phone: filter sheet opens, applies, closes.
 *
 *   BUILDOBJECTS_URL=http://localhost:3001 npx tsx scripts/flow-check.ts
 */
import { chromium, type Page } from 'playwright';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
let failures = 0;
function ok(name: string, cond: unknown, detail = '') {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond ? '' : detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}
const path = (p: Page) => new URL(p.url()).pathname + new URL(p.url()).search;

(async () => {
  const browser = await chromium.launch();

  /* ── desktop ────────────────────────────────────────────────────────── */
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    ok('home renders the catalogue heading', (await page.textContent('h1'))?.replace(/\s+/g, ' ').trim() === 'Product categories');
    ok('eight category cards', await page.locator('.cat-card').count() === 8);
    ok('four are links, four are not', await page.locator('a.cat-card').count() === 4 && await page.locator('.cat-card--soon').count() === 4);
    ok('a live card prints a from-price and counts', await page.locator('a.cat-card .cat-from .fig').first().textContent().then((t) => /₹/.test(t ?? '')));
    ok('a coming-soon card prints no rupee figure', !(await page.locator('.cat-card--soon').first().textContent())?.includes('₹'));

    // The seller count on the card equals the listing's heading count.
    const cardText = (await page.locator('a.cat-card').first().textContent()) ?? '';
    const cardSellers = Number(cardText.match(/·\s*([\d,]+)\s*sellers/)?.[1]?.replace(/,/g, ''));
    await page.locator('a.cat-card').first().click();
    await page.waitForURL('**/c/cement**');
    ok('card click navigates to /c/cement without reload', path(page) === '/c/cement');
    await page.waitForSelector('h1:has-text("Cement")');
    await page.waitForFunction(() => /\d+ sellers/.test(document.querySelector('h1')?.textContent ?? ''));
    const h1 = (await page.textContent('h1')) ?? '';
    const headSellers = Number(h1.match(/([\d,]+)\s*sellers/)?.[1]?.replace(/,/g, ''));
    ok(`card sellers (${cardSellers}) == listing sellers (${headSellers})`, cardSellers === headSellers);
    ok('breadcrumb present', await page.locator('nav[aria-label="Breadcrumb"]').count() === 1);
    ok('filter rail present with facets', await page.locator('aside .facet-val').count() > 5);
    ok('category strip marks the current category', await page.locator('.cat-strip-item[aria-current="page"]').textContent().then((t) => t?.includes('Cement')));
    ok('document title follows the view', (await page.title()).startsWith('Cement prices in'));

    // Facet → URL → reload keeps it.
    const firstFacet = page.locator('aside .facet-val input').first();
    const label = (await page.locator('aside .facet-val').first().textContent())?.trim() ?? '';
    await firstFacet.check();
    await page.waitForFunction(() => location.search.includes('f.'));
    ok('facet selection lands in the URL', path(page).includes('?f.'), path(page));
    ok('active facet shows as a removable chip', await page.locator('button[aria-label^="Remove filter"]').count() >= 1);
    const urlWithFacet = page.url();
    await page.reload({ waitUntil: 'networkidle' });
    ok('reload keeps the facet selection', await page.locator(`aside .facet-val:has-text("${label.split(/\s/)[0]}") input`).first().isChecked(), label);
    ok('reload keeps the URL', page.url() === urlWithFacet);

    // Sideways to another category, then back twice → home.
    await page.locator('.cat-strip-item:has-text("TMT steel")').click();
    await page.waitForURL('**/c/tmt-steel');
    ok('strip navigates to /c/tmt-steel', path(page) === '/c/tmt-steel');
    ok('facets reset on category change', !path(page).includes('f.'));
    await page.goBack();
    await page.waitForURL('**/c/cement**');
    ok('back returns to cement with its facet', path(page).startsWith('/c/cement?f.'), path(page));
    await page.goBack();
    await page.waitForURL(BASE + '/');
    ok('back again returns home', path(page) === '/');
    await page.waitForSelector('.cat-grid');
    ok('home view re-rendered after back', await page.locator('.cat-card').count() === 8);

    // Typing on home moves into search and keeps focus.
    const input = page.locator('input[type="search"], input[role="combobox"], header input').first();
    await input.click();
    await input.type('8mm tmt', { delay: 20 });
    await page.waitForURL('**/search?q=**');
    ok('typing on home lands in /search?q=', path(page).startsWith('/search?q=8mm'), path(page));
    ok('the search field kept focus', await page.evaluate(() => document.activeElement?.tagName === 'INPUT'));
    ok('typed value survives the view change', (await input.inputValue()) === '8mm tmt');
    await page.waitForFunction(() => /\d+ sellers/.test(document.querySelector('h1')?.textContent ?? ''));
    ok('search heading quotes the query', ((await page.textContent('h1')) ?? '').includes('8mm tmt'));

    // Wordmark → home, client-side.
    await page.locator('header a[aria-label*="home"]').click();
    await page.waitForURL(BASE + '/');
    ok('wordmark returns home client-side', path(page) === '/');

    ok('no console/page errors on desktop', errors.length === 0, errors.slice(0, 3).join(' | '));

    // A 404 for a coming-soon slug. (After the error check — these two
    // navigations log their own 404 to the console by design.)
    const r = await page.goto(BASE + '/c/aggregates');
    ok('coming-soon slug is a real 404', r?.status() === 404);
    const r2 = await page.goto(BASE + '/definitely-not-a-page');
    ok('unknown path is a real 404', r2?.status() === 404);
    await ctx.close();
  }

  /* ── phone ──────────────────────────────────────────────────────────── */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/c/bricks-blocks', { waitUntil: 'networkidle' });
    ok('phone: rail is hidden', !(await page.locator('aside').first().isVisible().catch(() => false)));
    const filters = page.locator('button[aria-haspopup="dialog"]:has-text("Filters")');
    await filters.waitFor();
    ok('phone: Filters button present', await filters.isVisible());
    await filters.click();
    const dialog = page.locator('[role="dialog"][aria-label="Filters"]');
    await dialog.waitFor();
    ok('phone: sheet opens', await dialog.isVisible());
    const before = (await page.locator('[role="dialog"] .btn-primary').textContent()) ?? '';
    await page.locator('[role="dialog"] .facet-val input').first().check();
    await page.waitForFunction(() => location.search.includes('f.'));
    await page.waitForTimeout(600);
    const after = (await page.locator('[role="dialog"] .btn-primary').textContent()) ?? '';
    ok(`phone: apply button counts update (${before.trim()} → ${after.trim()})`, before !== after);
    await page.locator('[role="dialog"] .btn-primary').click();
    ok('phone: sheet closes on apply', !(await dialog.isVisible().catch(() => false)));
    ok('phone: filter chip visible outside the sheet', await page.locator('button[aria-label^="Remove filter"]').count() >= 1);
    // Location control.
    await page.locator('header button[aria-haspopup="dialog"]').click();
    ok('phone: location control opens', await page.locator('[role="dialog"][aria-label="Where to deliver"]').isVisible());
    await ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall flow checks passed');
  process.exit(failures ? 1 : 0);
})();
