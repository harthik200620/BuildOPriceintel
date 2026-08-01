/**
 * Measured fill rate for every column the results table can offer.
 *
 * The table shows each column's coverage in its own header, and the honest
 * matrix in docs/ quotes these numbers. Both are transcribed from this script
 * rather than estimated, because a column that looks empty and a column that IS
 * empty are different facts and only a measurement tells them apart.
 *
 *   npx tsx scripts/field-coverage.ts
 */
import { prep, close } from '../lib/db';

const offers = (prep(`SELECT COUNT(*) c FROM offer`).get() as any).c as number;
const products = (prep(`SELECT COUNT(*) c FROM product`).get() as any).c as number;

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
const row = (label: string, n: number, d: number, note = '') =>
  console.log(`  ${label.padEnd(26)} ${String(n).padStart(5)} / ${d}  ${pct(n, d).padStart(6)}  ${note}`);

console.log(`\nOFFER-LEVEL  (${offers} offers)`);
for (const [label, col] of [
  ['listing_title', 'listing_title'], ['images', 'images'], ['rating', 'rating'],
  ['review_count', 'review_count'], ['moq_qty', 'moq_qty'], ['mrp_paise', 'mrp_paise'],
  ['cert_ref', 'cert_ref'], ['lead_time_days', 'lead_time_days'], ['bulk_slabs', 'bulk_slabs'],
] as string[][]) {
  const n = (prep(`SELECT COUNT(*) c FROM offer WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]'`)
    .get() as any).c as number;
  row(label, n, offers);
}

console.log(`\nPRODUCT-LEVEL  (${products} products)`);
for (const [label, col] of [
  ['brand', 'brand'], ['country_of_origin', 'country_of_origin'], ['image_url', 'image_url'],
  ['cert_standards', 'cert_standards'], ['pack_size', 'pack_size'],
] as string[][]) {
  const n = (prep(`SELECT COUNT(*) c FROM product WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} <> '[]'`)
    .get() as any).c as number;
  row(label, n, products);
}

// attrs keys: json_each reports every key at 100% because the normaliser writes
// explicit nulls, so this counts NON-NULL values only. That distinction is the
// whole point — it is what separates a real column from an empty one.
console.log(`\nATTRS  (non-null values only, per category)`);
const cats = (prep(`SELECT DISTINCT category FROM product ORDER BY category`).all() as any[]).map((r) => r.category);
for (const cat of cats) {
  const total = (prep(`SELECT COUNT(*) c FROM product WHERE category = ?`).get(cat) as any).c as number;
  const keys = prep(`
    SELECT j.key AS k, COUNT(*) AS n
      FROM product p, json_each(p.attrs) j
     WHERE p.category = ? AND j.value IS NOT NULL AND j.value <> ''
     GROUP BY j.key ORDER BY n DESC`).all(cat) as any[];
  console.log(`\n  ${cat} (${total} products)`);
  for (const k of keys) {
    if (k.k === '_blob') continue;
    console.log(`    ${String(k.k).padEnd(24)} ${String(k.n).padStart(4)}  ${pct(k.n, total).padStart(6)}`);
  }
}

console.log(`\nCOUNTRY OF ORIGIN — distinct values (must canonicalise, not sprawl)`);
for (const r of prep(
  `SELECT country_of_origin v, COUNT(*) n FROM product WHERE country_of_origin IS NOT NULL GROUP BY v ORDER BY n DESC`,
).all() as any[]) console.log(`    ${String(r.v).padEnd(24)} ${r.n}`);

console.log(`\nMOQ UNITS — distinct values (six spellings of "Piece" was the bug)`);
for (const r of prep(
  `SELECT moq_unit v, COUNT(*) n FROM offer WHERE moq_unit IS NOT NULL GROUP BY v ORDER BY n DESC`,
).all() as any[]) console.log(`    ${String(r.v).padEnd(24)} ${r.n}`);

console.log('');
close();
