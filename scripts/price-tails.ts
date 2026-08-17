/**
 * The tails of the price surface: the five lowest and four highest published
 * prices per category and region, with the seller's own quote and unit beside
 * the landed figure. Run it after a collection or a rebuild — an outlier here
 * is either a real price or a rule that needs writing.
 *
 *   npx tsx scripts/price-tails.ts
 */
import { prep } from '../lib/db';
const cats = ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'];
for (const cat of cats) {
  for (const region of ['hyderabad', 'vijayawada']) {
    const rows = prep(`
      SELECT op.normalised_paise, op.landed_paise, o.base_paise, o.base_unit, o.base_qty, o.base_paise_canonical, o.trade_multiple,
             o.listing_title, p.title, p.unit_canonical, p.pack_size, p.pack_unit, o.platform, o.source_url, v.name AS vendor, v.city, v.region_id AS vregion,
             op.freight_paise, op.gst_paise
        FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id JOIN product p ON p.product_id = op.product_id JOIN vendor v ON v.vendor_id = op.vendor_id
       WHERE op.region_id = ? AND p.category = ? AND o.is_active = 1
       ORDER BY op.normalised_paise ASC`).all(region, cat) as any[];
    const med = rows[Math.floor(rows.length / 2)]?.normalised_paise ?? 0;
    console.log(`\n=== ${cat} / ${region}: ${rows.length} offers, median ₹${(med/100).toFixed(2)}`);
    const show = (r: any, tag: string) => console.log(`  ${tag} ₹${(r.normalised_paise/100).toFixed(2).padStart(8)} /${r.unit_canonical}  base ₹${(r.base_paise/100).toFixed(2)} per ${r.base_qty} ${r.base_unit} (canon ₹${(r.base_paise_canonical/100).toFixed(2)}, tm ${r.trade_multiple}) freight ₹${(r.freight_paise/100).toFixed(0)} | ${r.platform} ${r.vendor} [${r.city ?? '-'}/${r.vregion}] | "${(r.listing_title ?? '').slice(0, 70)}" -> ${r.title.slice(0, 50)} pack ${r.pack_size ?? ''}${r.pack_unit ?? ''}`);
    rows.slice(0, 5).forEach((r) => show(r, 'LOW '));
    rows.slice(-4).forEach((r) => show(r, 'HIGH'));
  }
}
