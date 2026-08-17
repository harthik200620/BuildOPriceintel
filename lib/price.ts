/**
 * resolvePrice — the ONLY function in this application that may state a rupee
 * figure.
 *
 * The search row, the detail sheet, the vendor table, the compare tray and the
 * list total all call it. There is no second pricing path and no client is
 * permitted to do its own arithmetic on components. That is what makes "the
 * price the search shows is the price the cart would bill" a property of the
 * code rather than a promise in a document — and tests/parity.ts asserts it.
 */
import { prep } from './db';
import { landedFor } from './rebuild';
import { assess, SLA_HOURS, CATEGORY_VOLATILITY } from './freshness';
import { roundHalfUp, type Paise } from './money';
import type { CertState, DeliveryScope, GstTreatment, OfferView, VendorRow } from './types';
import type { Geo } from './freight';

export interface ResolveInput {
  product_id: string;
  pincode: string;
  qty?: number;
  tier?: string;
  offer_id?: string;
}

export interface ResolvedQuote {
  product_id: string;
  offer_id: string;
  region_id: string;
  pincode: string;
  qty: number;
  tier: string;
  basis: {
    base_ex_gst_paise: Paise;
    gst_rate_bp: number;
    gst_paise: Paise;
    hsn: string;
    freight_paise: Paise;
    handling_paise: Paise;
    loading_paise: Paise;
    landed_incl_all_paise: Paise;
    normalised: { unit: string; paise: Paise };
    trade: { unit: string; paise: Paise; multiple: number };
    delivery_scope: DeliveryScope;
    gst_treatment: GstTreatment;
  };
  line_total_paise: Paise;
  moq_ok: boolean;
  moq_qty: number | null;
  priced_as_of: string;
  freshness_state: string;
  freshness_label: string;
  freshness_dot: 'green' | 'amber' | 'grey';
  sla_hours: number;
  quotable: boolean;
  blocked_reason: string | null;
  freight_basis: string;
  freight_breakdown: Array<{ step: string; detail: string; value?: string }>;
  source_url: string;
}

const PIN_SQL = `SELECT p.pincode, p.region_id, p.lat, p.lon, p.locality FROM pincode p WHERE p.pincode = ?`;

const OFFER_SQL = `
  SELECT o.offer_id, o.product_id, o.vendor_id, o.region_id, o.platform, o.source_url,
         o.listing_title,
         o.base_paise, o.base_unit, o.base_paise_canonical, o.trade_multiple,
         o.gst_treatment, o.gst_rate_bp, o.hsn, o.mrp_paise, o.delivery_scope,
         o.moq_qty, o.moq_unit, o.bulk_slabs, o.stock_state, o.lead_time_days,
         o.cert_state, o.cert_ref, o.cert_valid_to, o.rating, o.review_count,
         o.images, o.datasheet_url, o.fetched_at,
         p.category, p.unit_canonical, p.unit_weight_kg, p.unit_volume_m3, p.qco_regulated,
         v.vendor_id AS v_id, v.name AS v_name, v.platform AS v_platform, v.seller_type,
         v.locality, v.city, v.rating AS v_rating, v.review_count AS v_reviews,
         v.profile_url, v.geo_confidence, v.lat AS v_lat, v.lon AS v_lon,
         v.free_delivery_threshold_paise
    FROM offer o
    JOIN product p ON p.product_id = o.product_id
    JOIN vendor  v ON v.vendor_id  = o.vendor_id
   -- Region-scoped. Without this the vendor table shows the same seller once
   -- per region and the offer count disagrees with price_current.
   WHERE o.product_id = ? AND o.region_id = ? AND o.is_active = 1`;

export function resolvePincode(pincode: string): { pincode: string; region_id: string; geo: Geo; locality: string } | null {
  const r = prep(PIN_SQL).get(pincode) as any;
  if (!r) return null;
  return { pincode: r.pincode, region_id: r.region_id, geo: { lat: r.lat, lon: r.lon }, locality: r.locality };
}

