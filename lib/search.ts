/**
 * Retrieval, faceting and the zero-result ladder.
 *
 * Hybrid in the local sense: FTS5 BM25 for lexical matching plus a trigram
 * index for typo tolerance, score-normalised and fused — not RRF, because
 * normalisation is the accuracy choice and we have the vocabulary to keep it
 * tuned. Typed constraints from the query grammar are applied as filters
 * BEFORE scoring, never as text.
 *
 * No network. Everything here is a prepared statement against a local file.
 */
import { prep, db } from './db';
import { parseQuery, relaxationOrder, type ParseResult } from './query/parse';
import {
  score, hardFiltered, SORTS, COLUMN_SORTS, columnComparator, directionLabel,
  type Candidate, type Scored, type SortableRow,
} from './rank';
import { assess, SLA_HOURS, CATEGORY_VOLATILITY } from './freshness';
import { CATEGORY_LABEL, type FacetView, type FacetValueView, type ProductCard, type SearchResponse, type SorAnchor } from './types';

export interface SearchInput {
  q: string;
  pincode: string;
  region_id: string;
  category?: string | null;
  facets?: Record<string, string[]>;
  sort?: string;
  /**
   * A table column header, from COLUMN_SORTS. Separate from `sort` because a
   * header is a mechanical order on one field while `sort` is a semantic order
   * a buyer chooses ("best value" is a weighting, not a column). When this is
   * set it wins, and the disclosure line names the column rather than the
   * dropdown — the applied order and the disclosed order must be the same one.
   */
  column_sort?: string | null;
  column_dir?: 'asc' | 'desc' | null;
  qty?: number;
  limit?: number;
  offset?: number;
  /**
   * Show every matching offer from ONE seller, ungrouped.
   *
   * The results list is one card per vendor, which means a category supplied by
   * a single seller collapses to a single card. Without this, that seller's
   * other 31 listings would be unreachable — the roll-up would be hiding stock
   * rather than organising it. The card's "+N more from this seller" sets it.
   */
  vendor_id?: string;
}

/**
 * One row per OFFER, carrying only what filtering, faceting and ranking read.
 *
 * The results list is a list of sellers, so retrieval, the typed constraints and
 * the facet counts all have to operate on offers — that is what makes "a
 * different vendor on every row" survive a filter, rather than being a sort
 * applied to a product list after the fact.
 *
 * Going offer-level multiplied the row count, which made the width of this row
 * matter: the vendor join, the price_current join and every display-only column
 * were being materialised for ~800 rows so that 24 could be rendered. They moved
 * to DISPLAY_SQL below, fetched for the page alone.
 */
interface Row {
  product_id: string; category: string; brand: string | null;
  attrs: string; qco_regulated: number; cert_standards: string;
  offer_id: string; vendor_id: string; normalised_paise: number;
  priced_as_of: string; sla_hours: number; gst_treatment: string;
  stock_state: string; lead_time_days: number | null;
  rating: number | null; review_count: number | null;
  cert_state: string; moq_qty: number | null;
  rel?: number;
}

/** Everything a card renders, fetched only for the offers actually on the page. */
interface DisplayRow extends Row {
  title: string; unit_canonical: string; image_url: string | null;
  hsn: string; gst_rate_bp: number;
  landed_paise: number; floor_paise: number; ceiling_paise: number; median_paise: number;
  offer_count: number; vendor_count: number;
  delivery_scope: string;
  vendor_name: string; vendor_locality: string | null;
  platform: string; listing_title: string | null; source_url: string;
  moq_unit: string | null; mrp_paise: number | null; country_of_origin: string | null;
}

const BASE_SQL = `
  SELECT p.product_id, p.category, p.brand, p.attrs, p.qco_regulated, p.cert_standards,
         op.offer_id, op.vendor_id, op.normalised_paise, op.priced_as_of, op.sla_hours,
         op.gst_treatment, o.stock_state,
         -- Where a seller publishes no lead time, the freight model's solve is
         -- used rather than leaving the card reading "ETA on request" forever.
         COALESCE(o.lead_time_days, s.lead_time_days) AS lead_time_days,
         o.rating, o.review_count, o.cert_state, o.moq_qty
    FROM offer_price op
    JOIN offer   o ON o.offer_id   = op.offer_id
    JOIN product p ON p.product_id = op.product_id
    LEFT JOIN serviceability s ON s.offer_id = op.offer_id AND s.region_id = op.region_id
   WHERE op.region_id = ? AND o.is_active = 1`;

/**
 * The extra scalars a column-header sort orders on.
 *
 * These are NOT in BASE_SQL, and the difference was measured rather than
 * assumed. Carrying them on every candidate row cost ~2 ms of p95 and pushed
 * cement past its own 20 ms line, to buy something the overwhelming majority of
 * queries never use — nobody sorts by seller name while typing.
 *
 * They are also not in DISPLAY_SQL, which fetches one page: a sort that can only
 * see 24 rows reorders the window rather than the result, and page 2 would
 * disagree with page 1.
 *
 * So: fetched lazily, on the first column sort, and cached per (region,
 * category) against the same `PRAGMA data_version` stamp as the base rows.
 */
const SORT_SQL = `
  SELECT op.offer_id, op.landed_paise, p.title, p.hsn, p.gst_rate_bp, p.country_of_origin,
         o.moq_unit, o.mrp_paise, o.platform,
         v.name AS vendor_name, v.locality AS vendor_locality,
         pc.floor_paise, pc.median_paise, pc.offer_count, pc.vendor_count
    FROM offer_price op
    JOIN offer   o ON o.offer_id   = op.offer_id
    JOIN product p ON p.product_id = op.product_id
    JOIN vendor  v ON v.vendor_id  = op.vendor_id
    LEFT JOIN price_current pc ON pc.product_id = op.product_id AND pc.region_id = op.region_id
   WHERE op.region_id = ? AND o.is_active = 1`;

interface SortRow {
  offer_id: string; landed_paise: number; title: string; hsn: string; gst_rate_bp: number;
  country_of_origin: string | null; moq_unit: string | null; mrp_paise: number | null;
  platform: string; vendor_name: string; vendor_locality: string | null;
  floor_paise: number | null; median_paise: number | null;
  offer_count: number | null; vendor_count: number | null;
}

