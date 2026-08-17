/**
 * Layout stability and paint timing for the catalogue and a listing, measured
 * in a real browser rather than asserted: CLS from the layout-shift observer,
 * LCP from the largest-contentful-paint observer, and the transfer weight of
 * everything the page pulled.
 *
 *   BUILDOBJECTS_URL=http://localhost:3001 npx tsx scripts/vitals-check.ts
 *
 * Dev-server numbers include Turbopack's HMR client and unminified chunks;
 * the useful figures here are CLS (build-independent) and image weight.
 */
import { chromium } from 'playwright';

const BASE = process.env.BUILDOBJECTS_URL ?? 'http://localhost:3000';
let failures = 0;
const ok = (n: string, c: unknown, d = '') => { console.log(`${c ? '  ok ' : 'FAIL '} ${n}${c || !d ? '' : ` — ${d}`}`); if (!c) failures++; };

(async () => {
  const browser = await chromium.launch();
  for (const [label, vp, dpr] of [['desktop', { width: 1440, height: 900 }, 1], ['phone', { width: 390, height: 844 }, 2]] as const) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dpr, isMobile: label === 'phone', hasTouch: label === 'phone' });
    for (const path of ['/', '/c/cement']) {
      const page = await ctx.newPage();
      const bytes: Record<string, number> = {};
      page.on('response', async (r) => {
        try {
          const t = r.request().resourceType();
          const len = Number(r.headers()['content-length'] ?? 0) || (await r.body().catch(() => Buffer.alloc(0))).length;
          bytes[t] = (bytes[t] ?? 0) + len;
        } catch { /* body unavailable */ }
      });
      await page.addInitScript(() => {
        (window as any).__cls = 0; (window as any).__lcp = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => { const es = l.getEntries(); (window as any).__lcp = (es[es.length - 1] as any).startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      // Let the listing's first fetch land and any late shift register.
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(400);
      const { cls, lcp } = await page.evaluate(() => ({ cls: (window as any).__cls, lcp: (window as any).__lcp }));
      const img = Math.round((bytes.image ?? 0) / 1024);
      const font = Math.round((bytes.font ?? 0) / 1024);
      ok(`${label} ${path}: CLS ${cls.toFixed(4)} (≤ 0.10 is good, ≤ 0.05 excellent)`, cls <= 0.05, cls.toFixed(4));
      ok(`${label} ${path}: LCP ${Math.round(lcp)} ms on the dev server (≤ 2500 good)`, lcp > 0 && lcp <= 2500, `${Math.round(lcp)} ms`);
      console.log(`       images ${img} KB · fonts ${font} KB`);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall vitals checks passed');
  process.exit(failures ? 1 : 0);
})();
