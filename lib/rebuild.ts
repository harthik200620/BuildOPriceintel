/**
 * Projects offers into the materialised price surface and the search index.
 *
 * Runs inside one transaction so the app never reads a half-written state —
 * a failed refresh leaves the previous data intact and freshness degrades
 * honestly rather than the page going blank.
 */
import { db, prep, tx, checkpoint } from './db';
import { gstOn, baseFromInclusive, median, roundHalfUp, type Paise } from './money';
import { computeFreight, type Geo } from './freight';
import { SLA_HOURS, CATEGORY_VOLATILITY } from './freshness';
import { CATEGORY_LOGISTICS } from './freight';
import { categoryForms } from './query/vocab';
import { invalidateSearchCache } from './search';
import { implausibleReason } from './plausibility';

interface OfferRow {
  offer_id: string; product_id: string; vendor_id: string; region_id: string;
  base_paise_canonical: number; trade_multiple: number;
  gst_treatment: 'INCL' | 'EXCL'; gst_rate_bp: number; hsn: string;
  delivery_scope: string; moq_qty: number | null; stock_state: string;
  lead_time_days: number | null; cert_state: string; fetched_at: string;
  category: string; unit_canonical: string; unit_weight_kg: number | null;
  unit_volume_m3: number | null;
  v_lat: number | null; v_lon: number | null;
  free_delivery_threshold_paise: number | null;
}

export interface RebuildStats {
  offers: number; priced: number; products: number; rows: number; historyRows: number; offerRows: number;
  quarantined: Array<{ key: string; paise: number; median: number; ratio: number }>;
  /** Offers the plausibility rules took out of the surface on this rebuild, by reason. */
  implausible: Array<{ reason: string; count: number; examples: string[] }>;
}

/**
 * The plausibility pass. Every active offer is held against lib/plausibility
 * from what the store already knows about it — the seller's own title, the
 * resolved product attributes, the quoted unit, the seller's figure per
 * canonical unit — and one that fails is deactivated with the reason written
 * on the row. Deactivated, not deleted: the source is kept, and a later
 * collection that sees the listing again and finds it passing (the seller
 * fixed a price, or a rule was loosened) reactivates it.
 *
 * Runs before the price surface is built, so search, the vendor table, the
 * card figures and the chat tools — every reader of `is_active = 1` — agree.
 * The relative absurdity gate below stays as the second line.
 */