/** price_current supplies the product-level floor/ceiling/median the card shows as a range. */
const DISPLAY_SQL = `
  SELECT p.product_id, p.category, p.brand, p.attrs, p.qco_regulated,
         p.title, p.unit_canonical, p.image_url, p.hsn, p.gst_rate_bp,
         p.country_of_origin, o.moq_unit, o.mrp_paise,
         op.offer_id, op.vendor_id, op.normalised_paise, op.landed_paise,
         op.priced_as_of, op.sla_hours, op.delivery_scope, op.gst_treatment,
         pc.floor_paise, pc.ceiling_paise, pc.median_paise, pc.offer_count, pc.vendor_count,
         v.name AS vendor_name, v.locality AS vendor_locality,
         o.platform, o.listing_title, o.source_url, o.stock_state,
         COALESCE(o.lead_time_days, s.lead_time_days) AS lead_time_days,
         o.rating, o.review_count, o.cert_state, o.moq_qty
    FROM offer_price op
    JOIN offer   o ON o.offer_id   = op.offer_id
    JOIN product p ON p.product_id = op.product_id
    JOIN vendor  v ON v.vendor_id  = op.vendor_id
    LEFT JOIN price_current pc ON pc.product_id = op.product_id AND pc.region_id = op.region_id
    LEFT JOIN serviceability s ON s.offer_id = op.offer_id AND s.region_id = op.region_id
   WHERE op.region_id = ? AND op.offer_id IN (SELECT value FROM json_each(?))`;

/**
 * The candidate set for a (region, category) only changes when the price
 * surface is rebuilt, and search never writes. So it is read once and reused.
 *
 * `PRAGMA data_version` is what makes this safe rather than merely fast: SQLite
 * bumps it whenever *another connection* commits, so a collection run in a
 * separate process invalidates this cache without needing to signal the web
 * process. A wall-clock TTL would have served a stale catalogue for its
 * duration; an in-process counter would never have seen the collector at all.
 *
 * The rows are shared across requests, which is sound because the only thing
 * written to a row is `attrOf`'s `_attrs` memo — idempotent, and now paid once
 * for the life of the catalogue instead of once per request.
 *
 * A vendor drill-down is deliberately not cached: it is a narrow query and one
 * entry per vendor visited would grow without bound.
 */
const baseCache = new Map<string, Row[]>();
let baseCacheVersion = -1;

/**
 * `data_version` only moves for writes from *another* connection, so a rebuild
 * running inside this same process would leave the cache stale. In practice the
 * collector is a separate process and the pragma covers it, but relying on that
 * would make correctness a deployment detail. `rebuildPrices` calls this.
 */
export function invalidateSearchCache(): void {
  baseCache.clear();
  sortCache.clear();
  baseCacheVersion = -1;
}

function baseRows(region_id: string, category: string | null, vendor_id: string | null): Row[] {
  const sql = BASE_SQL + (category ? ` AND p.category = ?` : '') + (vendor_id ? ` AND op.vendor_id = ?` : '');
  const args = [region_id, ...(category ? [category] : []), ...(vendor_id ? [vendor_id] : [])];
  if (vendor_id) return prep(sql).all(...args) as Row[];

  const v = (prep(`PRAGMA data_version`).get() as any).data_version as number;
  if (v !== baseCacheVersion) { baseCache.clear(); sortCache.clear(); baseCacheVersion = v; }

  const key = `${region_id}|${category ?? ''}`;
  const hit = baseCache.get(key);
  if (hit) return hit;
  const rows = prep(sql).all(...args) as Row[];
  baseCache.set(key, rows);
  return rows;
}

/** Sort-only columns, fetched on first use and cached alongside the base rows. */
const sortCache = new Map<string, Map<string, SortRow>>();

function sortRows(region_id: string, category: string | null): Map<string, SortRow> {
  // Shares `baseCacheVersion`, which `baseRows` has already refreshed this
  // request — so both caches invalidate on the same catalogue write.
  const key = `${region_id}|${category ?? ''}`;
  const hit = sortCache.get(key);
  if (hit) return hit;
  const rows = prep(SORT_SQL + (category ? ` AND p.category = ?` : ''))
    .all(...[region_id, ...(category ? [category] : [])]) as SortRow[];
  const m = new Map(rows.map((r) => [r.offer_id, r]));
  sortCache.set(key, m);
  return m;
}

/** A candidate row in the shape a column comparator reads. */
function sortableOf(r: Row, s: SortRow | undefined): SortableRow {
  return {
    normalised_paise: r.normalised_paise,
    landed_paise: s?.landed_paise ?? r.normalised_paise,
    floor_paise: s?.floor_paise ?? r.normalised_paise,
    median_paise: s?.median_paise ?? r.normalised_paise,
    title: s?.title ?? '',
    brand: r.brand,
    vendor_name: s?.vendor_name ?? '',
    vendor_locality: s?.vendor_locality ?? null,
    platform: s?.platform ?? '',
    rating: r.rating,
    review_count: r.review_count,
    moq_qty: r.moq_qty,
    mrp_paise: s?.mrp_paise ?? null,
    country_of_origin: s?.country_of_origin ?? null,
    offer_count: s?.offer_count ?? 1,
    vendor_count: s?.vendor_count ?? 1,
    lead_time_days: r.lead_time_days,
    priced_as_of: r.priced_as_of,
    cert_state: r.cert_state as any,
    gst_rate_bp: s?.gst_rate_bp ?? 0,
    hsn: s?.hsn ?? '',
    score: 0,
    attrs: attrOf(r),
  };
}