/** Every offer for a product, priced identically, ready for the vendor table. */
export function resolveAllOffers(product_id: string, pincode: string, qty?: number): {
  region_id: string; offers: OfferView[]; quotes: ResolvedQuote[];
} | null {
  const dest = resolvePincode(pincode);
  if (!dest) return null;

  const rows = prep(OFFER_SQL).all(product_id, dest.region_id) as any[];
  const offers: OfferView[] = [];
  const quotes: ResolvedQuote[] = [];

  for (const o of rows) {
    const q = priceOne(o, dest, qty);
    quotes.push(q);

    const vendor: VendorRow = {
      vendor_id: o.v_id, name: o.v_name, platform: o.v_platform, seller_type: o.seller_type,
      locality: o.locality, city: o.city, region_id: o.region_id,
      rating: o.v_rating, review_count: o.v_reviews, profile_url: o.profile_url,
      geo_confidence: o.geo_confidence,
    };

    offers.push({
      offer_id: o.offer_id, vendor, platform: o.platform, source_url: o.source_url,
      listing_title: o.listing_title ?? null, also_listed: [],
      base_paise: o.base_paise, base_unit: o.base_unit,
      gst_treatment: o.gst_treatment, gst_rate_bp: o.gst_rate_bp, hsn: o.hsn,
      mrp_paise: o.mrp_paise, delivery_scope: o.delivery_scope,
      freight_paise: q.basis.freight_paise, handling_paise: q.basis.handling_paise,
      loading_paise: q.basis.loading_paise, landed_paise: q.basis.trade.paise,
      normalised_unit: q.basis.normalised.unit, normalised_paise: q.basis.normalised.paise,
      moq_qty: o.moq_qty, moq_unit: o.moq_unit,
      bulk_slabs: o.bulk_slabs ? JSON.parse(o.bulk_slabs) : null,
      stock_state: o.stock_state, lead_time_days: o.lead_time_days,
      cert_state: o.cert_state as CertState, cert_ref: o.cert_ref, cert_valid_to: o.cert_valid_to,
      rating: o.rating, review_count: o.review_count, fetched_at: o.fetched_at,
      freshness_state: q.freshness_state as any,
      freight_basis: q.freight_basis, freight_breakdown: q.freight_breakdown,
      // Basis parity: two prices are comparable only when unit, delivery scope
      // and GST treatment agree. Everything resolved here is normalised to the
      // same basis, which is exactly why it IS comparable — the engine's job.
      comparable: true,
      comparability_reason: null,
    });
  }

  // Cheapest delivered first — the figure computed identically for every seller.
  const order = quotes
    .map((q, i) => ({ i, p: q.basis.normalised.paise, oos: offers[i].stock_state === 'out_of_stock' ? 1 : 0 }))
    .sort((a, b) => a.oos - b.oos || a.p - b.p)
    .map((x) => x.i);

  return {
    region_id: dest.region_id,
    offers: order.map((i) => offers[i]),
    quotes: order.map((i) => quotes[i]),
  };
}

/**
 * The vendor table's view: one row per seller.
 *
 * Deliberately NOT done inside resolveAllOffers. That function is the pricing
 * contract — resolvePrice() reads it to answer "what does offer X cost", and a
 * rolled-up listing must still be answerable or a card whose offer happens to
 * be the seller's second-cheapest could not be priced at all. Rolling up is a
 * presentation decision, so it lives at the presentation boundary.
 *
 * A seller routinely posts the same product several times — three IndiaMART
 * listing IDs for one bag of ACC at one price — and a row each made the table
 * repeat one name down the page while calling itself a list of vendors. The
 * cheapest becomes the visible row; the rest ride along in `also_listed` with
 * their source URLs, which is the difference between rolling up and hiding.
 */
export function rollUpByVendor(offers: OfferView[], quotes: ResolvedQuote[]): {
  offers: OfferView[]; quotes: ResolvedQuote[]; total_offers: number; total_vendors: number;
} {
  const keptIdx: number[] = [];
  const slotForVendor = new Map<string, number>();
  // `offers` arrives cheapest-first, so first-seen per vendor is their best.
  for (let i = 0; i < offers.length; i++) {
    const vid = offers[i].vendor.vendor_id;
    const at = slotForVendor.get(vid);
    if (at === undefined) {
      slotForVendor.set(vid, keptIdx.length);
      keptIdx.push(i);
      offers[i].also_listed = [];
    } else {
      offers[keptIdx[at]].also_listed!.push({
        offer_id: offers[i].offer_id,
        source_url: offers[i].source_url,
        listing_title: offers[i].listing_title,
        base_paise: offers[i].base_paise,
        base_unit: offers[i].base_unit,
        normalised_paise: quotes[i].basis.normalised.paise,
      });
    }
  }
  return {
    offers: keptIdx.map((i) => offers[i]),
    quotes: keptIdx.map((i) => quotes[i]),
    // Both counts, because the header states both: "40 offers from 31 sellers".
    total_offers: offers.length,
    total_vendors: keptIdx.length,
  };
}

