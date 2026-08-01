import { NextRequest, NextResponse } from 'next/server';
import { prep } from '@/lib/db';
import { resolveAllOffers, resolvePincode, rollUpByVendor } from '@/lib/price';
import { armNetworkGuard } from '@/lib/no-network';
import { assess } from '@/lib/freshness';
import { CATEGORY_LABEL } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const t0 = performance.now();
  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const pincode = sp.get('pincode') ?? '500001';
  const qty = sp.get('qty') ? Number(sp.get('qty')) : undefined;

  const dest = resolvePincode(pincode);
  if (!dest) return NextResponse.json({ error: 'PINCODE_NOT_SERVICED' }, { status: 404 });

  const product = prep(
    `SELECT product_id, item_code, category, title, brand, attrs, unit_canonical, unit_trade,
            pack_size, pack_unit, unit_weight_kg, hsn, gst_rate_bp, qco_regulated, qco_citation,
            cert_standards, country_of_origin, volatility_class, image_url, datasheet_url, updated_at
       FROM product WHERE product_id = ?`,
  ).get(id) as any;
  if (!product) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

  // Same pool the cards rotate through, plus the datasheet scans — the sheet is
  // where a spec page belongs, and where "show everything" is the whole promise.
  const photos = prep(
    `SELECT local_path, source_url, page_url, kind FROM product_image
      WHERE product_id = ? AND local_path IS NOT NULL ORDER BY rank, width DESC`,
  ).all(id) as Array<{ local_path: string; source_url: string; page_url: string | null; kind: string }>;

  const resolved = resolveAllOffers(id, pincode, qty);

  /**
   * The exact listing whose card was clicked, found BEFORE the roll-up.
   *
   * The table shows one row per seller, and that row is the seller's cheapest
   * listing for this product — so looking the clicked offer up by vendor found
   * a different listing whenever a seller posts the same product twice. The
   * sheet then showed ₹315.70 under a card that said ₹321.60, for the same
   * seller: a Law 3 violation ("the price search shows is the price the cart
   * would bill") created by matching on the wrong key.
   */
  const wantOffer = sp.get('offer');
  const clickedIdx = wantOffer && resolved
    ? resolved.offers.findIndex((o) => o.offer_id === wantOffer)
    : -1;
  const clickedOffer = clickedIdx >= 0 ? resolved!.offers[clickedIdx] : null;

  // One row per seller for the table; resolved stays the full set for pricing.
  const table = resolved ? rollUpByVendor(resolved.offers, resolved.quotes) : null;
  const pc = prep(
    `SELECT * FROM price_current WHERE product_id = ? AND region_id = ?`,
  ).get(id, dest.region_id) as any;

  // Provenance rows — a field with no provenance cannot render, so the client
  // is given value + unit + source + timestamp + confidence together or not
  // at all.
  const specs = prep(
    `SELECT field, label, value, unit, source_url, fetched_at, confidence, derivation
       FROM spec_value WHERE product_id = ? ORDER BY
       CASE confidence WHEN 'quoted' THEN 0 WHEN 'derived' THEN 1 WHEN 'typical' THEN 2 ELSE 3 END,
       label`,
  ).all(id) as any[];
  const seen = new Set<string>();
  const specRows = specs.filter((s) => (seen.has(s.field) ? false : (seen.add(s.field), true)));

  const history = prep(
    `SELECT observed_at, normalised_paise, landed_paise
       FROM price_history WHERE product_id = ? AND region_id = ?
       ORDER BY observed_at ASC LIMIT 400`,
  ).all(id, dest.region_id) as any[];

  // Substitutes: same class, other brands, driven by the normalised item code.
  const substitutes = prep(
    `SELECT p.product_id, p.title, p.brand, pc.normalised_paise, p.unit_canonical, pc.offer_count
       FROM price_current pc JOIN product p ON p.product_id = pc.product_id
      WHERE pc.region_id = ? AND p.category = ? AND p.product_id != ?
      ORDER BY ABS(pc.normalised_paise - ?) ASC LIMIT 6`,
  ).all(dest.region_id, product.category, id, pc?.normalised_paise ?? 0) as any[];

  const sor = prep(
    `SELECT * FROM sor_rate WHERE state_code = ? AND category = ? LIMIT 1`,
  ).get(dest.region_id === 'hyderabad' ? 'TS' : 'AP', product.category) as any;

  const fresh = pc ? assess(pc.priced_as_of, pc.sla_hours) : null;

  return NextResponse.json({
    product: {
      ...product,
      attrs: JSON.parse(product.attrs || '{}'),
      cert_standards: JSON.parse(product.cert_standards || '[]'),
      category_label: CATEGORY_LABEL[product.category] ?? product.category,
      qco_regulated: !!product.qco_regulated,
    },
    region: { region_id: dest.region_id, pincode, locality: dest.locality },
    price: pc
      ? {
          ...pc,
          freshness_state: fresh!.state,
          freshness_dot: fresh!.dot,
          freshness_label: fresh!.label,
          freshness_exact: fresh!.exact,
        }
      : null,
    images: photos.filter((x) => x.kind === 'photo'),
    datasheet_images: photos.filter((x) => x.kind === 'datasheet'),
    offers: table?.offers ?? [],
    /**
     * The listing actually clicked, at its own price — not the seller's
     * cheapest. Null when the caller did not say which, or when that offer is
     * no longer active.
     */
    clicked_offer: clickedOffer,
    // Two different counts: rows shown (one per vendor) vs listings collected.
    total_offers: table?.total_offers ?? 0,
    total_vendors: table?.total_vendors ?? 0,
    quotes: resolved?.quotes ?? [],
    specs: specRows,
    history,
    substitutes,
    sor_anchor: sor ?? null,
    ms: performance.now() - t0,
  }, { headers: { 'cache-control': 'no-store' } });
}
