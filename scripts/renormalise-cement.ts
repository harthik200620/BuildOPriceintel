/**
 * Re-derive cement canonical prices against the standard 50 kg bag.
 *
 * The collector used to pass a per-bag quote straight through as the canonical
 * price, which treated "bag" as dimensionless: a ₹150 quote for a 1 kg pack
 * became ₹150 per canonical bag and outranked every real 50 kg bag in the city.
 * normalize.ts now routes cement through cementCanonicalPaise(); this brings
 * rows already in the database onto the same rule rather than requiring a
 * re-fetch of every listing.
 *
 * It recomputes from the stored quote — base_paise and base_unit are exactly
 * what the seller published — so nothing here is invented. Offers whose unit
 * cannot be converted are left untouched and reported.
 *
 *   npx tsx scripts/renormalise-cement.ts [--apply]
 *
 * Without --apply it prints what would change and writes nothing.
 */
import { db, prep, initSchema } from '../lib/db';
import { cementCanonicalPaise, CEMENT_STANDARD_BAG_KG } from '../lib/units';
import { rebuildPrices, rebuildSearchIndex } from '../lib/rebuild';

const APPLY = process.argv.includes('--apply');

interface Row {
  offer_id: string; title: string; base_paise: number; base_unit: string;
  base_paise_canonical: number; pack_kg: number | null; unit_weight_kg: number | null;
}

function main() {
  initSchema();

  const rows = prep(`
    SELECT o.offer_id, p.title, o.base_paise, o.base_unit, o.base_paise_canonical,
           json_extract(p.attrs, '$.pack_size_kg') AS pack_kg, p.unit_weight_kg
      FROM offer o JOIN product p ON p.product_id = o.product_id
     WHERE p.category = 'cement'`).all() as Row[];

  const changes: Array<{ r: Row; to: number; note: string }> = [];
  const unconvertible: Row[] = [];

  for (const r of rows) {
    const conv = cementCanonicalPaise(r.base_paise, r.base_unit, r.pack_kg);
    if (!conv) { unconvertible.push(r); continue; }
    if (conv.paise !== r.base_paise_canonical) changes.push({ r, to: conv.paise, note: conv.note });
  }

  console.log(`cement offers: ${rows.length}`);
  console.log(`canonical price changes: ${changes.length}`);
  console.log(`unconvertible units (left untouched): ${unconvertible.length}` +
    (unconvertible.length ? ` — ${[...new Set(unconvertible.map((u) => u.base_unit))].join(', ')}` : ''));

  const shown = changes
    .map((c) => ({ ...c, ratio: c.to / Math.max(1, c.r.base_paise_canonical) }))
    .sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)))
    .slice(0, 12);

  if (shown.length) {
    console.log('\nlargest corrections:');
    for (const c of shown) {
      console.log(`  ${(c.r.title || '').slice(0, 46).padEnd(48)} ` +
        `₹${(c.r.base_paise_canonical / 100).toFixed(2)} → ₹${(c.to / 100).toFixed(2)}   ${c.note}`);
    }
  }

  const weightWrong = rows.filter((r) => r.unit_weight_kg !== CEMENT_STANDARD_BAG_KG).length;
  console.log(`\nproducts whose unit_weight_kg is not the ${CEMENT_STANDARD_BAG_KG} kg canonical bag: ${weightWrong}`);

  if (!APPLY) {
    console.log('\ndry run — nothing written. re-run with --apply');
    return;
  }

  const D = db();
  const upd = D.prepare(`UPDATE offer SET base_paise_canonical = ? WHERE offer_id = ?`);
  const updW = D.prepare(`UPDATE product SET unit_weight_kg = ? WHERE category = 'cement'`);
  D.transaction(() => {
    for (const c of changes) upd.run(c.to, c.r.offer_id);
    updW.run(CEMENT_STANDARD_BAG_KG);
  })();

  console.log(`\napplied ${changes.length} corrections. rebuilding the price surface…`);
  // 'backfill' is the schema's term for a rebuild that re-derives existing
  // rows rather than recording a fresh observation.
  const pr = rebuildPrices(`renorm_${Date.now().toString(36)}`, 'backfill');
  const idx = rebuildSearchIndex();
  console.log(`  price_current ${pr.rows} rows; price_history +${pr.historyRows}; index ${idx} products`);
  if (pr.quarantined.length) {
    console.log(`  absurdity gate quarantined ${pr.quarantined.length} price(s) — never published:`);
    for (const q of pr.quarantined.slice(0, 10)) {
      console.log(`    ₹${(q.paise / 100).toFixed(2)} vs median ₹${(q.median / 100).toFixed(2)} (${q.ratio}×) — ${q.key}`);
    }
  }
}

main();