function priceOne(o: any, dest: { pincode: string; region_id: string; geo: Geo }, qtyIn?: number): ResolvedQuote {
  const vGeo: Geo | null = o.v_lat != null && o.v_lon != null ? { lat: o.v_lat, lon: o.v_lon } : null;

  const r = landedFor(
    {
      offer_id: o.offer_id, base_paise_canonical: o.base_paise_canonical,
      gst_treatment: o.gst_treatment, gst_rate_bp: o.gst_rate_bp, category: o.category,
      unit_weight_kg: o.unit_weight_kg, unit_volume_m3: o.unit_volume_m3,
      moq_qty: o.moq_qty, vendor_id: o.vendor_id,
      free_delivery_threshold_paise: o.free_delivery_threshold_paise,
    },
    vGeo, dest.geo,
    qtyIn,
  );
  // The quantity this quote is for is the one the trip was amortised over —
  // the buyer's, or else the category's reference order (never a lone unit).
  const qty = r.amortiseQty;

  const slaHours = SLA_HOURS[CATEGORY_VOLATILITY[o.category] ?? 'V1'];
  const fresh = assess(o.fetched_at, slaHours);
  const tradeMultiple = o.trade_multiple || 1;

  const moqOk = o.moq_qty == null || qty >= o.moq_qty;
  // An EXPIRED price cannot be quoted. No override path exists.
  const blocked =
    !fresh.quotable
      ? 'This price is past three times its refresh window and is no longer current. Verify it before ordering.'
      : o.qco_regulated && o.cert_state === 'EXPIRED'
        ? 'This category requires a valid BIS licence by law, and this seller\'s licence has expired.'
        : null;

  return {
    product_id: o.product_id, offer_id: o.offer_id, region_id: dest.region_id,
    pincode: dest.pincode, qty, tier: 'standard',
    basis: {
      base_ex_gst_paise: r.baseEx,
      gst_rate_bp: o.gst_rate_bp,
      gst_paise: r.gst,
      hsn: o.hsn,
      freight_paise: r.freight.freightPaise,
      handling_paise: r.freight.handlingPaise,
      loading_paise: r.freight.loadingPaise,
      landed_incl_all_paise: r.landed,
      normalised: { unit: o.unit_canonical, paise: r.landed },
      trade: { unit: o.base_unit, paise: roundHalfUp(r.landed * tradeMultiple), multiple: tradeMultiple },
      delivery_scope: 'DELIVERED_SITE',
      gst_treatment: 'INCL',
    },
    line_total_paise: roundHalfUp(r.landed * qty),
    moq_ok: moqOk, moq_qty: o.moq_qty,
    priced_as_of: o.fetched_at,
    freshness_state: fresh.state,
    freshness_label: fresh.label,
    freshness_dot: fresh.dot,
    sla_hours: slaHours,
    quotable: fresh.quotable && !blocked,
    blocked_reason: blocked,
    freight_basis: r.freight.basis,
    freight_breakdown: r.freight.breakdown,
    source_url: o.source_url,
  };
}

/** Price one product at a pincode — the best (cheapest deliverable) offer. */
export function resolvePrice(input: ResolveInput): ResolvedQuote | null {
  const all = resolveAllOffers(input.product_id, input.pincode, input.qty);
  if (!all || !all.quotes.length) return null;
  if (input.offer_id) {
    const hit = all.quotes.find((q) => q.offer_id === input.offer_id);
    if (hit) return hit;
  }
  return all.quotes[0];
}

/** Price a whole saved list in one call. */
export function resolveBulk(lines: Array<{ product_id: string; qty: number }>, pincode: string) {
  const quotes: ResolvedQuote[] = [];
  const blocked: Array<{ product_id: string; reason: string }> = [];
  for (const l of lines) {
    const q = resolvePrice({ product_id: l.product_id, pincode, qty: l.qty });
    if (!q) { blocked.push({ product_id: l.product_id, reason: 'No offer for this product at this pincode.' }); continue; }
    if (!q.quotable) { blocked.push({ product_id: l.product_id, reason: q.blocked_reason! }); continue; }
    quotes.push(q);
  }
  return {
    quotes, blocked,
    total_paise: quotes.reduce((s, q) => s + q.line_total_paise, 0),
  };
}
