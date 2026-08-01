/**
 * Surface candidate brand tokens from collected listing titles for one category.
 *
 * This does not decide anything — it lists capitalised tokens the roster does
 * not already know, with how often they occur and one example title each, so a
 * human can tell a real brand from a place name, a size or a material word.
 * The roster is edited by hand afterwards; nothing here writes.
 *
 *   npx tsx scripts/mine-brands.ts bricks_blocks
 */
import { prep, close } from '../lib/db';

const category = process.argv[2] ?? 'bricks_blocks';
// Brands already resolved for this category — read from the data rather than
// imported, so this stays useful whatever the roster currently holds.
const known = new Set(
  (prep(`SELECT DISTINCT brand FROM product WHERE category = ? AND brand IS NOT NULL`)
    .all(category) as Array<{ brand: string }>)
    .flatMap((r) => r.brand.toLowerCase().split(/\s+/)),
);

// Words that are materials, shapes, sizes, units or trade boilerplate rather
// than brands. Filtering these is what makes the remaining list readable.
const STOP = new Set(`bricks brick block blocks red clay fly ash aac concrete cement solid hollow
  lightweight light weight size for wall walls partition side load bearing thermo cellular
  rectangular square inch inches in mm cm x grade type white grey gray brown yellow black
  and the of with per piece pieces nos no building construction material materials industrial
  interlocking paver pavers cladding facing face exposed wire cut wirecut table moulded machine
  made refractory fire acid alkali resistant quality premium super best new used m3 sq ft
  autoclaved aerated aerocon standard heavy duty double triple single first class`.split(/\s+/));

const rows = prep(
  `SELECT o.listing_title AS t FROM offer o JOIN product p ON p.product_id = o.product_id
    WHERE p.category = ? AND o.listing_title IS NOT NULL`,
).all(category) as Array<{ t: string }>;

const hits = new Map<string, { n: number; eg: string }>();
for (const { t } of rows) {
  for (const m of t.matchAll(/\b([A-Z][A-Za-z]{2,})\b/g)) {
    const w = m[1];
    const lw = w.toLowerCase();
    if (STOP.has(lw) || known.has(lw)) continue;
    if (/^\d/.test(w)) continue;
    const cur = hits.get(w) ?? { n: 0, eg: t };
    cur.n++;
    hits.set(w, cur);
  }
}

console.log(`${rows.length} titles in ${category}; unknown capitalised tokens by frequency:\n`);
for (const [w, v] of [...hits.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40)) {
  console.log(`${String(v.n).padStart(3)}x  ${w.padEnd(18)} ${v.eg.slice(0, 70)}`);
}
close();
