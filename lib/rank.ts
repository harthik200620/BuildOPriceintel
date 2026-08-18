/**
 * Ranking — a published linear function over nine features with four penalties.
 *
 * It stays explainable on purpose. CP(E-Commerce) Rule 5(3)(f) requires the
 * main ranking parameters to be stated in plain language, and a black box
 * cannot do that honestly — so every result carries a "why this is here" chip
 * naming its top two contributing features, and /how-ranking-works lists all
 * nine in weight order.
 */
import type { CertState } from './types';
import { assess } from './freshness';

export interface RankWeights { f1: number; f2: number; f3: number; f4: number; f5: number; f6: number; f7: number; f8: number; f9: number }

export const BASE_WEIGHTS: RankWeights = {
  f1: 0.28, f2: 0.16, f3: 0.14, f4: 0.10, f5: 0.10, f6: 0.07, f7: 0.06, f8: 0.05, f9: 0.04,
};

/**
 * Cold start. There is no order history in this build, so f8 (sales velocity)
 * is a constant and therefore inert. Rather than let a dead feature absorb 5%
 * of the score, its weight is redistributed to relevance and price exactly as
 * the spec prescribes, and the function degrades gracefully to eight features.
 */
export const COLD_START_WEIGHTS: RankWeights = {
  ...BASE_WEIGHTS, f1: 0.31, f3: 0.16, f8: 0,
};

export const FEATURE_LABEL: Record<keyof RankWeights, string> = {
  f1: 'closest match to your search',
  f2: 'matches the exact spec you asked for',
  f3: 'lowest delivered price in your area',
  f4: 'in stock and deliverable to your pincode',
  f5: 'seller rating and reliability',
  f6: 'BIS certification',
  f7: 'fastest delivery',
  f8: 'most bought',
  f9: 'most recently verified price',
};

export const PENALTIES = {
  stale: 0.25,
  outOfStock: 0.60,
  moqAboveQty: 0.35,
} as const;

export interface Candidate {
  /**
   * A candidate is one SELLER'S OFFER, so `offer_id` is the identity — a
   * product can appear many times, once per seller, and keying anything by
   * product_id here silently collapses them.
   */
  offer_id: string;
  product_id: string;
  vendor_id: string;
  /** Normalised lexical relevance in [0,1]. */
  relevance: number;
  /** Fraction of query-extracted typed attributes matched exactly. */
  attrMatch: number;
  normalised_paise: number;
  stock_state: string;
  lead_time_days: number | null;
  rating: number | null;
  review_count: number | null;
  cert_state: CertState;
  qco_regulated: boolean;
  priced_as_of: string;
  sla_hours: number;
  moq_qty: number | null;
  deliverable: boolean;
  requestedQty: number;
}

export interface Scored extends Candidate {
  score: number;
  contributions: Array<{ key: keyof RankWeights; label: string; value: number }>;
  why: string[];
  penaltiesApplied: string[];
  dampingFactor: number;
}

/** Certification is a preference, not a gate — except where a QCO makes it law. */
function certFeature(c: CertState): number {
  switch (c) {
    case 'CERTIFIED': return 1.0;
    case 'BRAND_LICENSED': return 0.8;
    case 'NOT_APPLICABLE': return 0.7;  // neutral — unmarked sand is not punished for being sand
    case 'NOT_DECLARED': return 0.3;
    case 'EXPIRED': return 0.0;
  }
}

/** Rating shrunk toward the category mean with prior n0 = 20. */
function shrunkRating(rating: number | null, reviews: number | null, categoryMean = 3.9): number {
  const n = reviews ?? 0;
  const r = rating ?? categoryMean;
  const n0 = 20;
  return ((r * n) + (categoryMean * n0)) / (n + n0) / 5;
}

/**
 * The hard filter. It fires ONLY on positive evidence that a licence has
 * expired in a category where a Quality Control Order makes one a legal
 * condition of sale. It deliberately does NOT fire on a listing that simply
 * fails to quote a licence number: "not published by this seller" is a
 * different claim from "not licensed", and treating them as the same would
 * delete most of the honest supply in this market.
 */
export function hardFiltered(c: Candidate): { blocked: boolean; reason: string | null } {
  if (c.qco_regulated && c.cert_state === 'EXPIRED') {
    return {
      blocked: true,
      reason: 'This category requires a valid BIS licence by law, and this seller\'s licence has expired.',
    };
  }
  return { blocked: false, reason: null };
}