/** Lexical + trigram retrieval, score-normalised and fused. */
function retrieve(parsed: ParseResult, region_id: string): Map<string, number> {
  const rel = new Map<string, number>();
  if (!parsed.ftsExpr) return rel;

  let lex: Array<{ product_id: string; s: number }> = [];
  try {
    lex = prep(
      `SELECT product_id, -bm25(product_fts, 6.0, 4.0, 1.0) AS s
         FROM product_fts WHERE product_fts MATCH ? ORDER BY s DESC LIMIT 600`,
    ).all(parsed.ftsExpr) as any[];
  } catch { /* a malformed MATCH degrades to trigram, never to an error page */ }

  let trg: Array<{ product_id: string; s: number }> = [];
  try {
    trg = prep(
      `SELECT product_id, -bm25(product_trgm) AS s
         FROM product_trgm WHERE product_trgm MATCH ? ORDER BY s DESC LIMIT 400`,
    ).all(parsed.trgmExpr) as any[];
  } catch { /* trigram MATCH is fussy about short tokens; lexical alone is fine */ }

  const norm = (rows: Array<{ product_id: string; s: number }>) => {
    if (!rows.length) return new Map<string, number>();
    const vals = rows.map((r) => r.s);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || 1;
    return new Map(rows.map((r) => [r.product_id, (r.s - lo) / span]));
  };

  const L = norm(lex), T = norm(trg);
  for (const id of new Set([...L.keys(), ...T.keys()])) {
    // Lexical carries the signal; trigram exists to rescue typos, so it is
    // weighted lower rather than allowed to outvote an exact match.
    rel.set(id, 0.75 * (L.get(id) ?? 0) + 0.25 * (T.get(id) ?? 0));
  }
  return rel;
}

/**
 * Parsed attributes, memoised on the row.
 *
 * Every facet asks each row for its attribute, so a bare JSON.parse here runs
 * facets × rows times — 13 × 627 ≈ 8,000 parses for one cement query, and it
 * was the single largest cost in the query layer once results went offer-level.
 * Rows are fresh objects from better-sqlite3 on every query, so the cache
 * cannot outlive the request that built it.
 */
function attrOf(row: Row): Record<string, unknown> {
  const cached = (row as any)._attrs as Record<string, unknown> | undefined;
  if (cached) return cached;
  let v: Record<string, unknown>;
  try { v = JSON.parse(row.attrs || '{}'); } catch { v = {}; }
  (row as any)._attrs = v;
  return v;
}

/** Typed constraints are filters, not text. */
function matchesConstraints(row: Row, constraints: Record<string, string | number>): { ok: boolean; matched: number; total: number } {
  const a = attrOf(row);
  const keys = Object.keys(constraints).filter((k) => !k.startsWith('_'));
  if (!keys.length) return { ok: true, matched: 0, total: 0 };
  let matched = 0;
  for (const k of keys) {
    const want = constraints[k];
    if (k === 'brand') { if (String(row.brand ?? '').toLowerCase() === String(want).toLowerCase()) matched++; continue; }
    const got = a[k];
    if (got === undefined || got === null) continue;
    if (typeof want === 'number' ? Number(got) === want : String(got).toLowerCase() === String(want).toLowerCase()) matched++;
  }
  return { ok: matched > 0 || keys.length === 0, matched, total: keys.length };
}

function facetValueOf(row: Row, facetKey: string): string | null {
  const a = attrOf(row);
  if (facetKey.startsWith('attrs.')) {
    const v = a[facetKey.slice(6)];
    return v === null || v === undefined || v === '' ? null : String(v);
  }
  if (facetKey === 'product.brand') return row.brand;
  if (facetKey === 'product.producer_type') {
    const v = a.producer_type;
    return v === null || v === undefined || v === '' ? null : String(v);
  }
  if (facetKey === 'offer.cert_state') {
    return row.cert_state === 'CERTIFIED' ? 'Licence number on file'
      : row.cert_state === 'BRAND_LICENSED' ? 'BIS-licensed brand, licence not quoted'
        : row.cert_state === 'NOT_APPLICABLE' ? 'Not applicable'
          : row.cert_state === 'CERTIFIED' ? 'Certified' : 'Not declared';
  }
  if (facetKey === 'serviceability.lead_time_days') {
    const d = row.lead_time_days ?? 3;
    return d <= 1 ? 'Tomorrow' : d <= 3 ? 'Within 3 days' : d <= 7 ? 'Within a week' : 'Scheduled delivery';
  }
  if (facetKey === 'price_current.freshness_state') {
    const h = assess(row.priced_as_of, row.sla_hours).ageHours;
    return h < 24 ? 'Verified today' : h < 72 ? 'Within 3 days' : h < 168 ? 'Within a week' : null;
  }
  if (facetKey === 'price_current.normalised_paise') return String(row.normalised_paise);
  if (facetKey === 'offer.gst_treatment') return row.gst_treatment === 'INCL' ? 'Inclusive of GST' : 'Exclusive of GST';
  if (facetKey === 'product.pack_size') {
    const v = a.pack_size_kg;
    return v === null || v === undefined ? null : String(v);
  }
  if (facetKey === 'product.cert_standards') {
    try { return (JSON.parse(row.cert_standards || '[]') as string[])[0] ?? null; } catch { return null; }
  }
  if (facetKey === 'product.country_of_origin') return 'Not published by seller';
  if (facetKey === 'offer.bulk_slabs') return null;
  return null;
}

function priceBandOf(row: Row, values: Array<{ label: string }>): string | null {
  const r = row.normalised_paise / 100;
  for (const v of values) {
    const m = v.label.match(/Under ₹([\d,]+)/);
    if (m && r < Number(m[1].replace(/,/g, ''))) return v.label;
    const m2 = v.label.match(/₹([\d,]+)\s*–\s*₹([\d,]+)/);
    if (m2 && r >= Number(m2[1].replace(/,/g, '')) && r < Number(m2[2].replace(/,/g, ''))) return v.label;
    const m3 = v.label.match(/Over ₹([\d,]+)/);
    if (m3 && r >= Number(m3[1].replace(/,/g, ''))) return v.label;
  }
  return null;
}

