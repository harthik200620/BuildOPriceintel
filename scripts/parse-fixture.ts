/**
 * Parse a saved page and show exactly what would be loaded from it — with no
 * network call at all.
 *
 * The second half is the point. Extracting cards proves the selectors work;
 * running every card through `normalise()` proves the offers actually survive
 * the category guard, the unit map and the canonical-unit conversion. A parser
 * that yields 40 rows which all get refused at load time has fixed nothing, and
 * without this you would not find that out until after a live sweep.
 *
 *   npx tsx scripts/parse-fixture.ts collector/fixtures/exportersindia-vijayawada-bricks-2026-08-01.html vijayawada bricks_blocks
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCards, pageMeta } from '../collector/sources/exportersindia';
import { normalise } from '../collector/normalize';

const [file, region = 'vijayawada', category = 'bricks_blocks'] = process.argv.slice(2);
if (!file) {
  console.error('usage: npx tsx scripts/parse-fixture.ts <fixture.html> [region] [category]');
  process.exit(2);
}

const html = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
const meta = pageMeta(html);
const offers = parseCards(html, `file://${file}`, category, region);

console.log(`${path.basename(file)}  (${html.length.toLocaleString()} bytes)`);
console.log(`declared: ttl_records=${meta.ttlRecords} ttl_pages=${meta.ttlPages} solr=${meta.solrRandNo ?? '-'}`);
console.log(`parsed:   ${offers.length} distinct listings\n`);

const w = (s: unknown, n: number) => String(s ?? '-').slice(0, n).padEnd(n);
for (const o of offers) {
  console.log(
    `${w(o.source_ref, 14)} ${w(o.title, 44)} ${w(o.vendor_name, 26)} ` +
    `${w(o.price_paise != null ? (o.price_paise / 100).toFixed(2) : '—', 9)} ` +
    `${w(o.price_unit, 10)} ${w(o.moq_text, 14)} ${w(o.vendor_locality ?? '(no address published)', 22)}`,
  );
}

const priced = offers.filter((o) => o.price_paise != null);
console.log(`\npriced ${priced.length} · no price ${offers.length - priced.length} · ` +
  `vendors ${new Set(offers.map((o) => o.vendor_name)).size} · ` +
  `with specs ${offers.filter((o) => Object.keys(o.specs).length).length} · ` +
  `with images ${offers.filter((o) => o.images?.length).length} · ` +
  `ranges ${offers.filter((o) => o.specs['Quoted price range']).length}`);

// The load-bearing half: would these actually load?
const reasons: Record<string, number> = {};
const units: Record<string, number> = {};
let ok = 0;
for (const o of priced) {
  const r = normalise(o) as any;
  if (r.ok === false) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  else {
    ok++;
    const k = `${r.unit_trade} -> ${r.unit_canonical}`;
    units[k] = (units[k] ?? 0) + 1;
  }
}
console.log(`\nnormalise: ok ${ok} · refused ${priced.length - ok}`);
for (const [k, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}x ${k}`);
}
console.log(`units: ${JSON.stringify(units)}`);