export function score(
  candidates: Candidate[],
  opts: { weights?: RankWeights } = {},
): Scored[] {
  const w = opts.weights ?? COLD_START_WEIGHTS;
  if (!candidates.length) return [];

  // f3 is a percentile among the comparable set, so it needs the whole set.
  const prices = candidates.map((c) => c.normalised_paise).sort((a, b) => a - b);
  const percentile = (p: number) => {
    let lo = 0, hi = prices.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (prices[m] < p) lo = m + 1; else hi = m; }
    return prices.length > 1 ? lo / (prices.length - 1) : 0;
  };

  const scored: Scored[] = candidates.map((c) => {
    const fresh = assess(c.priced_as_of, c.sla_hours);

    const f: Record<keyof RankWeights, number> = {
      f1: Math.max(0, Math.min(1, c.relevance)),
      f2: Math.max(0, Math.min(1, c.attrMatch)),
      f3: 1 - percentile(c.normalised_paise),
      f4: !c.deliverable ? 0 : c.stock_state === 'out_of_stock' ? 0
        : (c.lead_time_days ?? 3) > 7 ? 0.5 : 1.0,
      f5: shrunkRating(c.rating, c.review_count),
      f6: certFeature(c.cert_state),
      f7: Math.exp(-((c.lead_time_days ?? 3) / 7)),
      f8: 0,
      f9: 1 - Math.min(1, fresh.ageHours / fresh.slaHours),
    };

    const contributions = (Object.keys(w) as Array<keyof RankWeights>)
      .filter((k) => w[k] > 0)
      .map((k) => ({ key: k, label: FEATURE_LABEL[k], value: w[k] * f[k] }))
      .sort((a, b) => b.value - a.value);

    let s = contributions.reduce((acc, x) => acc + x.value, 0);

    const penaltiesApplied: string[] = [];
    if (fresh.state === 'STALE' || fresh.state === 'EXPIRED') {
      s -= PENALTIES.stale; penaltiesApplied.push(`stale price −${PENALTIES.stale}`);
    }
    if (c.stock_state === 'out_of_stock') {
      s -= PENALTIES.outOfStock; penaltiesApplied.push(`out of stock −${PENALTIES.outOfStock}`);
    }
    if (c.moq_qty != null && c.moq_qty > c.requestedQty) {
      s -= PENALTIES.moqAboveQty; penaltiesApplied.push(`minimum order above your quantity −${PENALTIES.moqAboveQty}`);
    }

    return {
      ...c, score: s, contributions,
      why: contributions.slice(0, 2).map((x) => x.label),
      penaltiesApplied, dampingFactor: 1,
    };
  });

  scored.sort(compare);

  // Diversity damping used to live here — a vendor's 3rd result scored ×0.85,
  // its 5th ×0.70, and no seller could hold more than 4 of the first 10.
  //
  // It was REMOVED, not disabled, and the reason has since changed. It went
  // because the list emitted one card per vendor, which made every one of those
  // rules unreachable. The list is one card per PRODUCT now (groupByProduct in
  // lib/search.ts), so a seller CAN hold many positions again — and it still
  // does not come back, for a different and better reason: a card is won by
  // having the lowest landed price for that product, not by how many listings
  // the seller posted. A seller who occupies the first ten rows is the seller
  // who is cheapest on ten different products, which is the answer this page
  // exists to give. Damping that would be suppressing the result to flatter
  // the ranking.
  //
  // Either way it stays out of the code rather than sitting disabled: CP
  // (E-Commerce) Rule 5(3)(f) requires the ranking parameters disclosed to a
  // customer to be the ones actually applied, and the "why this is here" chip
  // reads from this function.
  return scored;
}

/** Tie-breaks in the published order, ending on a stable hash so pagination is deterministic. */
function compare(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.normalised_paise !== b.normalised_paise) return a.normalised_paise - b.normalised_paise;
  if (a.priced_as_of !== b.priced_as_of) return a.priced_as_of > b.priced_as_of ? -1 : 1;
  const tier = (c: CertState) => (c === 'CERTIFIED' ? 4 : c === 'BRAND_LICENSED' ? 3 : c === 'NOT_APPLICABLE' ? 2 : c === 'NOT_DECLARED' ? 1 : 0);
  if (tier(a.cert_state) !== tier(b.cert_state)) return tier(b.cert_state) - tier(a.cert_state);
  const t = (x: Scored) => shrunkRating(x.rating, x.review_count);
  if (t(a) !== t(b)) return t(b) - t(a);
  return a.offer_id < b.offer_id ? -1 : 1;
}