export function quarantineImplausible(): RebuildStats['implausible'] {
  const rows = prep(`
    SELECT o.offer_id, o.listing_title, o.base_unit, o.base_paise_canonical,
           p.category, p.title AS product_title, p.pack_size, p.attrs
      FROM offer o JOIN product p ON p.product_id = o.product_id
     WHERE o.is_active = 1`).all() as any[];
  const byReason = new Map<string, { count: number; examples: string[] }>();
  const mark = db().prepare(`UPDATE offer SET is_active = 0, quarantine_reason = ? WHERE offer_id = ?`);
  tx(() => {
    for (const r of rows) {
      let attrs: any = {};
      try { attrs = JSON.parse(r.attrs || '{}'); } catch { /* attrs are ours; never malformed, but never fatal */ }
      const reason = implausibleReason({
        category: r.category,
        title: r.listing_title ?? r.product_title ?? '',
        cement_type: attrs.cement_type ?? null,
        pack_size_kg: r.pack_size ?? attrs.pack_size_kg ?? null,
        nominal_bore_mm: attrs.nominal_bore_mm ?? null,
        quoted_unit: r.base_unit,
        // Stored bores may predate the thickness-aware parser; only the
        // infrastructure end of the range is enforced on them.
        bore_trusted: false,
        base_paise_per_canonical: r.base_paise_canonical,
      });
      if (!reason) continue;
      mark.run(reason, r.offer_id);
      // Family, not the full sentence — the sentence carries the figure.
      const family = reason.replace(/\("[^"]*"\)/, '').replace(/₹[\d,.]+/g, '₹…').replace(/\d+(\.\d+)? (kg|mm)/g, 'N $2');
      const e = byReason.get(family) ?? { count: 0, examples: [] };
      e.count++;
      if (e.examples.length < 3) e.examples.push(String(r.listing_title ?? r.product_title).slice(0, 60));
      byReason.set(family, e);
    }
  });
  return [...byReason.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.count - a.count);
}

/**
 * Landed price for one canonical unit of an offer, delivered to a region.
 * This is the only place the landed figure is computed, and `resolvePrice`
 * calls the same function — which is how the price search shows stays the
 * price the cart would bill.
 */
export function landedFor(
  o: Pick<OfferRow,
    'offer_id' | 'base_paise_canonical' | 'gst_treatment' | 'gst_rate_bp' | 'category' |
    'unit_weight_kg' | 'unit_volume_m3' | 'moq_qty' | 'vendor_id' | 'free_delivery_threshold_paise'>,
  vendorGeo: Geo | null,
  destGeo: Geo,
  qtyOverride?: number,
) {
  const baseEx =
    o.gst_treatment === 'EXCL'
      ? o.base_paise_canonical
      : baseFromInclusive(o.base_paise_canonical, o.gst_rate_bp);
  const gst = gstOn(baseEx, o.gst_rate_bp);

  const logistics = CATEGORY_LOGISTICS[o.category] ?? CATEGORY_LOGISTICS.cement;
  // The trip is amortised over the category's reference order — 50 bags,
  // 1,000 kg, 20 lengths, 1,000 pieces — so every seller's landed figure is
  // on the same basis. A seller whose MOQ is LARGER than that cannot be bought
  // from in smaller lots, so their trip spreads over the MOQ, which is honest
  // and cheaper per unit. A seller whose MOQ is smaller ("MOQ: 1 piece") used
  // to be amortised over that MOQ, which put a whole parcel trip and the
  // minimum handling charge on a single ₹7 brick: ₹149.85 landed, top of the
  // Vijayawada list, against ₹8 for the same brick from the seller beside it.
  const amortiseQty = qtyOverride ?? Math.max(o.moq_qty && o.moq_qty > 0 ? o.moq_qty : 0, logistics.referenceQty);

  const f = computeFreight({
    vendorId: o.vendor_id,
    vendorGeo,
    destGeo,
    category: o.category,
    unitWeightKg: o.unit_weight_kg ?? 1,
    unitVolumeM3: o.unit_volume_m3,
    amortiseQty,
    orderValuePaise: (baseEx + gst) * amortiseQty,
    vendorFreeDeliveryThresholdPaise: o.free_delivery_threshold_paise,
  });

  const landed = baseEx + gst + f.freightPaise + f.handlingPaise + f.loadingPaise;
  return { baseEx, gst, freight: f, landed, amortiseQty };
}

const OFFER_SQL = `
  SELECT o.offer_id, o.product_id, o.vendor_id, o.region_id,
         o.base_paise_canonical, o.trade_multiple, o.gst_treatment, o.gst_rate_bp, o.hsn,
         o.delivery_scope, o.moq_qty, o.stock_state, o.lead_time_days, o.cert_state, o.fetched_at,
         p.category, p.unit_canonical, p.unit_weight_kg, p.unit_volume_m3,
         v.lat AS v_lat, v.lon AS v_lon, v.free_delivery_threshold_paise
    FROM offer o
    JOIN product p ON p.product_id = o.product_id
    JOIN vendor  v ON v.vendor_id  = o.vendor_id
   WHERE o.is_active = 1`;

/** The triggers price_history's CHECK constraint accepts — schema.sql is the authority. */
export type PriceTrigger = 'schedule' | 'seed' | 'user_verify' | 'backfill';

export function rebuildPrices(runId: string, trigger: PriceTrigger = 'schedule'): RebuildStats {
  const regions = prep(`SELECT region_id, centroid_lat, centroid_lon, default_pincode FROM region`).all() as Array<{
    region_id: string; centroid_lat: number; centroid_lon: number; default_pincode: string;
  }>;
  const destByRegion = new Map<string, Geo>();
  for (const r of regions) {
    const pin = prep(`SELECT lat, lon FROM pincode WHERE pincode = ?`).get(r.default_pincode) as any;
    destByRegion.set(r.region_id, pin ? { lat: pin.lat, lon: pin.lon } : { lat: r.centroid_lat, lon: r.centroid_lon });
  }

  // First the plausibility pass, so the rows below are the ones that may
  // become prices at all.
  const implausible = quarantineImplausible();

  const offers = prep(OFFER_SQL).all() as OfferRow[];
  const now = new Date().toISOString();

  // (product, region) -> computed rows
  type Computed = {
    offer_id: string; vendor_id: string; normalised: number; landed_trade: number;
    baseEx: number; gst: number; freight: number; handling: number; loading: number;
    delivery_scope: string; gst_treatment: string; fetched_at: string; stock: string;
    lead: number | null; cert: string; freightBasis: string; breakdown: unknown;
  };
  const grouped = new Map<string, Computed[]>();
  const serviceRows: any[] = [];
  let priced = 0;

  for (const o of offers) {
    const dest = destByRegion.get(o.region_id);
    if (!dest) continue;
    const vGeo = o.v_lat != null && o.v_lon != null ? { lat: o.v_lat, lon: o.v_lon } : null;
    const r = landedFor(o, vGeo, dest);
    priced++;

    serviceRows.push([
      o.offer_id, o.region_id, 1,
      o.lead_time_days ?? (r.freight.distanceBand === 'local' ? 1 : r.freight.distanceBand === 'metro' ? 2 : 4),
      r.freight.freightPaise, r.freight.handlingPaise, r.freight.loadingPaise,
      r.freight.vehicleClass, r.freight.distanceKm, r.freight.distanceBand,
      r.freight.chargeableKg, r.freight.basis, JSON.stringify(r.freight.breakdown),
    ]);

    const key = `${o.product_id}|${o.region_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({
      offer_id: o.offer_id, vendor_id: o.vendor_id,
      normalised: r.landed,
      landed_trade: roundHalfUp(r.landed * (o.trade_multiple || 1)),
      baseEx: r.baseEx, gst: r.gst,
      freight: r.freight.freightPaise, handling: r.freight.handlingPaise, loading: r.freight.loadingPaise,
      delivery_scope: 'DELIVERED_SITE', gst_treatment: 'INCL',
      fetched_at: o.fetched_at, stock: o.stock_state, lead: o.lead_time_days,
      cert: o.cert_state, freightBasis: r.freight.basis, breakdown: r.freight.breakdown,
    });
  }

  const catOf = new Map<string, string>();
  for (const p of prep(`SELECT product_id, category FROM product`).all() as any[]) catOf.set(p.product_id, p.category);

  /**
   * The absurdity gate (spec failure mode F4).
   *
   * A price outside [0.1x, 10x] of the trailing median for its (category,
   * region) is quarantined and never published — a decimal shift, or a
   * per-tonne figure parsed as per-bag, must not reach a customer. Degradation
   * is always to an older price honestly labelled, never to a wrong price
   * shown as right.
   */
  const byCatRegion = new Map<string, number[]>();
  for (const [key, list] of grouped) {
    const [product_id, region_id] = key.split('|');
    const k = `${catOf.get(product_id) ?? '?'}|${region_id}`;
    if (!byCatRegion.has(k)) byCatRegion.set(k, []);
    byCatRegion.get(k)!.push(...list.map((c) => c.normalised));
  }
  const medians = new Map<string, number>();
  for (const [k, vals] of byCatRegion) medians.set(k, median(vals));
  const quarantined: Array<{ key: string; paise: number; median: number; ratio: number }> = [];

  let rows = 0, historyRows = 0, offerRows = 0;
  tx(() => {
    db().prepare(`DELETE FROM serviceability`).run();
    const svc = db().prepare(
      `INSERT INTO serviceability (offer_id,region_id,deliverable,lead_time_days,freight_paise,
         handling_paise,loading_paise,vehicle_class,distance_km,distance_band,chargeable_kg,basis,breakdown)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of serviceRows) svc.run(...s);

    db().prepare(`DELETE FROM price_current`).run();
    const ins = db().prepare(
      `INSERT INTO price_current (product_id,region_id,tier,best_offer_id,base_paise,gst_paise,
         freight_paise,handling_paise,loading_paise,landed_paise,normalised_unit,normalised_paise,
         floor_paise,ceiling_paise,median_paise,offer_count,vendor_count,delivery_scope,gst_treatment,
         priced_as_of,sla_hours,reason_code)
       VALUES (?,?,'standard',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const hist = db().prepare(
      `INSERT INTO price_history (product_id,region_id,offer_id,normalised_unit,normalised_paise,
         landed_paise,base_paise,observed_at,collection_run_id,trigger)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );

    // Per-offer prices, written from the same survivors the product summary is
    // built from — so a price the absurdity gate quarantined cannot reach a
    // card by the vendor-led route either.
    db().prepare(`DELETE FROM offer_price`).run();
    const insOffer = db().prepare(
      `INSERT INTO offer_price (offer_id,region_id,tier,product_id,vendor_id,base_paise,gst_paise,
         freight_paise,handling_paise,loading_paise,landed_paise,normalised_unit,normalised_paise,
         delivery_scope,gst_treatment,priced_as_of,sla_hours)
       VALUES (?,?,'standard',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    for (const [key, list] of grouped) {
      const [product_id, region_id] = key.split('|');
      const category = catOf.get(product_id) ?? 'cement';
      const unit = prep(`SELECT unit_canonical FROM product WHERE product_id=?`).get(product_id) as any;
      const canonical = unit?.unit_canonical ?? 'piece';

      // Rank candidates: in-stock first, then cheapest delivered.
      const sorted = [...list].sort((a, b) => {
        const sa = a.stock === 'out_of_stock' ? 1 : 0;
        const sb = b.stock === 'out_of_stock' ? 1 : 0;
        if (sa !== sb) return sa - sb;
        return a.normalised - b.normalised;
      });
      const med = medians.get(`${category}|${region_id}`) ?? 0;
      const survivors = med > 0
        ? sorted.filter((c) => {
            const ratio = c.normalised / med;
            if (ratio < 0.1 || ratio > 10) {
              quarantined.push({ key, paise: c.normalised, median: med, ratio: +ratio.toFixed(3) });
              return false;
            }
            return true;
          })
        : sorted;
      if (!survivors.length) continue;

      const best = survivors[0];
      const vals = survivors.map((c) => c.normalised);
      const sla = SLA_HOURS[CATEGORY_VOLATILITY[category] ?? 'V1'];
      const freshest = survivors.reduce((m, c) => (c.fetched_at > m ? c.fetched_at : m), survivors[0].fetched_at);

      ins.run(
        product_id, region_id, best.offer_id,
        best.baseEx, best.gst, best.freight, best.handling, best.loading,
        best.landed_trade, canonical, best.normalised,
        Math.min(...vals), Math.max(...vals), median(vals),
        survivors.length, new Set(survivors.map((c) => c.vendor_id)).size,
        best.delivery_scope, best.gst_treatment,
        freshest, sla,
        // CP(E-Commerce) Rule 4(11): every zone price difference carries a
        // machine-readable justification. That log is the defence.
        best.freightBasis === 'seeded_fallback' ? 'FREIGHT_BAND_ESTIMATED' : 'FREIGHT_BAND',
      );
      rows++;

      for (const c of survivors) {
        hist.run(product_id, region_id, c.offer_id, canonical, c.normalised,
          c.landed_trade, c.baseEx, now, runId, trigger);
        historyRows++;

        insOffer.run(
          c.offer_id, region_id, product_id, c.vendor_id,
          c.baseEx, c.gst, c.freight, c.handling, c.loading,
          c.landed_trade, canonical, c.normalised,
          c.delivery_scope, c.gst_treatment, c.fetched_at, sla,
        );
        offerRows++;
      }
    }
  });

  // The price surface just changed underneath any search cache in this process.
  invalidateSearchCache();

  // And fold the write-ahead log back in. A rebuild writes tens of thousands of
  // frames; left in the log they slow every subsequent read, and auto-checkpoint
  // cannot clear them while a reader (a running dev server) pins the log.
  const cp = checkpoint();
  if (cp.blocked || cp.checkpointed < cp.frames) {
    console.log(
      `  wal: ${cp.checkpointed}/${cp.frames} frames folded back` +
      (cp.blocked ? ' — blocked by another open reader.' : ' — a reader is holding an older snapshot.') +
      ' Restart anything holding the database open, then `npm run db:checkpoint`.',
    );
  }

  return { offers: offers.length, priced, products: grouped.size, rows, historyRows, offerRows, quarantined, implausible };
}

/**
 * Rebuilds both search indexes. The blob carries Latin, Telugu, Devanagari and
 * transliterated forms so `ఇటుక`, `itaka`, `eeta` and `sariya` all retrieve.
 */
export function rebuildSearchIndex(): number {
  const products = prep(
    `SELECT p.product_id, p.title, p.brand, p.category, p.attrs, p.unit_canonical,
            GROUP_CONCAT(DISTINCT v.name) AS vendors
       FROM product p
       LEFT JOIN offer o ON o.product_id = p.product_id AND o.is_active = 1
       LEFT JOIN vendor v ON v.vendor_id = o.vendor_id
      GROUP BY p.product_id`,
  ).all() as any[];

  let n = 0;
  tx(() => {
    db().prepare(`DELETE FROM product_fts`).run();
    db().prepare(`DELETE FROM product_trgm`).run();
    const a = db().prepare(`INSERT INTO product_fts (product_id,title,brand,blob) VALUES (?,?,?,?)`);
    const b = db().prepare(`INSERT INTO product_trgm (product_id,blob) VALUES (?,?)`);
    const upd = db().prepare(`UPDATE product SET search_blob = ? WHERE product_id = ?`);

    for (const p of products) {
      const attrs = JSON.parse(p.attrs || '{}');
      const attrText = Object.entries(attrs)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
        .join(' ');
      // Alternate-script forms are attached per category so a Telugu or
      // transliterated query reaches the same product as the English one.
      const forms = categoryForms(p.category).join(' ');
      const blob = [p.title, p.brand ?? '', p.category.replace(/_/g, ' '), attrText, forms, p.vendors ?? '']
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      a.run(p.product_id, p.title, p.brand ?? '', blob);
      b.run(p.product_id, blob.toLowerCase());
      upd.run(blob, p.product_id);
      n++;
    }
  });
  return n;
}
