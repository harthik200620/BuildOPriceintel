/**
 * The measurements a theme review is scored on, taken from a real browser.
 *
 * Every number a UI claim rests on should come from here rather than from
 * looking at a screenshot: horizontal overflow, controls that collide with
 * content, the placeholder that gets cut, how many separate facts a result
 * card prints, and whether any native control slipped through unskinned.
 *
 *   BUILDOBJECTS_URL=http://localhost:3000 npx tsx scripts/ui-probe.ts
 */
import { chromium, type Page } from 'playwright';

/**
 * Every harness browser is a brand-new profile, so without this each one is a
 * first-time visitor and "/" bounces to the welcome screen. Seeding the flag
 * puts these runs in the returning-buyer state, which is the one they are
 * about to assert on. The first-run redirect has its own check in flow-check.
 */
async function seedStarted(ctx: import('playwright').BrowserContext) {
  await ctx.addInitScript(() => {
    try { window.localStorage.setItem('buildobjects:started', '1'); } catch { /* private mode */ }
  });
}


const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';

const VIEWS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 1366 },
  { name: 'phone', width: 390, height: 844 },
];

const PATHS = ['/', '/c/cement', '/search?q=8mm%20tmt'];

type Row = { view: string; path: string; metric: string; value: string; ok: boolean };
const rows: Row[] = [];
const add = (view: string, path: string, metric: string, value: string, ok: boolean) =>
  rows.push({ view, path, metric, value, ok });

