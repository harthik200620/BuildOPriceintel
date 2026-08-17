import type { Paise } from './money';
import type { FreshnessState } from './freshness';

export type Confidence = 'quoted' | 'derived' | 'typical' | 'unknown';
export type CertState = 'CERTIFIED' | 'BRAND_LICENSED' | 'NOT_DECLARED' | 'NOT_APPLICABLE' | 'EXPIRED';
export type DeliveryScope = 'EX_WORKS' | 'DELIVERED_ZONE' | 'DELIVERED_SITE';
export type GstTreatment = 'INCL' | 'EXCL';

export const CATEGORIES = ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<string, string> = {
  cement: 'Cement',
  tmt_steel: 'TMT steel',
  water_pipes: 'Water pipes',
  bricks_blocks: 'Bricks & blocks',
};

/**
 * The basis every listing states. A constant, and client-safe, so the page
 * can print it on its first paint rather than after the first fetch — the
 * same words arriving later would shift everything under them.
 */
export const COMPARABILITY_NOTE =
  'Every price on this page is a delivered total to your pincode, inclusive of GST at the stated HSN rate, ' +
  'expressed per canonical unit. Prices are only ever sorted against each other on that one basis.';

/**
 * The price object. Nothing in this application may state a rupee figure
 * without one of these, and it cannot be constructed without a unit, a
 * delivery scope, a GST treatment and a timestamp — which is law 2 enforced
 * by the type system rather than by review.
 */
export interface PriceBasis {
  base_paise: Paise;
  gst_paise: Paise;
  gst_rate_bp: number;
  hsn: string;
  freight_paise: Paise;
  handling_paise: Paise;
  loading_paise: Paise;
  /** base + gst + freight + handling + loading. The number we rank and bill on. */
  landed_paise: Paise;
  trade_unit: string;
  normalised_unit: string;
  normalised_paise: Paise;
  delivery_scope: DeliveryScope;
  gst_treatment: GstTreatment;
  priced_as_of: string;
  freshness_state: FreshnessState;
  sla_hours: number;
  confidence: Confidence;
  source_url: string;
}

/** A field the UI may render, with its provenance. No provenance, no render. */
export interface ProvenancedValue {
  field: string;
  label: string;
  value: string;
  unit: string | null;
  source_url: string;
  fetched_at: string;
  confidence: Confidence;
  derivation: string | null;
}

export interface VendorRow {
  vendor_id: string;
  name: string;
  platform: string;
  seller_type: string;
  locality: string | null;
  city: string | null;
  region_id: string | null;
  rating: number | null;
  review_count: number | null;
  profile_url: string | null;
  geo_confidence: Confidence;
}

/** One listing this seller also has for the same product, rolled up behind their row. */
export interface AlsoListed {
  offer_id: string;
  source_url: string;
  listing_title: string | null;
  base_paise: Paise;
  base_unit: string;
  normalised_paise: Paise;
}

export interface OfferView {
  offer_id: string;
  vendor: VendorRow;
  platform: string;
  source_url: string;
  /** The seller's own words for this listing — product.title is synthesised. */
  listing_title: string | null;
  /**
   * The seller's other listings for this product, at their prices. The vendor
   * table shows one row per vendor; these are what that row rolled up, and
   * every one keeps its source URL so nothing collected becomes unreachable.
   */
  also_listed?: AlsoListed[];
  base_paise: Paise;
  base_unit: string;
  gst_treatment: GstTreatment;
  gst_rate_bp: number;
  hsn: string;
  mrp_paise: Paise | null;
  delivery_scope: DeliveryScope;
  freight_paise: Paise;
  handling_paise: Paise;
  loading_paise: Paise;
  landed_paise: Paise;
  normalised_unit: string;
  normalised_paise: Paise;
  moq_qty: number | null;
  moq_unit: string | null;
  bulk_slabs: Array<{ min_qty: number; max_qty: number | null; paise: Paise }> | null;
  stock_state: string;
  lead_time_days: number | null;
  cert_state: CertState;
  cert_ref: string | null;
  cert_valid_to: string | null;
  rating: number | null;
  review_count: number | null;
  fetched_at: string;
  freshness_state: FreshnessState;
  freight_basis: string;
  freight_breakdown: Array<{ step: string; detail: string; value?: string }>;
  comparable: boolean;
  comparability_reason: string | null;
}

