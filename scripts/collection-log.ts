/**
 * data/logs/collection-<date>.md
 *
 * Records sources hit, offers captured, how many fields landed on each rung of
 * the missing-data ladder, and everything that failed — with an estimate of the
 * volume missed. A quiet cap reads as "we covered everything" when we didn't,
 * so every bound on the work is written down here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../lib/db';
import type { SourceResult } from '../collector/types';
import { CATEGORIES, CATEGORY_LABEL } from '../lib/types';

const ROOT = process.cwd();

export interface RunTotals {
  sourcesAttempted: number; sourcesOk: number; sourcesBlocked: number;
  /**
   * Every outcome, not just ok and the blocked family. The headline used to
   * report only those two, so `empty`, `parse_fail` and `skipped` rows were
   * attempted and then vanished from the arithmetic — which is how a source
   * that was returning 500 KB and parsing to nothing stayed invisible.
   */
  byOutcome?: Record<string, number>;
  offersCaptured: number; offersNew: number; vendorsNew: number; noPrice: number;
  ladder: { quoted: number; derived: number; typical: number; unknown: number };
  skipped: Record<string, number>;
}

const FLOOR = { offers: 25, brands: 6, platforms: 4 };

export function writeCollectionLog(runId: string, t: RunTotals, results: SourceResult[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `collection-${date}.md`);

  const coverage = prep(`
    SELECT p.category, o.region_id,
           COUNT(*) AS offers,
           COUNT(DISTINCT o.vendor_id) AS vendors,
           COUNT(DISTINCT p.brand) AS brands,
           COUNT(DISTINCT o.platform) AS platforms,
           MIN(pc.normalised_paise) AS lo, MAX(pc.normalised_paise) AS hi
      FROM offer o
      JOIN product p ON p.product_id = o.product_id
      LEFT JOIN price_current pc ON pc.product_id=o.product_id AND pc.region_id=o.region_id
     WHERE o.is_active=1
     GROUP BY p.category, o.region_id`).all() as any[];

  const L: string[] = [];
  L.push(`# Collection log — ${date}`);
  L.push('');
  L.push(`Run \`${runId}\`. Every figure below is measured from this run, not estimated after the fact.`);
  L.push('');

  L.push('## Coverage against the floor');
  L.push('');
  L.push('The brief sets a floor of ≥25 offers per category per city, ≥6 brands and ≥4 platforms — a check');
  L.push('against under-collection, never a target to stop at. Nothing was capped to reach it.');
  L.push('');
  L.push('| Category | City | Offers | Vendors | Brands | Platforms | ₹ range (per canonical unit) | Floor |');
  L.push('|---|---|---:|---:|---:|---:|---|---|');
  for (const c of CATEGORIES) {
    for (const rg of ['hyderabad', 'vijayawada']) {
      const r = coverage.find((x) => x.category === c && x.region_id === rg);
      if (!r) {
        L.push(`| ${CATEGORY_LABEL[c]} | ${rg} | 0 | 0 | 0 | 0 | — | **below floor** |`);
        continue;
      }
      const pass = r.offers >= FLOOR.offers && r.brands >= FLOOR.brands && r.platforms >= FLOOR.platforms;
      const partial = r.offers >= FLOOR.offers;
      const range = r.lo != null ? `₹${(r.lo / 100).toFixed(2)} – ₹${(r.hi / 100).toFixed(2)}` : '—';
      L.push(`| ${CATEGORY_LABEL[c]} | ${rg} | ${r.offers} | ${r.vendors} | ${r.brands} | ${r.platforms} | ${range} | ${pass ? 'met' : partial ? 'offers met; brands/platforms short' : '**below floor**'} |`);
    }
  }
  L.push('');

  L.push('## The missing-data ladder');
  L.push('');
  L.push('Applied in order, never skipping to invention. Counts are provenance rows written this run.');
  L.push('');
  const total = t.ladder.quoted + t.ladder.derived + t.ladder.typical + t.ladder.unknown || 1;
  L.push('| Rung | Meaning | Fields | Share |');
  L.push('|---|---|---:|---:|');
  L.push(`| 1 \`quoted\` | the value the source published | ${t.ladder.quoted} | ${((t.ladder.quoted / total) * 100).toFixed(1)}% |`);
  L.push(`| 2 \`derived\` | computed from other captured fields, arithmetic kept | ${t.ladder.derived} | ${((t.ladder.derived / total) * 100).toFixed(1)}% |`);
  L.push(`| 3 \`typical\` | representative value, badged TYPICAL in the UI | ${t.ladder.typical} | ${((t.ladder.typical / total) * 100).toFixed(1)}% |`);
  L.push(`| 4 \`unknown\` | "Not published by seller", with a link to the page | ${t.ladder.unknown} | ${((t.ladder.unknown / total) * 100).toFixed(1)}% |`);
  L.push('');

  L.push('## What was collected');
  L.push('');
  L.push(`- Sources attempted: **${t.sourcesAttempted}** · succeeded **${t.sourcesOk}** · blocked or walled **${t.sourcesBlocked}**`);
  if (t.byOutcome) {
    const parts = Object.entries(t.byOutcome).sort((a, b) => b[1] - a[1]).map(([k, n]) => `\`${k}\` ${n}`);
    const counted = Object.values(t.byOutcome).reduce((a, b) => a + b, 0);
    L.push(`- Every outcome, so the arithmetic closes: ${parts.join(' · ')} — **${counted}** of ${t.sourcesAttempted} attempted.`);
    if (t.byOutcome.parse_fail) {
      L.push(`  - \`parse_fail\` means the source answered with a substantial page and our parser matched nothing in it. That is a defect on this side, not an absent market, and it is listed separately from \`empty\` for exactly that reason.`);
    }
  }
  L.push(`- Offers captured: **${t.offersCaptured}** (new this run: ${t.offersNew}) · new vendors: **${t.vendorsNew}**`);
  L.push(`- Listings carrying **no published price**: **${t.noPrice}**. These were counted and discarded, never given a number.`);
  L.push('');

  if (Object.keys(t.skipped).length) {
    L.push('### Captured but not loaded');
    L.push('');
    L.push('Rows the collector refused rather than guessed at. Each is a deliberate refusal to invent.');
    L.push('');
    L.push('| Count | Reason |');
    L.push('|---:|---|');
    for (const [k, v] of Object.entries(t.skipped).sort((a, b) => b[1] - a[1])) L.push(`| ${v} | ${k} |`);
    L.push('');
  }

  // ── the honest part ────────────────────────────────────────────────────────
  const bounded = results.filter(
    (r) => r.estimated_missed != null || ['blocked', 'rate_limited', 'login_wall', 'captcha', 'skipped', 'parse_fail'].includes(r.outcome),
  );
  L.push('## Where the work was bounded — what was skipped and roughly how much');
  L.push('');
  if (!bounded.length) {
    L.push('Nothing bounded this run.');
  } else {
    const totalMissed = bounded.reduce((s, r) => s + (r.estimated_missed ?? 0), 0);
    L.push(`**Estimated listings not captured this run: ~${totalMissed}.** Each row states why.`);
    L.push('');
    L.push('| Source | Class | Category / city | Outcome | Est. missed | What happened |');
    L.push('|---|---|---|---|---:|---|');
    const seen = new Set<string>();
    for (const r of bounded) {
      const key = `${r.source_id}|${r.outcome}|${r.note?.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      L.push(`| \`${r.source_id}\` | ${r.source_class} | ${r.category ?? '—'} / ${r.region_id ?? '—'} | **${r.outcome}** | ${r.estimated_missed ?? '—'} | ${(r.note ?? '').replace(/\|/g, '\\|')} |`);
    }
  }
  L.push('');

  L.push('## Sources that worked');
  L.push('');
  const ok = results.filter((r) => r.outcome === 'ok' && r.offers.length > 0);
  const byClass = new Map<string, { n: number; offers: number }>();
  for (const r of ok) {
    const c = byClass.get(r.source_class) ?? { n: 0, offers: 0 };
    c.n++; c.offers += r.offers.length;
    byClass.set(r.source_class, c);
  }
  L.push('| Source class | Endpoints | Offers |');
  L.push('|---|---:|---:|');
  for (const [k, v] of byClass) L.push(`| ${k} | ${v.n} | ${v.offers} |`);
  L.push('');

  L.push('## Government anchor');
  L.push('');
  const sor = prep(`SELECT * FROM sor_rate ORDER BY state_code, category`).all() as any[];
  if (!sor.length) L.push('No government reference resolved this run.');
  for (const s of sor) {
    L.push(`- **${s.state_code} · ${s.category}** — ${s.document}`);
    L.push(`  - period: ${s.effective_period} · source: ${s.source_url}`);
    L.push(`  - ${s.note}`);
  }
  L.push('');

  L.push('## Standing limitations of this build');
  L.push('');
  L.push('1. **The Telangana PRED monthly circulars are scanned image PDFs with no text layer.** The May-2026 issue is 1.5 MB of JPEG streams and yields 23 characters of extractable text. The document is cited as the government reference with its month and URL; the rupee figures inside were not machine-extracted and no rate value has been invented from them. Reading them needs OCR or a manual pass.');
  L.push('2. **Andhra Pradesh publishes no current Schedule of Rates.** Newest verifiable edition is 2018-19; APSPDCL electrical SSR is 2020-21. Vijayawada therefore has no in-state government price anchor and the Telangana series is shown as an explicitly cross-border cross-check. This is spec assumption A-07.');
  L.push('3. **Marketplaces and most regional platforms refuse a scripted client.** Amazon returns 503, BigBMart and BuildersMART serve browser challenges, Justdial returns a 30-byte body, Moglix and Infra.Market serve a JS wall. Their data reaches the store only through a browser-assisted pass, which the unattended scheduled job cannot perform — so those rows age and are flagged rather than silently refreshed.');
  L.push('4. **BIS licence numbers are almost never published on a listing.** `BRAND_LICENSED` records the honest middle state: the manufacturer holds a licence for the IS code but this listing does not quote its number. It is not the same claim as `CERTIFIED`, and it is not treated as one.');
  L.push('5. **The platform floor is the one guardrail still unmet.** The target is four independent platforms per category; the coverage table above shows what was actually reached. Amazon, Flipkart, Meesho, JioMart, Moglix, BuildersMART and Infra.Market are each recorded above with the reason they refused and an estimate of what sits behind them — every one is a browser challenge or a JS wall rather than an absence of stock. Breadth here is limited by what a scripted client can reach, and the shortfall is reported rather than papered over by counting one platform twice.');
  L.push('6. **TradeIndia has never returned a single offer, and the URL is why.** Its template hardcodes a numeric city id — `{city}/{slug}-city-183463.html` — that never varies by category or by city, so all eight combinations fetch the same ~21 KB soft-404 page; probed 2026-08-01, byte-identical for `vijayawada/bricks` and `hyderabad/cement`. It is left in the sweep so the attempt stays on the record, and it now reports `parse_fail` rather than `empty` so it reads as our defect rather than as an empty market. Fixing it needs URL discovery and a parser of its own, and is not done.');
  L.push('7. **ExportersIndia prices are frequently quoted as a range, and the low bound is what is loaded.** A listing reading `Rs 24 - Rs 28 Per Piece` is stored at ₹24 with the full range kept verbatim in `specs["Quoted price range"]` and the original string in `price_text`. The low bound is a figure the seller actually printed; a midpoint would not be, and this build does not publish a number nobody quoted. Read the ranked price on those rows as "from".');
  L.push('');

  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}