export const SORTS: Record<string, { label: string; explain: string }> = {
  recommended: {
    label: 'Recommended',
    explain: 'match · price · availability · trust · certification · speed',
  },
  price_low: {
    label: 'Lowest delivered price',
    explain: 'sorted on the landed price per canonical unit, delivered to your pincode — not on the seller\'s quoted figure; a price past its refresh window cannot be quoted and is listed after every current one',
  },
  best_value: {
    label: 'Best value',
    explain: '50% delivered price · 30% seller trust · 20% certification',
  },
  fastest: { label: 'Fastest delivery', explain: 'sorted on delivery lead time to your pincode' },
  freshest: { label: 'Most recently verified', explain: 'sorted on when the price was last verified' },
};

/**
 * Column-header sorts for the table view.
 *
 * These are deliberately separate from SORTS above. SORTS are five *semantic*
 * orders a buyer picks from a dropdown ("best value" is an opinion, expressed
 * as a weighting). A column header is a *mechanical* order on one field, and
 * conflating the two would put "Best value" in a column header where it means
 * nothing.
 *
 * Every entry carries an `explain`, because the interface prints it under
 * "Sorted on" — CP(E-Commerce) Rule 5(3)(f) requires the disclosed ordering to
 * be the applied one, and a header sort with no disclosure would break that.
 *
 * Sorting happens SERVER-SIDE over the whole result set, then paginates. A
 * client-side header sort would reorder only the 24 rows on screen and disagree
 * with itself on page 2.
 */
export interface ColumnSort {
  label: string;
  explain: string;
  /**
   * Drives the wording of the disclosure line. "Seller · lowest first" is
   * nonsense for a name; "A–Z" is nonsense for a price. Same arrow, different
   * sentence.
   */
  kind?: 'number' | 'text';
  value: (r: SortableRow) => number | string | null;
}

/** How a direction reads for this column, for the Rule 5(3)(f) disclosure. */
export function directionLabel(key: string, dir: 'asc' | 'desc'): string {
  const text = (COLUMN_SORTS[key]?.kind ?? 'number') === 'text';
  if (text) return dir === 'desc' ? 'Z–A' : 'A–Z';
  if (key === 'verified') return dir === 'desc' ? 'most recent first' : 'oldest first';
  return dir === 'desc' ? 'highest first' : 'lowest first';
}

/** The subset of a result row any column sort may read. */
export interface SortableRow {
  normalised_paise: number;
  landed_paise: number;
  floor_paise: number;
  median_paise: number;
  title: string;
  brand: string | null;
  vendor_name: string;
  vendor_locality: string | null;
  platform: string;
  rating: number | null;
  review_count: number | null;
  moq_qty: number | null;
  mrp_paise: number | null;
  country_of_origin: string | null;
  offer_count: number;
  vendor_count: number;
  lead_time_days: number | null;
  priced_as_of: string;
  cert_state: CertState;
  gst_rate_bp: number;
  hsn: string;
  score: number;
  attrs: Record<string, unknown>;
}

const certTier = (c: CertState) =>
  c === 'CERTIFIED' ? 4 : c === 'BRAND_LICENSED' ? 3 : c === 'NOT_APPLICABLE' ? 2 : c === 'NOT_DECLARED' ? 1 : 0;

/** A spec column reads straight out of the typed attribute tuple. */
const attr = (k: string) => (r: SortableRow) => {
  const v = r.attrs?.[k];
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'number' ? v : String(v);
};