export interface ProductCard {
  product_id: string;
  category: Category;
  title: string;
  brand: string | null;
  image_url: string | null;
  /**
   * Up to five product photographs, pooled across every seller of this product
   * with this card's own listing first. Local paths under /img — downloaded at
   * collection time, so viewing a card makes no third-party request.
   */
  images: string[];
  spec_chips: string[];
  unit_canonical: string;
  /** The hero number — largest type on the card. */
  normalised_paise: Paise;
  /** One line beneath it. */
  landed_paise: Paise;
  trade_unit: string;
  floor_paise: Paise;
  ceiling_paise: Paise;
  median_paise: Paise;
  offer_count: number;
  vendor_count: number;
  best_vendor: string;
  /**
   * A card is one SELLER'S offer, so these say whose price this is. The results
   * list emits one card per vendor; `also_from_vendor` counts this seller's
   * other listings that matched the same query and the same filters, so a
   * rolled-up row still tells you what it rolled up.
   */
  offer_id: string;
  vendor_id: string;
  vendor_locality: string | null;
  platform: string;
  listing_title: string | null;
  source_url: string;
  also_from_vendor: number;
  lead_time_days: number | null;
  cert_state: CertState;
  qco_regulated: boolean;
  priced_as_of: string;
  freshness_state: FreshnessState;
  freshness_dot: 'green' | 'amber' | 'grey';
  freshness_label: string;
  sla_hours: number;
  gst_rate_bp: number;
  hsn: string;
  delivery_scope: DeliveryScope;
  gst_treatment: GstTreatment;

  /**
   * Table columns. The card shows a deliberately small set; the table view
   * shows these too, each header stating its own coverage so a column that is
   * populated on 9% of rows says so rather than looking broken.
   *
   * `rating`, `review_count` and `moq_qty` were already selected by DISPLAY_SQL
   * and dropped on the floor when the card object was built — they cost nothing.
   */
  rating: number | null;
  review_count: number | null;
  moq_qty: number | null;
  moq_unit: string | null;
  /** Only BigBMart publishes an MRP, so a discount is computable for ~10%. */
  mrp_paise: Paise | null;
  country_of_origin: string | null;
  /**
   * The typed attribute tuple, already parsed for faceting. Carried so the
   * table can render category-specific spec columns — cement grade, pipe bore,
   * block type — without a second round trip.
   */
  attrs: Record<string, string | number | boolean | null>;

  /** Rule 5(3)(f): the top two contributing ranking features, in plain language. */
  why: string[];
  score: number;
}

export interface SearchResponse {
  query: {
    raw: string;
    parsed: ParsedQuery;
    corrected_from: string | null;
    region_id: string;
    pincode: string;
  };
  intent_chips: Array<{ label: string; category: string; count: number }>;
  results: ProductCard[];
  total: number;
  facets: FacetView[];
  comparability_note: string | null;
  sor_anchor: SorAnchor | null;
  zero_result: ZeroResult | null;
  disclosure: { sort: string; explanation: string };
  timings: Record<string, number>;
}

export interface SorAnchor {
  state_code: string;
  item: string;
  rate_paise: Paise;
  unit: string;
  effective_period: string;
  source_url: string;
  note: string | null;
}

export interface ZeroResult {
  reason: string;
  relaxed: string[];
  suggestions: string[];
  nearest_category: string | null;
}

export interface ParsedQuery {
  tokens: string[];
  category: Category | null;
  constraints: Record<string, string | number>;
  intent: 'browse' | 'price';
  matched_vocabulary: Array<{ term: string; means: string; script: string }>;
  unit_bearing: boolean;
}

export interface FacetValueView {
  label: string;
  sublabel: string | null;
  unit: string | null;
  count: number;
  disabled: boolean;
  selected: boolean;
  reveals: string[];
}

export interface FacetView {
  facet_id: string;
  facet_key: string;
  label: string;
  type: 'single' | 'multi' | 'range' | 'boolean';
  control: string;
  cluster: string;
  visibility: 'primary' | 'more' | 'conditional';
  sort_order: number;
  depends_on: { facet: string; value: string } | null;
  default_open: boolean;
  default_state: string | null;
  why: string | null;
  note: string | null;
  needs_verification: string | null;
  values: FacetValueView[];
  active: boolean;
}
