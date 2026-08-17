/**
 * Rebuild the price surface from the offers already stored — no network.
 *
 * Runs the plausibility pass (lib/plausibility.ts, applied by lib/rebuild.ts),
 * then the freight/GST/landed computation, the absurdity gate, and the search
 * index. Prints what the rules took out and, per category and region, where
 * the surface now starts, sits and ends — the figures the catalogue cards and
 * the listing headings show.
 *
 *   npm run rebuild
 */
import { initSchema, prep } from '../lib/db';
import { rebuildPrices, rebuildSearchIndex } from '../lib/rebuild';
import { median } from '../lib/money';

function surface() {
  const rows = prep(`
    SELECT p.category, op.region_id, op.normalised_paise
      FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id JOIN product p ON p.product_id = op.product_id
     WHERE o.is_active = 1`).all() as Array<{ category: string; region_id: string; normalised_paise: number }>;
  const m = new Map<string, number[]>();
  for (const r of rows) (m.get(`${r.category}|${r.region_id}`) ?? m.set(`${r.category}|${r.region_id}`, []).get(`${r.category}|${r.region_id}`)!).push(r.normalised_paise);
  return m;
}
const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;

function print(label: string, m: Map<string, number[]>) {
  console.log(`\n${label}`);
  for (const k of [...m.keys()].sort()) {
    const v = m.get(k)!.sort((a, b) => a - b);
    console.log(`  ${k.padEnd(26)} n=${String(v.length).padStart(4)}  lo ${rs(v[0]).padStart(9)}  median ${rs(median(v)).padStart(9)}  hi ${rs(v[v.length - 1]).padStart(9)}`);
  }
}

initSchema();
const before = surface();
const runId = `rebuild_${Date.now().toString(36)}`;
const pr = rebuildPrices(runId, 'backfill');
const indexed = rebuildSearchIndex();

console.log(`price_current ${pr.rows} rows over ${pr.products} (product,region) pairs; offer_price ${pr.offerRows} rows; index ${indexed} products`);
if (pr.implausible.length) {
  const n = pr.implausible.reduce((s, r) => s + r.count, 0);
  console.log(`\nplausibility rules took ${n} offer(s) out of the surface — kept, inactive, reason on the row:`);
  for (const r of pr.implausible) console.log(`  ${String(r.count).padStart(4)}× ${r.reason}\n        e.g. ${r.examples.map((e) => `"${e}"`).join(' · ')}`);
}
if (pr.quarantined.length) {
  console.log(`\nabsurdity gate quarantined ${pr.quarantined.length} price(s) outside [0.1x, 10x] of their category median — never published:`);
  for (const q of pr.quarantined.slice(0, 10)) console.log(`  ${rs(q.paise)} vs median ${rs(q.median)} (${q.ratio}×) — ${q.key}`);
}
print('before — the surface as it was', before);
print('after  — the surface now', surface());
