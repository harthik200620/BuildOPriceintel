/**
 * The application's self-description: regions, categories, sorts, the state of
 * the last collection run, and what the network guard permits.
 *
 * Built here rather than inside the /api/meta route so the home page can render
 * it on the server in the same request that serves the HTML — the category
 * grid then arrives with its counts already in it, rather than as eight empty
 * cards that fill in a moment later.
 */

import { prep, lastSuccessfulRun } from './db';
import { guardState, allowedHosts } from './no-network';
import { hasKey, GEMINI_MODEL } from './chat/gemini';
import { SORTS, COLUMN_SORTS } from './rank';
import { CATEGORY_LABEL, CATEGORIES } from './types';
import { sorAnchorFor } from './search';
import { assess, countsTowardHeadline } from './freshness';
import { median } from './money';

/**
 * What a category card states, per region. Every figure here is measured over
 * exactly the candidate set lib/search.ts ranks — offer_price joined to active
 * offers in the region — so the "N sellers" on the home card and the "N
 * sellers" heading on the listing it opens are the same number, from the same
 * rows. Two counts of the same thing that disagree is the failure this
 * application exists to avoid.
 */
export interface CategoryStat {
  category: string;
  region_id: string;
  /** Distinct products with at least one active priced offer. */
  products: number;
  /** Active priced offers — one seller's listing of one product. */
  offers: number;
  /** Distinct sellers, which is what the listing shows one card per. */
  sellers: number;
  /** Lowest landed price per canonical unit, in paise — over QUOTABLE offers
      only. A price past three times its refresh window cannot be quoted, and a
      card that said "from ₹268" on the strength of one would be advertising a
      price no buyer can get. Null when nothing in the category is quotable. */
  lo_paise: number | null;
  hi_paise: number | null;
  /** The middle quotable offer — the figure to compare two cities on; a minimum is one seller. */
  median_paise: number | null;
  /** How many of the offers are quotable — what the figures above are over. */
  quotable: number;
  /** Offers whose price is FRESH or AGEING, i.e. still counts toward a headline. */
  fresh: number;
  /** Most recent priced_as_of across the offers, ISO. */
  seen_at: string | null;
}

export function categoryStats(now: Date = new Date()): CategoryStat[] {
  const rows = prep(
    `SELECT p.category, op.region_id, op.product_id, op.vendor_id,
            op.normalised_paise, op.priced_as_of, op.sla_hours
       FROM offer_price op
       JOIN offer   o ON o.offer_id   = op.offer_id
       JOIN product p ON p.product_id = op.product_id
      WHERE o.is_active = 1`,
  ).all() as Array<{
    category: string; region_id: string; product_id: string; vendor_id: string;
    normalised_paise: number; priced_as_of: string; sla_hours: number;
  }>;

  const acc = new Map<string, {
    products: Set<string>; sellers: Set<string>; offers: number;
    lo: number; hi: number; fresh: number; seen: string | null; prices: number[];
  }>();
  for (const r of rows) {
    const k = `${r.category}|${r.region_id}`;
    let a = acc.get(k);
    if (!a) {
      a = { products: new Set(), sellers: new Set(), offers: 0, lo: Infinity, hi: -Infinity, fresh: 0, seen: null, prices: [] };
      acc.set(k, a);
    }
    a.products.add(r.product_id);
    a.sellers.add(r.vendor_id);
    a.offers += 1;
    const f = assess(r.priced_as_of, r.sla_hours, now);
    if (f.quotable) {
      a.prices.push(r.normalised_paise);
      if (r.normalised_paise < a.lo) a.lo = r.normalised_paise;
      if (r.normalised_paise > a.hi) a.hi = r.normalised_paise;
    }
    if (countsTowardHeadline(f)) a.fresh += 1;
    if (!a.seen || r.priced_as_of > a.seen) a.seen = r.priced_as_of;
  }

  return [...acc.entries()].map(([k, a]) => {
    const [category, region_id] = k.split('|');
    return {
      category, region_id,
      products: a.products.size, offers: a.offers, sellers: a.sellers.size,
      lo_paise: a.prices.length ? a.lo : null, hi_paise: a.prices.length ? a.hi : null,
      median_paise: a.prices.length ? median(a.prices) : null,
      quotable: a.prices.length, fresh: a.fresh, seen_at: a.seen,
    };
  });
}

