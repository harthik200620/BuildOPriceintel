/**
 * The collection contract.
 *
 * Every adapter produces RawOffer rows and nothing else. Raw rows are written
 * to collector/raw/<source>-<date>.jsonl verbatim before any normalisation, so
 * that a parser change can be replayed against archived bodies rather than
 * re-fetched — and so that any figure on screen can be traced back to the exact
 * text the source published.
 */

export type SourceClass =
  | 'marketplace' | 'b2b_directory' | 'platform' | 'brand' | 'government' | 'dealer' | 'tracker';

export type FetchMode = 'http' | 'browser' | 'assisted';

export type Outcome =
  | 'ok' | 'blocked' | 'rate_limited' | 'login_wall' | 'parse_fail' | 'empty' | 'skipped' | 'captcha';

export interface RawOffer {
  source_id: string;
  source_class: SourceClass;
  fetch_mode: FetchMode;
  source_url: string;
  /** Stable identifier for this listing within the source. */
  source_ref: string;
  fetched_at: string;
  region_id: string;
  category: string;
  platform: string;

  title: string;
  brand?: string | null;

  vendor_name: string;
  vendor_locality?: string | null;
  vendor_city?: string | null;
  vendor_profile_url?: string | null;
  vendor_rating?: number | null;
  vendor_review_count?: number | null;
  seller_type?: string | null;

  /** Verbatim, exactly as the page rendered it. Kept for audit. */
  price_text: string;
  price_paise?: number | null;
  /** The unit the seller quoted in — 'Bag', 'Piece', 'Kg', 'Ton', 'Metre', 'Piece'. */
  price_unit?: string | null;
  gst_treatment?: 'INCL' | 'EXCL' | null;
  gst_note?: string | null;
  mrp_paise?: number | null;

  moq_text?: string | null;
  moq_qty?: number | null;
  moq_unit?: string | null;
  bulk_slabs?: Array<{ min_qty: number; max_qty: number | null; paise: number }> | null;

  stock_state?: string | null;
  lead_time_days?: number | null;

  /** Verbatim spec pairs from the source, before any typing. */
  specs: Record<string, string>;

  images?: string[];
  datasheet_url?: string | null;
  cert_text?: string | null;
}

export interface SourceResult {
  source_id: string;
  source_class: SourceClass;
  category: string | null;
  region_id: string | null;
  url: string;
  fetch_mode: FetchMode;
  http_status: number | null;
  outcome: Outcome;
  offers: RawOffer[];
  pages_fetched: number;
  pagination_exhausted: boolean | null;
  /**
   * Honest estimate of volume NOT captured, when something bounded the work.
   * A quiet cap reads as "we covered everything" when we didn't.
   */
  estimated_missed: number | null;
  note: string | null;
}

export interface Adapter {
  id: string;
  source_class: SourceClass;
  /** Human label for the log. */
  label: string;
  /** Which (category, region) pairs this adapter can serve. */
  covers: Array<{ category: string; region_id: string }>;
  run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]>;
}

export interface AdapterCtx {
  // The full FetchResult, not a narrowed shape. Narrowing it here is why the
  // 429 log line printed "host gap widened to ? ms" — `throttledTo` carries the
  // real backoff and was being type-erased before the adapter could read it.
  fetchText(url: string, opts?: { retries?: number }): Promise<import('./fetch').FetchResult>;
  log(msg: string): void;
  /** Pass number — adapters can widen their sweep on later passes. */
  pass: number;
}
