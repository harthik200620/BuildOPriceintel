/**
 * What only exists once something has been laid out.
 *
 * `npm test` guards the facts that are true without a renderer — the metrics
 * contract, the subset contract, the shape of globals.css. It cannot see a
 * clipped cell, because jsdom has no layout: getBoundingClientRect returns
 * zeros and no font is ever loaded. This is the other half.
 *
 * Five failures, all of which are silent in a screenshot:
 *
 *   1. A cell that started ellipsing. `.truncate` hides its own overflow, so
 *      the text simply gets shorter and nothing reports it.
 *   2. A price that wrapped or spilled. The money cells sit in fixed widths
 *      with no overflow clip, so an over-wide value paints across its
 *      neighbour rather than being caught.
 *   3. A `shrink-0` box that grew. `min-width: auto` on a flex item means an
 *      unbreakable token makes the box exceed its declared width and push its
 *      siblings — there is no overflow, so scrollWidth never fires.
 *   4. An SVG label crossing the chart band. SVG text does not reflow.
 *   5. The detail sheet's height drifting, which is what reframes screenshot 05.
 *
 *   npm run probe:type            write screenshots/typography-baseline.json
 *   npm run probe:type -- --check compare against it
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
const OUT = path.join(process.cwd(), 'screenshots', 'typography-baseline.json');
const CHECK = process.argv.includes('--check');
const VIEWPORT = { width: 1512, height: 950 };

interface Report {
  clipped: Record<string, number>;      // key -> scrollWidth - clientWidth
  wrapped: string[];                    // money spans occupying >1 client rect
  spilled: string[];                    // money spans painting outside their cell
  boxes: Record<string, number>;        // declared-width element -> rendered width
  svg: { hiBottom: number; bandTop: number; loTop: number; bandBottom: number } | null;
  sheetScrollHeight: number;
}

const settle = (p: Page, ms = 700) => p.waitForTimeout(ms);

/**
 * The body runs in the page, so it deliberately contains no named inner
 * functions: the bundler rewrites those with a `__name` helper that does not
 * exist on the other side of the serialisation boundary.
 */