export const COLUMN_SORTS: Record<string, ColumnSort> = {
  unit_price: { label: 'Unit price', explain: 'the delivered price per canonical unit', value: (r) => r.normalised_paise },
  landed: { label: 'Landed price', explain: 'the delivered total for one trade unit', value: (r) => r.landed_paise },
  floor: { label: 'Lowest for this product', explain: 'the cheapest seller of the same product in your city', value: (r) => r.floor_paise },
  median: { label: 'Median for this product', explain: 'the middle price across sellers of the same product', value: (r) => r.median_paise },
  product: { kind: 'text', label: 'Product', explain: 'the resolved product name, alphabetically', value: (r) => r.title.toLowerCase() },
  brand: { kind: 'text', label: 'Brand', explain: 'the resolved brand, alphabetically — unbranded listings sort last', value: (r) => r.brand?.toLowerCase() ?? null },
  seller: { kind: 'text', label: 'Seller', explain: 'the seller name, alphabetically', value: (r) => r.vendor_name.toLowerCase() },
  locality: { kind: 'text', label: 'Locality', explain: 'the seller locality, alphabetically', value: (r) => r.vendor_locality?.toLowerCase() ?? null },
  platform: { kind: 'text', label: 'Platform', explain: 'the source platform, alphabetically', value: (r) => r.platform.toLowerCase() },
  rating: { label: 'Seller rating', explain: 'the seller rating as published — only IndiaMART publishes one', value: (r) => r.rating },
  reviews: { label: 'Reviews', explain: 'how many reviews the seller rating is based on', value: (r) => r.review_count },
  moq: { label: 'MOQ', explain: 'the seller\'s minimum order quantity', value: (r) => r.moq_qty },
  offers: { label: 'Offers', explain: 'how many listings exist for this product in your city', value: (r) => r.offer_count },
  sellers: { label: 'Sellers', explain: 'how many distinct sellers carry this product in your city', value: (r) => r.vendor_count },
  eta: { label: 'Delivery', explain: 'estimated delivery lead time to your pincode', value: (r) => r.lead_time_days },
  verified: { label: 'Verified', explain: 'when this price was last verified at source', value: (r) => r.priced_as_of },
  cert: { label: 'Certification', explain: 'BIS certification state, strongest evidence first', value: (r) => certTier(r.cert_state) },
  gst: { label: 'GST', explain: 'the GST rate applied to this line', value: (r) => r.gst_rate_bp },
  hsn: { kind: 'text', label: 'HSN', explain: 'the HSN classification code', value: (r) => r.hsn },
  origin: { kind: 'text', label: 'Country of origin', explain: 'as published by the seller', value: (r) => r.country_of_origin?.toLowerCase() ?? null },
  mrp: { label: 'MRP', explain: 'the seller\'s stated MRP, where one is published', value: (r) => r.mrp_paise },
  score: { label: 'Match score', explain: 'the ranking score for your query', value: (r) => r.score },

  // Category-specific. A column only appears once its category is in play, so
  // these never sort a mixed result set on a field most rows do not have.
  cement_type: { kind: 'text', label: 'Type', explain: 'cement type (OPC / PPC / PSC)', value: attr('cement_type') },
  opc_grade: { kind: 'text', label: 'Grade', explain: 'OPC grade, where the seller states one', value: attr('opc_grade') },
  pack_size_kg: { label: 'Pack', explain: 'pack size in kilograms', value: attr('pack_size_kg') },
  diameter_mm: { label: 'Diameter', explain: 'bar diameter in millimetres', value: attr('diameter_mm') },
  pipe_system: { kind: 'text', label: 'System', explain: 'pipe system (CPVC / UPVC / SWR / HDPE / GI)', value: attr('pipe_system') },
  nominal_bore_mm: { label: 'Bore', explain: 'nominal bore in millimetres', value: attr('nominal_bore_mm') },
  length_m: { label: 'Length', explain: 'length in metres', value: attr('length_m') },
  block_type: { kind: 'text', label: 'Block type', explain: 'the kind of brick or block', value: attr('block_type') },
  size_mm: { kind: 'text', label: 'Size', explain: 'nominal size in millimetres', value: attr('size_mm') },
  density_kg_m3: { label: 'Density', explain: 'dry density in kg/m³', value: attr('density_kg_m3') },
  material: { kind: 'text', label: 'Material', explain: 'material, as published by the seller', value: attr('material') },
  color: { kind: 'text', label: 'Colour', explain: 'colour, as published by the seller', value: attr('color') },
  supply_type: { kind: 'text', label: 'Supply type', explain: 'whether the seller states they manufacture or resell', value: attr('supply_type') },
  trade_type: { kind: 'text', label: 'Trade type', explain: 'trade or non-trade pricing, as published', value: attr('trade_type') },
};

/**
 * One comparator for every column.
 *
 * **Nulls sort last in BOTH directions**, deliberately. "Unknown" is not a
 * value at either end of a range: someone sorting rating descending wants the
 * best-rated sellers first, not a wall of the 49% who publish no rating, and
 * someone sorting ascending wants the worst-rated — also not the unrated.
 *
 * The alternative in VendorTable today is a per-column fudge — MAX_SAFE_INTEGER
 * for a missing MOQ, 99 for a missing ETA, and a negated rating so that
 * "ascending" silently means descending. Three columns, three meanings of the
 * same arrow.
 */
export function columnComparator(key: string, dir: 1 | -1): (a: SortableRow, b: SortableRow) => number {
  const col = COLUMN_SORTS[key];
  if (!col) return () => 0;
  return (ra, rb) => {
    const a = col.value(ra);
    const b = col.value(rb);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * dir;
    return String(a).localeCompare(String(b)) * dir;
  };
}