const numOf = (s: string): number | null => {
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * Does a row belong under a facet value?
 *
 * The facet labels are written in the buyer's language ("8 mm", "12 m
 * standard", "3 – 4 N/mm²", "50 kg bag") while the stored attribute is a bare
 * number. Comparing the two as strings makes every one of those facets read
 * zero — a filter with nothing behind it, which the brief rightly calls a
 * defect. So the comparison is typed: numeric labels compare numerically,
 * range labels compare as intervals, everything else compares as text.
 */
function valueMatches(row: Row, facet: any, label: string, defs: Array<{ label: string }>): boolean {
  const key: string = facet.facet_key;

  if (key === 'price_current.normalised_paise') return priceBandOf(row, defs) === label;

  const raw = facetValueOf(row, key);
  if (raw === null) return false;

  // A dimension triple is a name, not a quantity. Comparing "600×200×100"
  // numerically matches on its leading 600 and makes every AAC size count the
  // same, which is worse than useless — it is a filter that looks alive and
  // narrows nothing.
  if (/\d\s*[×x]\s*\d/.test(raw)) {
    return raw.replace(/\s|x/gi, '×').toLowerCase() === label.replace(/\s|x/gi, '×').toLowerCase();
  }

  // Interval labels: "3 – 4 N/mm²", "Under 700 kg/m³", "Over 10 N/mm²".
  const asNum = numOf(raw);
  if (asNum !== null) {
    const range = label.match(/(-?[\d.]+)\s*[–-]\s*(-?[\d.]+)/);
    if (range) return asNum >= Number(range[1]) && asNum <= Number(range[2]);
    const under = label.match(/^Under\s+([\d.,]+)/i);
    if (under) return asNum < Number(under[1].replace(/,/g, ''));
    const over = label.match(/^Over\s+([\d.,]+)/i);
    if (over) return asNum > Number(over[1].replace(/,/g, ''));
    const lead = numOf(label);
    // "8 mm" vs 8, "50 kg bag" vs 50, "12 m standard" vs 12
    if (lead !== null) return Math.abs(asNum - lead) < 1e-9;
  }

  return raw.toLowerCase() === label.toLowerCase();
}

function selectionMatches(row: Row, facet: any, selected: string[]): boolean {
  if (!selected.length) return true;
  const defs = JSON.parse(facet.values_json) as Array<{ label: string }>;
  return selected.some((s) => valueMatches(row, facet, s, defs));
}

/* ── compiled faceting ────────────────────────────────────────────────────────
 *
 * valueMatches() above is the readable definition of the comparison and stays
 * the single source of truth for what a match *means*. What follows is the same
 * predicate with the work hoisted out of the inner loop, because the naive shape
 * is O(facets × values × rows) with a regex parse and a JSON.parse on every
 * step — fine at 40 products, 17 ms p95 at 163.
 *
 * Three things move out of the row loop and nothing about the semantics changes:
 *   - each label's range/under/over/lead patterns are parsed once, not per row;
 *   - facetValueOf() runs once per (facet, row) instead of once per value;
 *   - values_json is parsed once per facet instead of once per row per facet.
 *
 * tests/run.ts asserts compiled counts equal the valueMatches() counts.
 */
const TRIPLE_RE = /\d\s*[×x]\s*\d/;
const normTriple = (s: string) => s.replace(/\s|x/gi, '×').toLowerCase();

interface CompiledValue {
  label: string; lower: string; tripleNorm: string;
  range: [number, number] | null; under: number | null; over: number | null; lead: number | null;
}

interface CompiledFacet {
  facet: any; key: string; isPrice: boolean;
  defs: Array<{ label: string; sublabel?: string; unit?: string; reveals?: string[] }>;
  vals: CompiledValue[]; selected: string[]; selVals: CompiledValue[];
}

function compileValue(label: string): CompiledValue {
  const range = label.match(/(-?[\d.]+)\s*[–-]\s*(-?[\d.]+)/);
  const under = label.match(/^Under\s+([\d.,]+)/i);
  const over = label.match(/^Over\s+([\d.,]+)/i);
  return {
    label, lower: label.toLowerCase(), tripleNorm: normTriple(label),
    range: range ? [Number(range[1]), Number(range[2])] : null,
    under: under ? Number(under[1].replace(/,/g, '')) : null,
    over: over ? Number(over[1].replace(/,/g, '')) : null,
    lead: numOf(label),
  };
}

function compileFacet(f: any, selected: string[]): CompiledFacet {
  const defs = JSON.parse(f.values_json) as CompiledFacet['defs'];
  return {
    facet: f, key: f.facet_key, isPrice: f.facet_key === 'price_current.normalised_paise',
    defs, vals: defs.map((d) => compileValue(d.label)),
    selected, selVals: selected.map(compileValue),
  };
}

/** Everything about a row that every value of one facet would otherwise recompute. */
interface RowCtx { band: string | null; raw: string | null; lower: string; norm: string; triple: boolean; num: number | null }

function rowCtx(row: Row, c: CompiledFacet): RowCtx {
  if (c.isPrice) return { band: priceBandOf(row, c.defs), raw: null, lower: '', norm: '', triple: false, num: null };
  const raw = facetValueOf(row, c.key);
  if (raw === null) return { band: null, raw: null, lower: '', norm: '', triple: false, num: null };
  const triple = TRIPLE_RE.test(raw);
  return { band: null, raw, lower: raw.toLowerCase(), norm: triple ? normTriple(raw) : '', triple, num: numOf(raw) };
}

/**
 * Test hook: every (row, facet, value) triple in a real category, decided both
 * ways. The compiled path is only a legitimate optimisation if it agrees with
 * valueMatches() on all of them — asserted by tests/run.ts.
 */
export function __facetEquivalence(region_id: string, category: string): { checked: number; mismatches: string[] } {
  const rows = prep(BASE_SQL + ` AND p.category = ?`).all(region_id, category) as Row[];
  const facets = prep(`SELECT * FROM facet_definition WHERE category = ? ORDER BY sort_order`).all(category) as any[];
  const mismatches: string[] = [];
  let checked = 0;
  for (const f of facets) {
    const c = compileFacet(f, []);
    for (const row of rows) {
      const ctx = rowCtx(row, c);
      for (let i = 0; i < c.vals.length; i++) {
        const compiledSays = ctxMatches(ctx, c.vals[i], c.isPrice);
        const naiveSays = valueMatches(row, f, c.defs[i].label, c.defs);
        checked++;
        if (compiledSays !== naiveSays) {
          mismatches.push(`${f.facet_key} / "${c.defs[i].label}" / ${row.product_id}: compiled=${compiledSays} naive=${naiveSays}`);
        }
      }
    }
  }
  return { checked, mismatches };
}

/** The branch order here mirrors valueMatches() exactly. */
function ctxMatches(ctx: RowCtx, v: CompiledValue, isPrice: boolean): boolean {
  if (isPrice) return ctx.band === v.label;
  if (ctx.raw === null) return false;
  if (ctx.triple) return ctx.norm === v.tripleNorm;
  if (ctx.num !== null) {
    if (v.range) return ctx.num >= v.range[0] && ctx.num <= v.range[1];
    if (v.under !== null) return ctx.num < v.under;
    if (v.over !== null) return ctx.num > v.over;
    if (v.lead !== null) return Math.abs(ctx.num - v.lead) < 1e-9;
  }
  return ctx.lower === v.lower;
}

/**
 * One card per vendor — the results list is a list of sellers.
 *
 * Applied AFTER scoring and AFTER the facet selections, which is the whole
 * point: filtering to "Brand = UltraTech" narrows which offers qualify, and the
 * page is still one row per seller rather than one seller's twelve listings.
 * Each vendor is represented by their best-scoring qualifying offer, and the
 * count of what was rolled up rides along so nothing is hidden.
 */
function groupByVendor(scored: Scored[]): Scored[] {
  const best = new Map<string, Scored>();
  const extra = new Map<string, number>();
  for (const s of scored) {
    const cur = best.get(s.vendor_id);
    if (!cur) best.set(s.vendor_id, s);
    else extra.set(s.vendor_id, (extra.get(s.vendor_id) ?? 0) + 1);
  }
  // `scored` is already in rank order, so first-seen is best-scoring and the
  // surviving rows come out in that same order without a re-sort.
  const out: Scored[] = [];
  for (const s of scored) {
    if (best.get(s.vendor_id) === s) {
      (s as any).also_from_vendor = extra.get(s.vendor_id) ?? 0;
      out.push(s);
    }
  }
  return out;
}

export function search(input: SearchInput): SearchResponse {
  const t0 = performance.now();
  const timings: Record<string, number> = {};

  const vocab = (prep(`SELECT DISTINCT brand FROM product WHERE brand IS NOT NULL`).all() as any[])
    .map((r) => String(r.brand).toLowerCase());
  const parsed = parseQuery(input.q, vocab);
  timings.parse = performance.now() - t0;

  const t1 = performance.now();
  const category = input.category ?? parsed.category;
  const rows = baseRows(input.region_id, category ?? null, input.vendor_id ?? null);
  timings.fetch = performance.now() - t1;

  const t2 = performance.now();
  const rel = input.q.trim() ? retrieve(parsed, input.region_id) : new Map<string, number>();
  timings.retrieve = performance.now() - t2;

  const t3 = performance.now();
  // A filter rail is a promise about the catalogue. Showing the cement rail
  // over a mixed result set would be that promise broken, so facets render
  // only once a category is in play — either chosen, or inferred by the query
  // grammar, or because one category dominates the result set outright.
  const facetCategory =
    category ??
    (rows.length
      ? Object.entries(rows.reduce<Record<string, number>>((m, r) => ((m[r.category] = (m[r.category] ?? 0) + 1), m), {}))
          .sort((a, b) => b[1] - a[1])
          .filter(([, n]) => n / rows.length >= 0.6)
          .map(([c]) => c)[0] ?? null
      : null);

  const facets = facetCategory
    ? (prep(`SELECT * FROM facet_definition WHERE category = ? ORDER BY sort_order`).all(facetCategory) as any[])
    : [];
  const selections = input.facets ?? {};

  // Candidate set: lexical hits (if a query was typed) intersected with the
  // typed constraints, then the facet selections.
  const hasQuery = input.q.trim().length > 0;
  let pool = rows.filter((r) => !hasQuery || rel.has(r.product_id));
  if (hasQuery && pool.length === 0) pool = rows; // the relax ladder takes over below

  const constrained = pool
    .map((r) => ({ r, m: matchesConstraints(r, parsed.constraints) }))
    .filter((x) => x.m.ok);

  const compiled = facets.map((f) => compileFacet(f, selections[f.facet_id] ?? []));

  // Which selection-bearing facets does each row fail? A row belongs in the
  // base for facet f exactly when it fails nothing, or fails only f — so this
  // one pass replaces the per-facet others.every() rescan, and answers the
  // filter stage at the same time.
  const selIdx = compiled.map((c, i) => (c.selected.length ? i : -1)).filter((i) => i >= 0);
  const failing: number[][] = constrained.map(({ r }) => {
    const out: number[] = [];
    for (const i of selIdx) {
      const c = compiled[i];
      const ctx = rowCtx(r, c);
      if (!c.selVals.some((v) => ctxMatches(ctx, v, c.isPrice))) out.push(i);
    }
    return out;
  });

  const afterFacets = constrained.filter((_, i) => failing[i].length === 0);
  timings.filter = performance.now() - t3;

  // ── facet counts, each computed against every OTHER facet's selection ──────
  const t4 = performance.now();
  const facetViews: FacetView[] = facets.map((f, fi) => {
    const c = compiled[fi];
    const { defs, selected } = c;

    const counts = new Array<number>(defs.length).fill(0);
    for (let ri = 0; ri < constrained.length; ri++) {
      const fail = failing[ri];
      // In this facet's base iff it fails no other selection.
      if (fail.length > 1 || (fail.length === 1 && fail[0] !== fi)) continue;
      const ctx = rowCtx(constrained[ri].r, c);
      for (let vi = 0; vi < c.vals.length; vi++) if (ctxMatches(ctx, c.vals[vi], c.isPrice)) counts[vi]++;
    }

    const values: FacetValueView[] = defs.map((d, vi) => {
      const count = counts[vi];
      return {
        label: d.label, sublabel: d.sublabel ?? null, unit: d.unit ?? null,
        count,
        // Facets disable rather than vanish — a value that blinks out of the
        // rail teaches the buyer nothing; one struck through tells them the
        // catalogue does not go there.
        disabled: count === 0,
        selected: selected.some((s) => s.toLowerCase() === d.label.toLowerCase()),
        reveals: d.reveals ?? [],
      };
    });

    const parentSelected = f.depends_on_facet
      ? (selections[f.depends_on_facet] ?? []).some((s) => s.toLowerCase() === String(f.depends_on_value).toLowerCase())
      : true;

    return {
      facet_id: f.facet_id, facet_key: f.facet_key, label: f.label, type: f.type,
      control: f.control, cluster: f.cluster, visibility: f.visibility, sort_order: f.sort_order,
      depends_on: f.depends_on_facet ? { facet: f.depends_on_facet, value: f.depends_on_value } : null,
      default_open: !!f.default_open, default_state: f.default_state,
      why: f.why, note: f.note, needs_verification: f.needs_verification,
      values, active: parentSelected,
    };
  });
  timings.facets = performance.now() - t4;

  // ── score ─────────────────────────────────────────────────────────────────
  const t5 = performance.now();
  const requestedQty = input.qty ?? 1;
  const candidates: Candidate[] = afterFacets
    .map(({ r, m }) => ({
      offer_id: r.offer_id, product_id: r.product_id, vendor_id: r.vendor_id,
      relevance: hasQuery ? (rel.get(r.product_id) ?? 0) : 0.5,
      attrMatch: m.total ? m.matched / m.total : 0.5,
      normalised_paise: r.normalised_paise, stock_state: r.stock_state,
      lead_time_days: r.lead_time_days, rating: r.rating, review_count: r.review_count,
      cert_state: r.cert_state as any, qco_regulated: !!r.qco_regulated,
      priced_as_of: r.priced_as_of, sla_hours: r.sla_hours,
      moq_qty: r.moq_qty, deliverable: true, requestedQty,
    }))
    .filter((c) => !hardFiltered(c).blocked);

  // Drilling into one seller shows their offers individually; everywhere
  // else the list is one card per vendor.
  let ranked: Scored[] = input.vendor_id ? score(candidates) : groupByVendor(score(candidates));

  if (input.sort && input.sort !== 'recommended') {
    const byId = new Map(afterFacets.map(({ r }) => [r.offer_id, r]));
    const g = (id: string) => byId.get(id)!;
    if (input.sort === 'price_low') ranked = [...ranked].sort((a, b) => a.normalised_paise - b.normalised_paise);
    else if (input.sort === 'fastest') ranked = [...ranked].sort((a, b) => (g(a.offer_id).lead_time_days ?? 9) - (g(b.offer_id).lead_time_days ?? 9));
    else if (input.sort === 'freshest') ranked = [...ranked].sort((a, b) => (g(b.offer_id).priced_as_of > g(a.offer_id).priced_as_of ? 1 : -1));
    else if (input.sort === 'best_value') {
      // Percentile via a precomputed rank map. This was `prices.indexOf(p)`
      // called inside the comparator — O(n²), and because indexOf returns the
      // FIRST match every seller sharing a price collapsed to one percentile.
      const sorted = ranked.map((r) => r.normalised_paise).sort((a, b) => a - b);
      const rankOf = new Map<number, number>();
      sorted.forEach((p, i) => { if (!rankOf.has(p)) rankOf.set(p, i); });
      const denom = Math.max(1, sorted.length - 1);
      const value = (r: Scored) =>
        0.5 * ((rankOf.get(r.normalised_paise) ?? 0) / denom)
        - 0.3 * ((r.rating ?? 3.5) / 5)
        - 0.2 * (r.cert_state === 'CERTIFIED' ? 1 : 0);
      ranked = [...ranked].sort((a, b) => value(a) - value(b));
    }
  }

  // Column-header sort. Applied here — over the whole result set, before
  // pagination — so page 2 agrees with page 1. Sorting the 24 rows the client
  // happens to hold would reorder the window, not the result.
  const activeColumn = input.column_sort ? COLUMN_SORTS[input.column_sort] ?? null : null;
  if (activeColumn && input.column_sort) {
    const byId = new Map(afterFacets.map(({ r }) => [r.offer_id, r]));
    const srt = sortRows(input.region_id, category ?? null);
    const cmp = columnComparator(input.column_sort, input.column_dir === 'desc' ? -1 : 1);
    // Precompute one SortableRow per candidate rather than rebuilding both sides
    // inside the comparator, which would be O(n log n) object allocations.
    const shaped = new Map(ranked.map((s) => [s.offer_id, sortableOf(byId.get(s.offer_id)!, srt.get(s.offer_id))]));
    ranked = [...ranked].sort((a, b) => cmp(shaped.get(a.offer_id)!, shaped.get(b.offer_id)!));
  }
  timings.rank = performance.now() - t5;

  // ── zero-result ladder — never a dead end ─────────────────────────────────
  let zero: SearchResponse['zero_result'] = null;
  if (ranked.length === 0 && hasQuery) {
    const relaxOrder = relaxationOrder(parsed.constraints);
    const relaxed: string[] = [];
    let recovered: Scored[] = [];
    const working = { ...parsed.constraints };
    for (const k of relaxOrder) {
      delete working[k];
      relaxed.push(k);
      const again = pool.filter((r) => matchesConstraints(r, working).ok);
      if (again.length) {
        recovered = score(again.map((r) => ({
          offer_id: r.offer_id, product_id: r.product_id, vendor_id: r.vendor_id,
          relevance: rel.get(r.product_id) ?? 0.3, attrMatch: 0.3,
          normalised_paise: r.normalised_paise, stock_state: r.stock_state,
          lead_time_days: r.lead_time_days, rating: r.rating, review_count: r.review_count,
          cert_state: r.cert_state as any, qco_regulated: !!r.qco_regulated,
          priced_as_of: r.priced_as_of, sla_hours: r.sla_hours, moq_qty: r.moq_qty,
          deliverable: true, requestedQty,
        })));
        recovered = groupByVendor(recovered);
        break;
      }
    }
    if (!recovered.length && category) {
      recovered = score(rows.slice(0, 24).map((r) => ({
        offer_id: r.offer_id, product_id: r.product_id, vendor_id: r.vendor_id,
        relevance: 0.2, attrMatch: 0.2, normalised_paise: r.normalised_paise,
        stock_state: r.stock_state, lead_time_days: r.lead_time_days, rating: r.rating,
        review_count: r.review_count, cert_state: r.cert_state as any,
        qco_regulated: !!r.qco_regulated, priced_as_of: r.priced_as_of,
        sla_hours: r.sla_hours, moq_qty: r.moq_qty, deliverable: true, requestedQty,
      })));
      recovered = groupByVendor(recovered);
    }
    ranked = recovered;
    zero = {
      reason: relaxed.length
        ? `Nothing matched every part of that. Showing results with ${relaxed.map(humanConstraint).join(' and ')} relaxed.`
        : `Nothing matched "${input.q}" in ${CATEGORY_LABEL[category ?? 'cement']}.`,
      relaxed: relaxed.map(humanConstraint),
      suggestions: suggestFor(parsed, input.region_id),
      nearest_category: category ?? null,
    };
  }

  // ── build the cards ───────────────────────────────────────────────────────
  const limit = input.limit ?? 24;
  const page = ranked.slice(input.offset ?? 0, (input.offset ?? 0) + limit);

  // The display columns are fetched for the page alone. Materialising the
  // vendor and price_current joins for every candidate cost ~5.7 ms a query to
  // build ~800 wide rows and then throw away all but these.
  // Keyed by offer, not product: one product appears once per seller, and
  // keying by product_id would silently render one seller's row N times.
  const displayRows = page.length
    ? (prep(DISPLAY_SQL).all(input.region_id, JSON.stringify(page.map((s) => s.offer_id))) as DisplayRow[])
    : [];
  const byId = new Map<string, DisplayRow>();
  for (const r of displayRows) byId.set(r.offer_id, r);

  // Pictures, for the page only.
  //
  // A card rotates up to five on hover, and they are pooled per PRODUCT rather
  // than per offer: one seller photographs a bag once, but a dozen sellers of
  // the same bag give a dozen angles. The card's own seller comes first so the
  // still frame is that listing's picture, then the rest fill in.
  //
  // Joined on the page's offers, never on the whole candidate set — 24 rows,
  // not 800. Datasheet scans are excluded: they belong in the sheet's datasheet
  // block, not in a rotation where a buyer expects to see the goods.
  const imagesByProduct = new Map<string, Array<{ url: string; offer_id: string | null }>>();
  if (displayRows.length) {
    const pids = [...new Set(displayRows.map((r) => r.product_id))];
    const rowsImg = prep(
      `SELECT product_id, offer_id, local_path FROM product_image
        WHERE kind = 'photo' AND local_path IS NOT NULL
          AND product_id IN (SELECT value FROM json_each(?))
        ORDER BY rank, width DESC`,
    ).all(JSON.stringify(pids)) as Array<{ product_id: string; offer_id: string | null; local_path: string }>;
    for (const r of rowsImg) {
      if (!imagesByProduct.has(r.product_id)) imagesByProduct.set(r.product_id, []);
      imagesByProduct.get(r.product_id)!.push({ url: r.local_path, offer_id: r.offer_id });
    }
  }
  const MAX_CARD_IMAGES = 5;
  const imagesFor = (r: DisplayRow): string[] => {
    const pool = imagesByProduct.get(r.product_id) ?? [];
    const mine = pool.filter((x) => x.offer_id === r.offer_id).map((x) => x.url);
    const others = pool.filter((x) => x.offer_id !== r.offer_id).map((x) => x.url);
    const out: string[] = [];
    for (const u of [...mine, ...others]) {
      if (out.length >= MAX_CARD_IMAGES) break;
      if (!out.includes(u)) out.push(u);
    }
    // Fallback for a database where `npm run images` has not been run yet: the
    // remote thumbnail the collector already stored. One picture, no rotation,
    // but never a grid of empty plates on a fresh clone.
    if (!out.length && r.image_url) out.push(r.image_url);
    return out;
  };

  const results: ProductCard[] = page.flatMap((s) => {
    const r = byId.get(s.offer_id);
    if (!r) return [];
    const f = assess(r.priced_as_of, r.sla_hours);
    const a = attrOf(r);
    return {
      product_id: r.product_id, category: r.category as any, title: r.title, brand: r.brand,
      images: imagesFor(r), image_url: r.image_url, spec_chips: chipsFor(r.category, a),
      unit_canonical: r.unit_canonical,
      normalised_paise: r.normalised_paise, landed_paise: r.landed_paise,
      trade_unit: r.unit_canonical,
      floor_paise: r.floor_paise, ceiling_paise: r.ceiling_paise, median_paise: r.median_paise,
      offer_count: r.offer_count, vendor_count: r.vendor_count, best_vendor: r.vendor_name,
      offer_id: r.offer_id, vendor_id: r.vendor_id, vendor_locality: r.vendor_locality,
      platform: r.platform, listing_title: r.listing_title, source_url: r.source_url,
      also_from_vendor: (s as any).also_from_vendor ?? 0,
      lead_time_days: r.lead_time_days, cert_state: r.cert_state as any,
      qco_regulated: !!r.qco_regulated,
      priced_as_of: r.priced_as_of, freshness_state: f.state, freshness_dot: f.dot,
      freshness_label: f.label, sla_hours: r.sla_hours,
      gst_rate_bp: r.gst_rate_bp, hsn: r.hsn,
      delivery_scope: r.delivery_scope as any, gst_treatment: r.gst_treatment as any,
      // Table columns. The first three were already selected and discarded here.
      rating: r.rating, review_count: r.review_count,
      moq_qty: r.moq_qty, moq_unit: r.moq_unit,
      mrp_paise: r.mrp_paise, country_of_origin: r.country_of_origin,
      attrs: a as Record<string, string | number | boolean | null>,
      why: s.why, score: +s.score.toFixed(4),
    };
  });

  const intentChips = buildIntentChips(input.region_id, parsed, category);
  const sor = sorAnchorFor(input.region_id, category);

  timings.total = performance.now() - t0;
  return {
    query: {
      raw: input.q,
      parsed: {
        tokens: parsed.tokens, category: parsed.category, constraints: parsed.constraints,
        intent: parsed.intent, matched_vocabulary: parsed.matched_vocabulary,
        unit_bearing: parsed.unit_bearing,
      },
      corrected_from: parsed.correction ? parsed.correction.from : null,
      region_id: input.region_id, pincode: input.pincode,
    },
    intent_chips: intentChips,
    results,
    total: ranked.length,
    facets: facetViews,
    comparability_note:
      'Every price on this page is a delivered total to your pincode, inclusive of GST at the stated HSN rate, ' +
      'expressed per canonical unit. Prices are only ever sorted against each other on that one basis.',
    sor_anchor: sor,
    zero_result: zero,
    // Rule 5(3)(f) — the disclosed order must be the applied one. When a column
    // header is driving, saying "Recommended" here would disclose an order that
    // is not in force.
    disclosure: activeColumn && input.column_sort
      ? {
        sort: `${activeColumn.label} · ${directionLabel(input.column_sort, input.column_dir === 'desc' ? 'desc' : 'asc')}`,
        explanation: `${activeColumn.explain} — ${directionLabel(input.column_sort, input.column_dir === 'desc' ? 'desc' : 'asc')}, applied across every matching result, not just this page`,
      }
      : {
        sort: input.sort ?? 'recommended',
        explanation: SORTS[input.sort ?? 'recommended']?.explain ?? SORTS.recommended.explain,
      },
    timings,
  };
}

function humanConstraint(k: string): string {
  const m: Record<string, string> = {
    pack_size_kg: 'pack size', size_mm: 'size', nominal_bore_mm: 'bore', diameter_mm: 'diameter',
    opc_grade: 'grade', grade: 'grade', brand: 'brand', sdr: 'pressure class',
    swr_type: 'SWR type', thickness_mm: 'thickness',
  };
  return m[k] ?? k.replace(/_/g, ' ');
}

function chipsFor(category: string, a: Record<string, any>): string[] {
  switch (category) {
    case 'cement': return [a.cement_type, a.opc_grade, a.pack_size_kg ? `${a.pack_size_kg} kg` : null].filter(Boolean).slice(0, 3);
    case 'tmt_steel': return [a.diameter_mm ? `${a.diameter_mm} mm` : null, a.grade, a.producer_type === 'Primary producer' ? 'Primary' : null].filter(Boolean).slice(0, 3);
    case 'water_pipes': return [a.pipe_system, a.nominal_bore_mm ? `${a.nominal_bore_mm} mm` : null, a.sdr ?? a.pressure_class ?? a.swr_type ?? a.gi_class ?? a.pe_grade].filter(Boolean).slice(0, 3);
    case 'bricks_blocks': return [a.block_type, a.size_mm, a.compressive_strength_nmm2 ? `${a.compressive_strength_nmm2} N/mm²` : null].filter(Boolean).slice(0, 3);
    default: return [];
  }
}

function buildIntentChips(region_id: string, parsed: ParseResult, current: string | null) {
  const rows = prep(
    `SELECT p.category, COUNT(*) n FROM price_current pc
       JOIN product p ON p.product_id = pc.product_id
      WHERE pc.region_id = ? GROUP BY p.category ORDER BY n DESC`,
  ).all(region_id) as any[];
  return rows.map((r) => ({ label: CATEGORY_LABEL[r.category] ?? r.category, category: r.category, count: r.n }));
}

function sorAnchorFor(region_id: string, category: string | null): SorAnchor | null {
  if (!category) return null;
  const state = region_id === 'hyderabad' ? 'TS' : 'AP';
  const r = prep(`SELECT * FROM sor_rate WHERE state_code=? AND category=? LIMIT 1`).get(state, category) as any;
  if (!r) {
    const ts = prep(`SELECT * FROM sor_rate WHERE state_code='TS' AND category=? LIMIT 1`).get(category) as any;
    if (!ts) return null;
    return { state_code: 'TS', item: ts.item, rate_paise: ts.rate_paise, unit: ts.unit,
      effective_period: ts.effective_period, source_url: ts.source_url, note: ts.note };
  }
  return { state_code: r.state_code, item: r.item, rate_paise: r.rate_paise, unit: r.unit,
    effective_period: r.effective_period, source_url: r.source_url, note: r.note };
}

function suggestFor(parsed: ParseResult, region_id: string): string[] {
  const out = new Set<string>();
  if (parsed.category) {
    const rows = prep(
      `SELECT DISTINCT p.brand FROM price_current pc JOIN product p ON p.product_id=pc.product_id
        WHERE pc.region_id=? AND p.category=? AND p.brand IS NOT NULL LIMIT 4`,
    ).all(region_id, parsed.category) as any[];
    for (const r of rows) out.add(`${String(r.brand).toLowerCase()} ${parsed.category.replace('_', ' ')}`);
  }
  for (const t of ['cement', 'tmt bar', 'cpvc pipe', 'aac block']) out.add(t);
  return [...out].slice(0, 6);
}

/** Autocomplete: prefix over titles and brands, with a live in-zone price preview. */
export function suggest(prefix: string, region_id: string, limit = 8) {
  const p = prefix.trim().toLowerCase();
  if (!p) return { products: [], categories: [], trending: trending(region_id) };

  const products = prep(
    `SELECT p.product_id, p.title, p.brand, p.category, p.unit_canonical, p.image_url,
            pc.normalised_paise, pc.offer_count
       FROM price_current pc JOIN product p ON p.product_id = pc.product_id
      WHERE pc.region_id = ? AND lower(p.title) LIKE ?
      ORDER BY pc.normalised_paise ASC LIMIT ?`,
  ).all(region_id, `%${p}%`, limit) as any[];

  const categories = prep(
    `SELECT p.category, COUNT(*) n FROM price_current pc JOIN product p ON p.product_id=pc.product_id
      WHERE pc.region_id=? AND (lower(p.title) LIKE ? OR lower(p.search_blob) LIKE ?)
      GROUP BY p.category ORDER BY n DESC LIMIT 4`,
  ).all(region_id, `%${p}%`, `%${p}%`) as any[];

  return { products, categories, trending: trending(region_id) };
}

function trending(region_id: string) {
  return (prep(
    `SELECT q, COUNT(*) n FROM search_log WHERE region_id=? AND hits>0
      GROUP BY q ORDER BY n DESC, MAX(at) DESC LIMIT 6`,
  ).all(region_id) as any[]).map((r) => r.q);
}

export function logSearch(q: string, region_id: string, hits: number) {
  try {
    db().prepare(`INSERT INTO search_log (q,region_id,hits,at) VALUES (?,?,?,?)`)
      .run(q.trim().toLowerCase(), region_id, hits, new Date().toISOString());
  } catch { /* logging must never break a search */ }
}
