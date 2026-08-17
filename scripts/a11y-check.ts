/**
 * axe-core over the three views, desktop and phone, plus a keyboard walk of the
 * catalogue: every card reachable by Tab, opened by Enter, and focus visible.
 *
 *   BUILDOBJECTS_URL=http://localhost:3001 npx tsx scripts/a11y-check.ts
 */
import { chromium, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
const AXE = fs.readFileSync(path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
let failures = 0;
const ok = (name: string, cond: unknown, detail = '') => {
  console.log(`${cond ? '  ok ' : 'FAIL '} ${name}${cond || !detail ? '' : ` — ${detail}`}`);
  if (!cond) failures++;
};

async function axe(page: Page, label: string) {
  await page.addScriptTag({ content: AXE });
  const res: any = await page.evaluate(async () => {
    // @ts-ignore
    return await (window as any).axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      // The aurora and grain are decorative fixed layers; axe still walks them.
      exclude: [['.aurora'], ['.grain']],
    });
  });
  const serious = res.violations.filter((v: any) => v.impact === 'serious' || v.impact === 'critical');
  const minor = res.violations.filter((v: any) => v.impact !== 'serious' && v.impact !== 'critical');
  ok(`${label}: no serious/critical axe violations (${res.passes.length} rules passed)`, serious.length === 0,
    serious.map((v: any) => `${v.id} ×${v.nodes.length}: ${v.nodes[0]?.target?.[0]}`).join(' | '));
  if (minor.length) console.log(`       minor/moderate: ${minor.map((v: any) => `${v.id} ×${v.nodes.length} (${v.nodes[0]?.target?.[0]})`).join(' | ')}`);
}

(async () => {
  const browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
    const ctx = await browser.newContext({ viewport: vp, reducedMotion: 'reduce', isMobile: name === 'phone', hasTouch: name === 'phone' });
    const page = await ctx.newPage();
    for (const p of ['/', '/c/cement', '/search?q=8mm%20tmt']) {
      await page.goto(BASE + p, { waitUntil: 'networkidle' });
      await page.waitForTimeout(500);
      await axe(page, `${name} ${p}`);
    }
    await ctx.close();
  }

  // Keyboard walk on the catalogue.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    // Tab until the first category card has focus, counting hops.
    let hops = 0, onCard = false;
    for (; hops < 25; hops++) {
      await page.keyboard.press('Tab');
      onCard = await page.evaluate(() => document.activeElement?.classList.contains('cat-card') ?? false);
      if (onCard) break;
    }
    ok(`Tab reaches the first category card (${hops + 1} hops)`, onCard);
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement; const cs = getComputedStyle(el);
      return `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`;
    });
    ok(`focused card shows a visible outline (${outline})`, /solid/.test(outline) && !/0px/.test(outline));
    // The four live cards are consecutive tab stops; the coming-soon ones are skipped.
    let liveStops = 1;
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement?.classList.contains('cat-card'))) liveStops++; }
    ok('the four live cards are consecutive tab stops', liveStops === 4);
    await page.keyboard.press('Tab');
    ok('coming-soon cards are not tab stops', !(await page.evaluate(() => document.activeElement?.classList.contains('cat-card--soon'))));
    // Back to a card and open it with Enter.
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+Tab');
    ok('Shift+Tab returns to a card', await page.evaluate(() => document.activeElement?.classList.contains('cat-card')));
    await page.keyboard.press('Enter');
    await page.waitForURL('**/c/**');
    ok('Enter opens the listing', /\/c\//.test(page.url()));
    // The listing's heading is an h1 and there is exactly one.
    ok('exactly one h1 on the listing', (await page.locator('h1').count()) === 1);
    await ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall a11y checks passed');
  process.exit(failures ? 1 : 0);
})();