async function settle(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch();
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height } });
    await seedStarted(ctx);
    const page = await ctx.newPage();
    for (const p of PATHS) {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
      await settle(page);

      // 1. Horizontal overflow — a page that scrolls sideways is a defect at
      //    every width, and it is the failure a screenshot hides.
      const over = await page.evaluate(() => {
        const d = document.documentElement;
        const wide: string[] = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0) continue;
          if (r.right > d.clientWidth + 1 || r.left < -1) {
            const t = el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
            if (!wide.includes(t)) wide.push(t);
          }
        }
        return { scrollW: d.scrollWidth, clientW: d.clientWidth, offenders: wide.slice(0, 4) };
      });
      add(v.name, p, 'h-overflow', over.scrollW > over.clientW ? `${over.scrollW - over.clientW}px — ${over.offenders.join(', ')}` : 'none', over.scrollW <= over.clientW);

      /*
       * 2. Does the floating assistant permanently hide content?
       *
       * A fixed button floats over the column mid-scroll — that is what a
       * floating button is, and every app does it. What is a defect is content
       * that can NEVER be read, so the page is scrolled to the end first: if
       * the column reserves the band the button occupies, the last card clears
       * it and nothing is unreachable. If it does not, the bottom row is under
       * the button at every scroll position, which is what was happening.
       */
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(250);
      const fab = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const f = btns.find((b) => /ask/i.test(b.textContent ?? '') && getComputedStyle(b).position === 'fixed');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        const hits: string[] = [];
        const probe = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4], [r.right - 4, r.bottom - 4]];
        for (const [x, y] of probe) {
          for (const el of document.elementsFromPoint(x, y)) {
            if (f.contains(el) || el.contains(f)) continue;
            const tag = el.tagName.toLowerCase();
            if (['html', 'body', 'main', 'div'].includes(tag) && !el.className) continue;
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
            if (/article|cat-card|glass-card|trust/.test(tag + ' ' + cls)) hits.push(tag + (cls ? '.' + cls : ''));
          }
        }
        return { box: `${Math.round(r.width)}×${Math.round(r.height)} @ ${Math.round(r.left)},${Math.round(r.top)}`, covers: Array.from(new Set(hits)).slice(0, 3) };
      });
      if (fab) add(v.name, p, 'fab-covers-content', fab.covers.length ? fab.covers.join(', ') : 'nothing', fab.covers.length === 0);

      // 3. A placeholder wider than its field is a hint nobody can read.
      const ph = await page.evaluate(() => {
        // The VISIBLE field. The search input exists at both widths and only
        // one of them renders — measuring the hidden one reports a negative
        // width and calls a working field broken.
        const all = Array.from(document.querySelectorAll('input[placeholder]')) as HTMLInputElement[];
        const i = all.find((el) => el.getBoundingClientRect().width > 0 && el.placeholder.trim().length > 0) ?? null;
        if (!i) return null;
        const cs = getComputedStyle(i);
        const c = document.createElement('canvas').getContext('2d')!;
        c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const textW = c.measureText(i.placeholder).width;
        const avail = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { textW: Math.round(textW), avail: Math.round(avail), text: i.placeholder };
      });
      if (ph) add(v.name, p, 'placeholder-fits', `"${ph.text}" ${ph.textW}px in ${ph.avail}px`, ph.textW <= ph.avail);

      // 4. Facts per result card. The card's own rule is that showing twelve
      //    facts shows none of them, so this is the number that rule is about.
      /*
       * Rows of type on a card, not text nodes.
       *
       * Counting text nodes counted `{x} of {y}` as three, so a template with
       * two interpolations scored the same as three separate facts. What a
       * reader parses is LINES, so this buckets every text node by the y of the
       * box it sits in: one bucket is one row of information, whatever it took
       * to build. Eight is the budget — image, seller, locality, product,
       * chips, price, the delivered line, and one meta row.
       */
      const facts = await page.evaluate(() => {
        const card = document.querySelector('article.glass-card');
        if (!card) return null;
        // TreeWalker rather than a recursive helper: esbuild names inner
        // functions and the injected __name shim does not exist in the page.
        const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        const spans: Array<[number, number]> = [];
        while (w.nextNode()) {
          const t = w.currentNode;
          if ((t.textContent ?? '').trim().length < 2) continue;
          const rng = document.createRange();
          rng.selectNodeContents(t);
          const r = rng.getBoundingClientRect();
          // Screen-reader-only text is clipped to a pixel. It is not a row.
          if (r.height === 0 || r.width <= 1) continue;
          spans.push([r.top, r.bottom]);
        }
        // A row is a band of the card, so overlapping boxes are ONE row:
        // "₹286.20" is 38 px type and "/bag" is 13 px sitting on its baseline,
        // and bucketing by top counted them as two rows when a reader sees one.
        spans.sort((a, b) => a[0] - b[0]);
        let rows = 0;
        let end = -Infinity;
        for (const [top, bottom] of spans) {
          if (top >= end) { rows++; end = bottom; }
          else end = Math.max(end, bottom);
        }
        return rows;
      });
      if (facts != null) add(v.name, p, 'card-rows', String(facts), facts <= 8);

      // 5. Native controls render as OS widgets and break a dark theme.
      const native = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select, input[type=checkbox]'))
          .filter((el) => {
            const a = getComputedStyle(el).appearance;
            return a !== 'none';
          })
          .map((el) => el.tagName.toLowerCase() + (el.getAttribute('type') ? `[${el.getAttribute('type')}]` : ''))
      );
      add(v.name, p, 'unskinned-native', native.length ? Array.from(new Set(native)).join(', ') : 'none', native.length === 0);

      // 6. Tap targets below 44px on a phone.
      if (v.width < 768) {
        const small = await page.evaluate(() => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll('button, a[href], input, select'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed' && r.top > innerHeight) continue;
            // WCAG 2.5.8 exempts a link sitting inside a run of text — the
            // target is the sentence's line box, and padding one out to 32 px
            // would break the paragraph it belongs to.
            if (cs.display === 'inline' && el.tagName === 'A') continue;
            // A checkbox is hit through its label. Where the label is the
            // target and it is big enough, the 16 px box inside it is the
            // indicator, not the control.
            if (el.tagName === 'INPUT') {
              const lab = el.closest('label');
              if (lab && lab.getBoundingClientRect().height >= 32) continue;
            }
            if (r.height < 32) {
              const label = (el.textContent ?? '').trim().slice(0, 18) || el.getAttribute('aria-label')?.slice(0, 18) || el.tagName;
              out.push(`${label}:${Math.round(r.height)}`);
            }
          }
          return Array.from(new Set(out)).slice(0, 5);
        });
        add(v.name, p, 'tap<32px', small.length ? small.join(', ') : 'none', small.length === 0);
      }
    }
    await ctx.close();
  }
  await browser.close();

  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  let fails = 0;
  let lastKey = '';
  for (const r of rows) {
    const key = `${r.view} ${r.path}`;
    if (key !== lastKey) { console.log(`\n${key}`); lastKey = key; }
    if (!r.ok) fails++;
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${pad(r.metric, 20)} ${r.value}`);
  }
  console.log(`\n${rows.length - fails}/${rows.length} checks pass`);
  process.exit(fails > 0 ? 1 : 0);
})();