export function buildMeta() {
  const regions = prep(
    `SELECT region_id, name, state_code, district, pincode_from, pincode_to, default_pincode,
            sor_status, sor_note FROM region ORDER BY name`,
  ).all() as any[];

  const counts = prep(
    `SELECT p.category, pc.region_id, COUNT(*) AS products,
            SUM(pc.offer_count) AS offers, MIN(pc.normalised_paise) AS lo, MAX(pc.normalised_paise) AS hi
       FROM price_current pc JOIN product p ON p.product_id = pc.product_id
      GROUP BY p.category, pc.region_id`,
  ).all() as any[];

  const stats = categoryStats();

  const run = lastSuccessfulRun();
  const runDetail = run
    ? (prep(
        `SELECT run_id, started_at, finished_at, status, mode, sources_attempted, sources_ok,
                sources_blocked, offers_captured, vendors_new,
                ladder_quoted, ladder_derived, ladder_typical, ladder_unknown, notes
           FROM collection_run WHERE run_id = ?`,
      ).get(run.run_id) as any)
    : null;

  const blocked = prep(
    `SELECT source_id, source_class, outcome, SUM(COALESCE(estimated_missed,0)) AS missed
       FROM source_log WHERE outcome != 'ok'
       GROUP BY source_id, outcome ORDER BY missed DESC LIMIT 12`,
  ).all() as any[];

  const totals = {
    products: (prep(`SELECT COUNT(DISTINCT op.product_id) AS n FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id WHERE o.is_active = 1`).get() as any).n as number,
    offers:   (prep(`SELECT COUNT(*) AS n FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id WHERE o.is_active = 1`).get() as any).n as number,
    sellers:  (prep(`SELECT COUNT(DISTINCT op.vendor_id) AS n FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id WHERE o.is_active = 1`).get() as any).n as number,
  };

  return {
    // The clock the page renders against. Every relative age on the catalogue
    // is computed from THIS instant on the server and again at hydration, so
    // the two renders agree to the character; the client then ticks forward.
    now: new Date().toISOString(),
    regions: regions.map((r) => ({
      ...r,
      categories: counts.filter((c) => c.region_id === r.region_id),
      // Per-category card figures, measured over the search candidate set.
      stats: stats.filter((s) => s.region_id === r.region_id),
      // The government reference line per category, so a listing can print
      // it on first paint. The same function the search API calls.
      sor: Object.fromEntries(CATEGORIES.map((c) => [c, sorAnchorFor(r.region_id, c)])),
    })),
    totals,
    category_labels: CATEGORY_LABEL,
    sorts: SORTS,
    // Column-header sorts, with the disclosure text each one publishes when it
    // is the applied order. `value` is a function and does not serialise.
    column_sorts: Object.fromEntries(
      Object.entries(COLUMN_SORTS).map(([k, v]) => [k, { label: v.label, explain: v.explain }]),
    ),
    last_run: runDetail,
    // Freshness of the whole surface is degraded when the last run failed —
    // the app says so rather than presenting stale data as current.
    degraded: !runDetail || runDetail.status === 'failed',
    blocked_sources: blocked,
    // The guard's exceptions are published rather than buried, because an
    // allowlist nobody can see is indistinguishable from no guard at all.
    network_guard: { ...guardState(), allowed: allowedHosts() },
    assistant: { ready: hasKey(), model: GEMINI_MODEL },
  };
}

export type Meta = ReturnType<typeof buildMeta>;