async function measure(page: Page): Promise<Report> {
  return page.evaluate(() => {
    const clipped: Record<string, number> = {};
    const wrapped: string[] = [];
    const spilled: string[] = [];
    const boxes: Record<string, number> = {};

    // 1. anything that ellipses, plus the fixed-width table headers
    let i = 0;
    for (const el of Array.from(document.querySelectorAll('.truncate, [aria-sort]'))) {
      const key = (el.className.toString().split(' ')[0] || el.tagName.toLowerCase())
        + '#' + i++ + ':' + (el.textContent ?? '').trim().slice(0, 22).replace(/\s+/g, ' ');
      const over = el.scrollWidth - el.clientWidth;
      if (over > 0.5) clipped[key] = Math.round(over * 10) / 10;
    }

    // 2. money that wrapped, or painted outside the cell it belongs to
    let j = 0;
    for (const el of Array.from(document.querySelectorAll('.fig, .hero-figure, .tnum'))) {
      const key = (el.className.toString().split(' ')[0] || el.tagName.toLowerCase())
        + '#' + j++ + ':' + (el.textContent ?? '').trim().slice(0, 22).replace(/\s+/g, ' ');
      if (el.getClientRects().length > 1) wrapped.push(key);
      const cell = el.closest('[style*="width"]') as HTMLElement | null;
      if (!cell) continue;
      const a = el.getBoundingClientRect();
      const b = cell.getBoundingClientRect();
      const cs = getComputedStyle(cell);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      if (a.left < b.left + padL - 0.5 || a.right > b.right - padR + 0.5) spilled.push(key);
    }

    // 3. shrink-0 boxes that grew past their declared width. No overflow is
    //    produced, so scrollWidth cannot see this one.
    const declared: Array<[string, number]> = [
      ['.w-8', 32], ['.w-4', 16], ['.w-\\[150px\\]', 150], ['.w-\\[190px\\]', 190], ['.w-\\[230px\\]', 230],
    ];
    for (const pair of declared) {
      let k = 0;
      for (const el of Array.from(document.querySelectorAll(pair[0]))) {
        const got = el.getBoundingClientRect().width;
        if (Math.abs(got - pair[1]) > 0.5) boxes[pair[0] + '#' + k] = Math.round(got * 10) / 10;
        k++;
      }
    }

    return { clipped, wrapped, spilled, boxes, svg: null, sheetScrollHeight: 0 } as Report;
  });
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark' });
  const page = await ctx.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await settle(page, 3000);

  // Cards first — and the sheet has to be opened from here, because the table
  // view has no <article> to click.
  const grid = await measure(page);

  // The sheet carries the spec labels, the chart, and the height that frames
  // screenshot 05.
  let sheet: Report | null = null;
  let svg: Report['svg'] = null;
  let sheetH = 0;
  const card = page.locator('article').first();
  if (await card.count()) {
    await card.click();
    await page.locator('[role="dialog"]').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    await settle(page, 2200);
    sheet = await measure(page);
    const r = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]') as HTMLElement | null;
      // Scoped to the chart's own <svg>. A document-wide 'svg rect' picks up
      // the TopBar wordmark's 19x19 plot square instead, and then compares the
      // price label against a logo.
      const chart = Array.from(document.querySelectorAll('svg')).find((s) => s.querySelector('text'));
      const texts = chart ? (Array.from(chart.querySelectorAll('text')) as SVGTextElement[]) : [];
      const band = chart ? (chart.querySelector('rect') as SVGRectElement | null) : null;
      if (!band || texts.length < 2) return { svg: null, h: dlg?.scrollHeight ?? 0 };
      const hi = texts[0].getBBox(), lo = texts[1].getBBox(), bb = band.getBBox();
      return {
        svg: { hiBottom: +(hi.y + hi.height).toFixed(2), bandTop: +bb.y.toFixed(2),
               loTop: +lo.y.toFixed(2), bandBottom: +(bb.y + bb.height).toFixed(2) },
        h: dlg?.scrollHeight ?? 0,
      };
    });
    svg = r.svg; sheetH = r.h;
    await page.keyboard.press('Escape');
    await settle(page, 600);
  }

  const toTable = page.getByRole('button', { name: 'Table' });
  if (await toTable.count()) { await toTable.click(); await settle(page, 1200); }
  const table = await measure(page);

  const report: Report = {
    clipped: { ...grid.clipped, ...table.clipped, ...(sheet?.clipped ?? {}) },
    wrapped: [...grid.wrapped, ...table.wrapped, ...(sheet?.wrapped ?? [])],
    spilled: [...grid.spilled, ...table.spilled, ...(sheet?.spilled ?? [])],
    boxes: { ...grid.boxes, ...table.boxes, ...(sheet?.boxes ?? {}) },
    svg,
    sheetScrollHeight: sheetH,
  };

  await browser.close();

  console.log(`\nclipped   ${Object.keys(report.clipped).length}`);
  for (const [k, v] of Object.entries(report.clipped).slice(0, 12)) console.log(`   ${v}px  ${k}`);
  console.log(`wrapped   ${report.wrapped.length}${report.wrapped.length ? '  ' + report.wrapped.slice(0, 6).join(' · ') : ''}`);
  console.log(`spilled   ${report.spilled.length}${report.spilled.length ? '  ' + report.spilled.slice(0, 6).join(' · ') : ''}`);
  console.log(`grown     ${Object.keys(report.boxes).length}`);
  for (const [k, v] of Object.entries(report.boxes).slice(0, 8)) console.log(`   ${v}px  ${k}`);
  if (report.svg) {
    const okHi = report.svg.hiBottom <= report.svg.bandTop;
    const okLo = report.svg.loTop >= report.svg.bandBottom;
    console.log(`chart     hi ${report.svg.hiBottom} vs band ${report.svg.bandTop} ${okHi ? 'clear' : 'OVERLAPS'} · ` +
                `lo ${report.svg.loTop} vs ${report.svg.bandBottom} ${okLo ? 'clear' : 'OVERLAPS'}`);
  }
  console.log(`sheet     scrollHeight ${report.sheetScrollHeight}`);

  if (!CHECK) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nbaseline written → ${path.relative(process.cwd(), OUT)}`);
    return;
  }

  if (!fs.existsSync(OUT)) { console.error('\nno baseline; run without --check first'); process.exit(2); }
  const base: Report = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  const fail: string[] = [];

  // Deltas, not absolutes — several headers already ellipse, so an absolute
  // rule would fail on day one and be ignored within a week.
  for (const [k, v] of Object.entries(report.clipped)) {
    const was = base.clipped[k];
    if (was === undefined) fail.push(`newly clipped: ${k} (+${v}px)`);
    else if (v > was + 2) fail.push(`clipping worse: ${k} ${was} → ${v}px`);
  }
  // These three are absolute: none of them happens at baseline, and each is a
  // wrong price rather than a shorter one.
  for (const k of report.wrapped) if (!base.wrapped.includes(k)) fail.push(`wrapped: ${k}`);
  for (const k of report.spilled) if (!base.spilled.includes(k)) fail.push(`spilled past its cell: ${k}`);
  for (const [k, v] of Object.entries(report.boxes)) if (base.boxes[k] === undefined) fail.push(`grew past declared width: ${k} → ${v}px`);
  if (report.svg && report.svg.hiBottom > report.svg.bandTop) fail.push('chart high label overlaps the plot band');
  if (report.svg && report.svg.loTop < report.svg.bandBottom) fail.push('chart low label overlaps the plot band');
  const drift = base.sheetScrollHeight ? Math.abs(report.sheetScrollHeight - base.sheetScrollHeight) / base.sheetScrollHeight : 0;
  if (drift > 0.02) fail.push(`sheet height drifted ${(drift * 100).toFixed(1)}% — screenshot 05 will reframe`);

  console.log(`\n${fail.length ? 'FAIL' : 'PASS'} — ${fail.length} regression(s)`);
  for (const f of fail) console.log(`  · ${f}`);
  process.exit(fail.length ? 1 : 0);
}

main();
