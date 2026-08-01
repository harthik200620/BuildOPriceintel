/**
 * Summarise the reconciled filter trees: which facets have real data behind
 * them, which ship disabled, and why.
 *
 * The README quotes these counts, and a facet shipping disabled is the thing
 * most worth reading in the whole reconciliation — it is where the catalogue
 * does not support a filter the category design asked for.
 *
 *   npx tsx scripts/filters-report.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const FILES = ['cement.json', 'tmt-steel.json', 'water-pipes.json', 'bricks-blocks.json'];

for (const f of FILES) {
  const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'filters', f), 'utf8'));
  const on = s.filters.filter((x: any) => x.data_backed);
  const off = s.filters.filter((x: any) => !x.data_backed);
  console.log(`\n${s.category} — ${s.result_count} offers · ${on.length} data-backed · ${off.length} disabled`);

  const brand = s.filters.find((x: any) => (x.facet_key ?? x.id) === 'product.brand');
  if (brand) console.log(`  brand: ${brand.values.map((v: any) => `${v.label}(${v.count})`).join(', ')}`);
  const price = s.filters.find((x: any) => (x.facet_key ?? x.id) === 'price_current.normalised_paise');
  if (price) console.log(`  price: ${price.values.map((v: any) => `${v.label} (${v.count})`).join(' · ')}`);

  for (const x of off) {
    console.log(`  ✗ ${String(x.id).padEnd(22)} ${String(x.no_data_reason ?? '').slice(0, 118)}`);
  }
}
console.log('');
