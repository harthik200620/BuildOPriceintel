/**
 * The tool surface the model is given, and the only route to a fact.
 *
 * The model has no catalogue knowledge, no price knowledge and no arithmetic.
 * It has these eight functions. Everything it is allowed to say comes back
 * from one of them, deposited in a FactLedger that validator.ts then enforces
 * against the draft.
 *
 * Every tool obeys three rules:
 *
 *   1. It returns what it knows AND what it does not. `coverage` on a ranking
 *      says how many rows carried the field it ranked on. A tool that ranks
 *      294 cement products on a grade attribute present in 109 of them and
 *      does not say so has produced a confident lie out of honest data.
 *
 *   2. It never invents a fallback. No offer at this pincode returns
 *      NO_COVERAGE, not the nearest city's price.
 *
 *   3. It deposits before it returns. Anything absent from the ledger cannot
 *      appear in the reply, so a tool that forgets to deposit degrades into
 *      silence rather than into a hallucination.
 */

import { search } from '../search';
import { resolvePincode, resolveAllOffers, rollUpByVendor } from '../price';
import { prep } from '../db';
import { formatPaise } from '../money';
import { CATEGORY_LABEL, CATEGORIES } from '../types';
import { assess, humaniseAge } from '../freshness';
import { MASONRY_GUIDE, CLIMATE_NOTE, DUTY_LABEL, dutyFromText } from './masonry';
import { FactLedger } from './ledger';
import { runEstimator, MASONRY_UNITS, MIX_GRADES, MORTAR_MIXES, STEEL_BANDS, type Estimate } from './estimator';
import { MASONRY_UNITS as UNITS_FOR_OPTS } from './coefficients';

export interface ToolContext {
  pincode: string;
  region_id: string;
}

export interface ToolResult {
  ok: boolean;
  data: unknown;
  ledger: FactLedger;
  /** Rendered inline in the panel — cards, tables, option chips. */
  ui?: unknown;
}

const R = (p: number) => formatPaise(p);

// ─── 1. catalogue scope ──────────────────────────────────────────────────────

/**
 * What this assistant can and cannot answer about.
 *
 * Called on the first turn and whenever the model is about to say "we don't
 * have that", so the refusal names the real boundary instead of guessing at it.
 */
export function getCatalogueScope(_a: unknown, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const rows = prep(
    `SELECT p.category, pc.region_id, COUNT(DISTINCT p.product_id) AS products,
            COUNT(DISTINCT o.vendor_id) AS vendors,
            MIN(pc.normalised_paise) AS lo, MAX(pc.normalised_paise) AS hi,
            MAX(pc.priced_as_of) AS newest
       FROM price_current pc
       JOIN product p ON p.product_id = pc.product_id
       LEFT JOIN offer o ON o.product_id = p.product_id AND o.region_id = pc.region_id AND o.is_active = 1
      GROUP BY p.category, pc.region_id`,
  ).all() as any[];

  const regions = prep(`SELECT region_id, name, state_code, pincode_from, pincode_to FROM region`).all() as any[];
  for (const r of regions) led.entity(r.name, r.state_code, r.pincode_from, r.pincode_to);

  const here = rows.filter((r) => r.region_id === ctx.region_id);
  for (const r of here) {
    led.number(r.products, r.vendors).paise(r.lo, r.hi).entity(CATEGORY_LABEL[r.category] ?? r.category);
  }

  const totals = prep(
    `SELECT (SELECT COUNT(*) FROM product) AS products,
            (SELECT COUNT(*) FROM offer WHERE is_active=1) AS offers,
            (SELECT COUNT(*) FROM vendor) AS vendors`,
  ).get() as any;
  led.number(totals.products, totals.offers, totals.vendors);

  /**
   * "3 h ago", not "2026-08-05T06:33:24.125Z".
   *
   * A reply cannot usefully say an ISO timestamp, and depositing one to make it
   * quotable would push 2026, 08, 33 and 24 into the ledger as grounded numbers
   * for the rest of the turn — weakening the number check everywhere to license
   * a string nobody wants said. The rest of the app already renders age through
   * this helper; so does this now.
   */
  const lastPriced = (iso: string) =>
    humaniseAge(Math.max(0, (Date.now() - new Date(iso).getTime()) / 3_600_000));
  for (const r of here) led.entity(lastPriced(r.newest));

  const notCovered = [
    'Sand and coarse aggregate — I can compute the quantity you need but I hold no prices for them yet.',
    'Paint, tiles, electricals, sanitaryware, plywood, hardware.',
    'Any city outside Hyderabad and Vijayawada.',
    'Labour rates, contractor quotes, and machinery hire.',
  ];
  for (const n of notCovered) led.claim(n);

  return {
    ok: true,
    ledger: led,
    data: {
      covers: {
        categories: CATEGORIES.map((c) => CATEGORY_LABEL[c]),
        cities: regions.map((r) => ({ name: r.name, state: r.state_code, pincodes: `${r.pincode_from}–${r.pincode_to}` })),
      },
      in_this_region: here.map((r) => ({
        category: CATEGORY_LABEL[r.category] ?? r.category,
        products: r.products,
        vendors: r.vendors,
        price_range: `${R(r.lo)}–${R(r.hi)}`,
        last_priced: lastPriced(r.newest),
      })),
      totals: { products: totals.products, live_offers: totals.offers, vendors: totals.vendors },
      not_covered: notCovered,
    },
  };
}

// ─── 2. search ───────────────────────────────────────────────────────────────

export interface SearchArgs {
  query: string;
  category?: string;
  brand?: string;
  sort?: 'cheapest' | 'recommended' | 'fastest';
  limit?: number;
}

/**
 * "110mm" is one token to the tokeniser and two facts to a human.
 *
 * The trade writes bore, diameter and thickness with the unit fused to the
 * number, and an FTS index built from "110 mm" in the title never sees it.
 * Splitting here costs nothing and turns a whole class of silent zero-matches
 * into hits.
 */
function normaliseQuery(q: string): string {
  return q.replace(/(\d)\s*(mm|cm|kg|m|ft|in|inch|nb|dia)\b/gi, '$1 $2').replace(/\s+/g, ' ').trim();
}

const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'in', 'is', 'at', 'me', 'my', 'i', 'need', 'want', 'get', 'give', 'show', 'find', 'price', 'cost', 'rate', 'per', 'what', 'which', 'how', 'much', 'many', 'do', 'you', 'have', 'buy']);

/**
 * Did the query actually match, or did the search simply stop narrowing?
 *
 * `search()` returns the whole catalogue when a query contributes no signal,
 * which is right for a browse UI — an empty box should show everything — and
 * catastrophic for an assistant, because "gold plated toilet seat" comes back
 * as 208 bricks and the model will gladly describe them.
 *
 * So the tool checks the results against the query rather than trusting the
 * count: how many of the top rows contain any distinctive term the user typed.
 * None of them means the search matched nothing and said so with data.
 */
function matchStrength(query: string, results: Array<{ title: string; brand: string | null; spec_chips: string[] }>): number {
  const terms = normaliseQuery(query).toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
  if (!terms.length || !results.length) return 1; // nothing distinctive to check
  const hits = results.filter((r) => {
    const hay = `${r.title} ${r.brand ?? ''} ${(r.spec_chips ?? []).join(' ')}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  }).length;
  return hits / results.length;
}

export function searchProducts(a: SearchArgs, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const limit = Math.min(12, Math.max(1, a.limit ?? 6));

  // The dropdown's own keys, not invented ones — a sort key that does not
  // exist silently falls back to `recommended`, which is how "cheapest" came
  // back unsorted.
  const sortMap: Record<string, string> = { cheapest: 'price_low', recommended: 'recommended', fastest: 'fastest' };
  const res = search({
    q: normaliseQuery([a.query, a.brand].filter(Boolean).join(' ')),
    pincode: ctx.pincode,
    region_id: ctx.region_id,
    category: a.category && (CATEGORIES as readonly string[]).includes(a.category) ? a.category : null,
    sort: sortMap[a.sort ?? 'recommended'] ?? 'recommended',
    limit,
  });

  const strength = matchStrength(a.query ?? '', res.results as any);

  if (!res.results.length || strength === 0) {
    led.entity(a.query);
    const reason = res.results.length
      ? `Nothing in the catalogue matches "${a.query}". The search fell back to unrelated stock, so I am reporting no match rather than showing it.`
      : (res.zero_result?.reason ?? 'Nothing in the catalogue matched.');
    const suggestions = res.zero_result?.suggestions ?? [];
    const nearest = res.zero_result?.nearest_category ?? null;
    const covered = CATEGORIES.map((c) => CATEGORY_LABEL[c]);

    // Deposit what this branch emits. A reply that passes on the suggestion or
    // names the nearest category is quoting the tool, and must not be rejected
    // for it.
    led.entity(nearest, ...suggestions, ...covered).claim(reason);

    return {
      ok: false, ledger: led,
      data: {
        error: 'NO_MATCH', query: a.query, reason,
        suggestions, nearest_category: nearest, covered_categories: covered,
      },
    };
  }

  const cards = res.results.map((c) => {
    const fresh = assess(c.priced_as_of, c.sla_hours);
    led.paise(c.normalised_paise, c.landed_paise, c.floor_paise, c.ceiling_paise, c.median_paise)
      .number(c.offer_count, c.vendor_count, c.lead_time_days, c.gst_rate_bp / 100)
      .entity(c.brand, c.title, c.best_vendor, c.unit_canonical, c.trade_unit, c.hsn, c.vendor_locality, c.platform)
      // The chips carry the specs a reply is most likely to name — "53 grade",
      // "110 mm" — and the freshness label carries the age it should pass on.
      .entity(fresh.label, c.cert_state, c.delivery_scope, ...(c.spec_chips ?? []))
      .source({ label: c.best_vendor, url: c.source_url, fetched_at: c.priced_as_of, confidence: fresh.state });
    return {
      product_id: c.product_id,
      title: c.title,
      brand: c.brand,
      price: R(c.normalised_paise),
      price_unit: c.unit_canonical,
      landed: R(c.landed_paise),
      trade_unit: c.trade_unit,
      market_range: `${R(c.floor_paise)}–${R(c.ceiling_paise)}`,
      median: R(c.median_paise),
      vendor: c.best_vendor,
      vendor_locality: c.vendor_locality,
      vendors_carrying: c.vendor_count,
      offers: c.offer_count,
      lead_time_days: c.lead_time_days,
      cert_state: c.cert_state,
      gst: `${c.gst_rate_bp / 100}%`,
      hsn: c.hsn,
      delivery_scope: c.delivery_scope,
      freshness: fresh.label,
      stale: fresh.state === 'STALE' || fresh.state === 'EXPIRED',
      source_url: c.source_url,
      spec_chips: c.spec_chips,
    };
  });

  const stale = cards.filter((c) => c.stale).length;
  led.number(res.total, cards.length, stale);
  // The pincode comes from the request, not from anything the user typed, so it
  // is in neither userText nor the ledger — and "landed at 500001" is a sentence
  // this assistant is meant to write.
  led.entity(ctx.pincode, ctx.region_id);

  return {
    ok: true, ledger: led,
    ui: { kind: 'products', cards: res.results.slice(0, limit) },
    data: {
      matched: res.total,
      showing: cards.length,
      region: ctx.region_id,
      pincode: ctx.pincode,
      results: cards,
      stale_count: stale,
      // Below half, the results are adjacent rather than on the nose, and the
      // reply has to say so instead of presenting them as the answer.
      weak_match: strength < 0.5
        ? `Only a loose match for "${a.query}" — tell the user these are the closest thing in the catalogue, not exactly what they asked for.`
        : null,
      price_basis: 'Every price is landed at your pincode — ex-GST base plus GST plus freight, handling and loading. Not the seller\'s sticker.',
    },
  };
}

// ─── 3. product detail ───────────────────────────────────────────────────────

export function getProductDetail(a: { product_id: string }, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const p = prep(
    `SELECT product_id, category, title, brand, attrs, unit_canonical, unit_trade, hsn,
            gst_rate_bp, qco_regulated, qco_citation, cert_standards, country_of_origin
       FROM product WHERE product_id = ?`,
  ).get(a.product_id) as any;

  if (!p) return { ok: false, ledger: led, data: { error: 'NOT_FOUND', product_id: a.product_id } };

  const resolved = resolveAllOffers(a.product_id, ctx.pincode);
  if (!resolved || !resolved.offers.length) {
    led.entity(p.title, p.brand);
    return { ok: false, ledger: led, data: { error: 'NO_COVERAGE', title: p.title, region: ctx.region_id, message: `${p.title} has no active offer at ${ctx.pincode}.` } };
  }

  const table = rollUpByVendor(resolved.offers, resolved.quotes);
  const specs = prep(
    `SELECT field, label, value, unit, source_url, fetched_at, confidence, derivation
       FROM spec_value WHERE product_id = ? AND offer_id = ''
       ORDER BY CASE confidence WHEN 'quoted' THEN 0 WHEN 'derived' THEN 1 WHEN 'typical' THEN 2 ELSE 3 END`,
  ).all(a.product_id) as any[];

  const attrs = JSON.parse(p.attrs || '{}');
  led.entity(p.title, p.brand, p.unit_canonical, p.unit_trade, p.hsn, p.country_of_origin)
    .number(p.gst_rate_bp / 100);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === '_blob') continue;
    if (typeof v === 'number') led.number(v);
    if (typeof v === 'string') led.entity(v);
  }
  for (const s of specs) {
    led.entity(s.value, s.label, s.unit).source({ label: s.label, url: s.source_url, fetched_at: s.fetched_at, confidence: s.confidence });
    const n = Number(s.value); if (Number.isFinite(n)) led.number(n);
  }

  const vendors = table.offers.slice(0, 10).map((o: any) => {
    const q = resolved.quotes.find((x) => x.offer_id === o.offer_id);
    led.paise(o.base_paise, o.landed_paise, o.normalised_paise, o.freight_paise, o.handling_paise, o.loading_paise)
      .entity(o.vendor?.name, o.vendor?.locality, o.platform)
      // The state words the payload carries verbatim. INCL/EXCL in particular
      // reads as a claim about GST, which is exactly the kind of thing a reply
      // repeats and must not be punished for.
      .entity(o.gst_treatment, o.stock_state, o.cert_state, o.freshness_state, o.delivery_scope,
        o.base_unit, o.normalised_unit, o.moq_unit)
      .number(o.lead_time_days, o.moq_qty)
      .source({ label: o.vendor?.name ?? 'listing', url: o.source_url, fetched_at: o.fetched_at, confidence: o.freshness_state });
    return {
      vendor: o.vendor?.name, locality: o.vendor?.locality, platform: o.platform,
      base: R(o.base_paise), base_unit: o.base_unit,
      landed: R(o.landed_paise), per_unit: R(o.normalised_paise), unit: o.normalised_unit,
      freight: R(o.freight_paise), gst_treatment: o.gst_treatment,
      delivery_scope: o.delivery_scope, stock: o.stock_state,
      lead_time_days: o.lead_time_days, moq: o.moq_qty ? `${o.moq_qty} ${o.moq_unit ?? ''}`.trim() : null,
      cert_state: o.cert_state, freshness: o.freshness_state,
      quotable: q?.quotable ?? null, blocked_reason: q?.blocked_reason ?? null,
      source_url: o.source_url,
    };
  });

  led.number(table.total_vendors, table.total_offers);
  // rank_by_quality deposits cert_standards and this did not — the same IS code
  // was quotable from one tool and a violation from the other.
  led.entity(CATEGORY_LABEL[p.category] ?? p.category, ...(JSON.parse(p.cert_standards || '[]') as string[]))
    .claim(p.qco_citation);

  return {
    ok: true, ledger: led,
    ui: {
      kind: 'product_detail', product_id: a.product_id,
      title: p.title, brand: p.brand,
      total_vendors: table.total_vendors, total_offers: table.total_offers,
      vendors: vendors.slice(0, 6),
    },
    data: {
      product: {
        title: p.title, brand: p.brand, category: CATEGORY_LABEL[p.category] ?? p.category,
        unit: p.unit_canonical, trade_unit: p.unit_trade, hsn: p.hsn, gst: `${p.gst_rate_bp / 100}%`,
        attributes: Object.fromEntries(Object.entries(attrs).filter(([k, v]) => k !== '_blob' && v != null)),
        bis_qco_regulated: !!p.qco_regulated,
        qco_citation: p.qco_citation,
        standards: JSON.parse(p.cert_standards || '[]'),
        country_of_origin: p.country_of_origin,
      },
      specs: specs.map((s) => ({ label: s.label, value: s.value, unit: s.unit, confidence: s.confidence, derivation: s.derivation, source: s.source_url })),
      vendors, total_vendors: table.total_vendors, total_offers: table.total_offers,
    },
  };
}

// ─── 4. quality ranking, with a declared rubric ──────────────────────────────

/**
 * "Which is the best cement you have?"
 *
 * Answered, not deflected — but answered against a rubric that is named in the
 * output, because "best" is not a property of cement. Three things make this
 * honest rather than merely confident:
 *
 *   `coverage` states how many listings actually declared the field being
 *   ranked on. Grade is declared on 109 of 294 cement products here, and a
 *   ranking that hides that is inventing a consensus out of a minority.
 *
 *   Application changes the answer. OPC 53 gains strength fastest, which is
 *   what a slab wants and what a mass pour must avoid. PPC is the durable
 *   choice near the coast. There is no single winner, so the tool returns the
 *   winner PER APPLICATION and the model must say which it answered for.
 *
 *   Price rank is reported alongside, so "best" and "dearest" can be seen to
 *   be different questions.
 */
export interface QualityArgs {
  category: string;
  application?: string;
  limit?: number;
}

const CEMENT_GRADE_RANK: Record<string, number> = { '53 grade': 3, '43 grade': 2, '33 grade': 1 };
const TMT_GRADE_RANK: Record<string, number> = { 'Fe 550D': 5, 'Fe 550': 4, 'Fe 500D': 3, 'Fe 500': 2, 'Fe 415': 1 };
const CERT_RANK: Record<string, number> = { CERTIFIED: 3, BRAND_LICENSED: 2, NOT_DECLARED: 0, EXPIRED: 0, NOT_APPLICABLE: 1 };

const APPLICATION_GUIDE: Record<string, Array<{ match: (a: any) => boolean; why: string }>> = {
  cement: [
    { match: (a) => a.cement_type === 'OPC' && a.opc_grade === '53 grade',
      why: 'OPC 53 reaches its 28-day strength fastest, which is what a structural slab, column or beam wants — IS 269:2015.' },
    { match: (a) => a.cement_type === 'PPC',
      why: 'PPC gains strength more slowly but ends denser and more sulphate-resistant — the durable choice for foundations, plaster and anything near the coast. IS 1489 Part 1.' },
    { match: (a) => a.cement_type === 'PSC',
      why: 'PSC (slag) has the lowest heat of hydration, which is what a mass pour needs to avoid thermal cracking. IS 455.' },
  ],
  tmt_steel: [
    { match: (a) => String(a.grade ?? '').endsWith('D'),
      why: 'The D grades have tighter limits on sulphur and phosphorus and better elongation, which is what earthquake-resistant detailing asks for. IS 1786:2008.' },
  ],
};

/** The attribute that actually distinguishes one listing from another, per category. */
const GRADE_KEY: Record<string, string | null> = {
  cement: 'opc_grade', tmt_steel: 'grade', water_pipes: null, bricks_blocks: null,
};
/** What the catalogue groups by when it cannot rank. */
const GROUP_KEY: Record<string, string | null> = {
  cement: null, tmt_steel: null, water_pipes: 'pipe_system', bricks_blocks: 'block_type',
};

/**
 * Is there anything here to rank ON?
 *
 * The rubric is grade 40% + certification 25% + branded 15% + vendor breadth 20%.
 * Three of those four are constant for bricks — there is no brick grade field in
 * the schema at all, and 94% of them sit at NOT_APPLICABLE because an unbranded
 * kiln brick is not something BIS licenses. The score therefore reduces to
 * "how many sellers carry it", and the tool was returning the cheapest unbranded
 * brick in the catalogue as the top quality result.
 *
 * Every number in that answer was real, which is why the fact ledger passed it.
 * A ledger checks that a figure came from the data; it cannot check that the
 * *arithmetic over* the data means what the label says. This gate is that check,
 * and it is measured rather than hardcoded per category so a future collection
 * run that finally brings brick grades in flips it back on by itself.
 */
function rankableOn(cat: string, rows: Array<{ a: any; cert_rank?: number }>): boolean {
  const gradeKey = GRADE_KEY[cat];
  if (gradeKey && rows.some((r) => r.a[gradeKey])) return true;
  const states = new Set(rows.map((r) => r.cert_rank ?? 0));
  // More than one state present AND at least one is a real BIS signal — a split
  // between "not declared" and "not applicable" discriminates nothing.
  return states.size > 1 && rows.some((r) => (r.cert_rank ?? 0) >= 2);
}

/**
 * What to answer when a ranking would be a lie.
 *
 * Not a refusal. The question behind "which brick is best" is "which brick for
 * my wall", and that IS answerable — from published standards for the type, and
 * from this catalogue for the price. What is not answerable is an ordering, and
 * the reply says so in its own words rather than leaving the user to infer it.
 */
function guideInstead(
  cat: string, parsed: any[], a: QualityArgs, ctx: ToolContext, led: FactLedger,
): ToolResult {
  const groupKey = GROUP_KEY[cat];
  const duty = a.application ? dutyFromText(a.application) : null;

  // Group by the attribute that actually separates these, and price each group
  // from the catalogue. Median, not mean — one ₹322 novelty listing should not
  // move what a clay brick costs.
  const groups = new Map<string, any[]>();
  for (const r of parsed) {
    const k = (groupKey && r.a[groupKey]) || 'Not classified';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const types = [...groups.entries()].map(([type, rs]) => {
    const prices = rs.map((r) => r.normalised_paise).sort((x, y) => x - y);
    const median = prices[Math.floor(prices.length / 2)];
    const vendors = rs.reduce((n, r) => n + (r.vendor_count ?? 0), 0);
    const g = MASONRY_GUIDE.find((m) => m.block_type === type);
    // The guide covers masonry. For everything else the governing standard is
    // already on the product rows — `certStandardsFor()` mapped it at collection
    // — so read it from the catalogue rather than leaving a dash where the
    // answer is known. Most common wins; a group is one product class.
    const tally = new Map<string, number>();
    for (const r of rs) {
      for (const s of JSON.parse(r.cert_standards || '[]') as string[]) tally.set(s, (tally.get(s) ?? 0) + 1);
    }
    const commonest = [...tally.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    const standard = g?.standard ?? commonest;

    led.paise(median, prices[0], prices[prices.length - 1]).number(rs.length, vendors).entity(type);
    if (standard) led.entity(standard);
    if (g) led.claim(g.why);
    return {
      type,
      listings: rs.length,
      sellers: vendors,
      median: R(median),
      range: `${R(prices[0])} – ${R(prices[prices.length - 1])}`,
      standard,
      standard_title: g?.standard_title ?? null,
      why: g?.why ?? null,
      caution: g?.caution ?? null,
      suits: g ? g.suited_to : null,
      // Ranked by how many sellers carry it — stated as that and nothing more.
      confidence: g?.confidence ?? null,
    };
  }).sort((x, y) => y.sellers - x.sellers);

  const forDuty = duty
    ? types.filter((t) => t.suits?.includes(duty)).map((t) => ({ type: t.type, standard: t.standard, median: t.median, why: t.why }))
    : [];
  if (duty) led.claim(DUTY_LABEL[duty]);

  // The honesty block is the answer, not a footnote on it.
  const declaredGrade = 0;
  const certified = parsed.filter((r) => (r.cert_rank ?? 0) >= 2).length;
  led.number(parsed.length, certified, declaredGrade);

  const honesty: string[] = [];
  if (cat === 'bricks_blocks') {
    honesty.push(
      `Bricks and blocks are not graded the way cement is. There is no grade field on any of the ` +
      `${parsed.length} listings I have here, and ${certified} carry a BIS licence — so I cannot rank ` +
      `them by quality and will not pretend to. What decides a brick is what the wall has to do.`,
    );
    honesty.push(CLIMATE_NOTE.text);
    led.claim(CLIMATE_NOTE.text);
  } else {
    honesty.push(
      `Nothing in these ${parsed.length} listings declares a grade or a certification I can rank on ` +
      `— ${certified} carry a BIS licence. I can tell you what types exist and what each costs, not ` +
      `which is best.`,
    );
  }
  if (cat === 'bricks_blocks') {
    honesty.push(
      'Compressive strength is a property of a tested consignment, not of a listing. Ask the seller ' +
      'for a test certificate before a load-bearing order.',
    );
  }
  for (const h of honesty) led.claim(h);

  // The rest of what this payload emits. The type table carries standard titles,
  // cautions and duty labels the model is expected to quote back, and the duty
  // list is offered to the user as the next question.
  for (const t of types) led.entity(t.standard_title, t.confidence).claim(t.caution);
  led.entity(CATEGORY_LABEL[cat], ...Object.values(DUTY_LABEL));

  return {
    ok: true, ledger: led,
    ui: {
      kind: 'masonry_guide',
      category: CATEGORY_LABEL[cat] ?? cat,
      duty: duty ? DUTY_LABEL[duty] : null,
      types, for_duty: forDuty, honesty,
    },
    data: {
      category: CATEGORY_LABEL[cat],
      rankable: false,
      why_not_ranked:
        'No grade is declared on any listing in this category and certification does not discriminate ' +
        'between them, so a "best" ordering would be sorting on seller count with a quality label on it.',
      answered_by: duty
        ? DUTY_LABEL[duty]
        : cat === 'bricks_blocks'
          ? 'type — tell me what the wall has to do and I will narrow it'
          : 'type — say what it is for and I will narrow it',
      types, for_duty: forDuty, honesty,
      // Only masonry has duties to offer. Suggesting them for pipes would be
      // inviting a question this cannot answer.
      duties_i_can_answer: cat === 'bricks_blocks' ? Object.values(DUTY_LABEL) : undefined,
    },
  };
}

export function rankByQuality(a: QualityArgs, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const cat = a.category;
  if (!(CATEGORIES as readonly string[]).includes(cat)) {
    return { ok: false, ledger: led, data: { error: 'UNKNOWN_CATEGORY', have: CATEGORIES.map((c) => CATEGORY_LABEL[c]) } };
  }

  const rows = prep(
    `SELECT p.product_id, p.title, p.brand, p.attrs, p.qco_regulated, p.cert_standards,
            pc.normalised_paise, pc.vendor_count, pc.offer_count, pc.priced_as_of, pc.sla_hours,
            (SELECT MAX(CASE o.cert_state WHEN 'CERTIFIED' THEN 3 WHEN 'BRAND_LICENSED' THEN 2
                                          WHEN 'NOT_APPLICABLE' THEN 1 ELSE 0 END)
               FROM offer o WHERE o.product_id = p.product_id AND o.region_id = pc.region_id AND o.is_active = 1) AS cert_rank
       FROM price_current pc JOIN product p ON p.product_id = pc.product_id
      WHERE pc.region_id = ? AND p.category = ?`,
  ).all(ctx.region_id, cat) as any[];

  if (!rows.length) return { ok: false, ledger: led, data: { error: 'NO_COVERAGE', category: CATEGORY_LABEL[cat], region: ctx.region_id } };

  const parsed = rows.map((r) => ({ ...r, a: JSON.parse(r.attrs || '{}') }));

  // Categories where the rubric has nothing to weigh answer by duty instead of
  // by rank. See rankableOn() for why this is a correctness gate and not taste.
  if (!rankableOn(cat, parsed)) return guideInstead(cat, parsed, a, ctx, led);

  // What we can actually rank on, stated before we rank.
  const gradeKey = GRADE_KEY[cat];

  /**
   * A 33/43/53 grade belongs to OPC under IS 269. PPC is graded under IS 1489
   * and PSC under IS 455, and neither has a "53 grade" — so a listing that
   * says "PPC 53 grade" is the seller's own error, faithfully captured.
   *
   * Ranking on it would launder that error into a recommendation, so the
   * grade is ignored for non-OPC and the contradiction is counted and
   * reported. This is the difference between a catalogue that repeats what
   * sellers say and one that knows what it is looking at.
   */
  const gradeApplies = (r: any) => {
    if (cat !== 'cement') return !!r.a[gradeKey!];
    return r.a.cement_type === 'OPC' && !!r.a.opc_grade;
  };
  const gradeMismatch = cat === 'cement'
    ? parsed.filter((r) => r.a.opc_grade && r.a.cement_type && r.a.cement_type !== 'OPC').length
    : 0;

  const withGrade = gradeKey ? parsed.filter(gradeApplies) : [];
  const coverage = {
    total: parsed.length,
    grade_declared: gradeKey ? withGrade.length : null,
    grade_field: gradeKey,
    grade_ignored_wrong_type: gradeMismatch,
    certified: parsed.filter((r) => r.cert_rank === 3).length,
    brand_licensed: parsed.filter((r) => r.cert_rank === 2).length,
    branded: parsed.filter((r) => r.brand).length,
  };
  led.number(coverage.total, coverage.grade_declared, coverage.certified, coverage.brand_licensed, coverage.branded);

  const gradeRank = cat === 'cement' ? CEMENT_GRADE_RANK : cat === 'tmt_steel' ? TMT_GRADE_RANK : {};
  const maxVendors = Math.max(...parsed.map((r) => r.vendor_count), 1);

  const scored = parsed.map((r) => {
    const g = gradeKey && gradeApplies(r) ? (gradeRank[String(r.a[gradeKey])] ?? 0) : 0;
    const maxG = Math.max(...Object.values(gradeRank), 1);
    const s =
      (g / maxG) * 0.40 +
      ((r.cert_rank ?? 0) / 3) * 0.25 +
      (r.brand ? 1 : 0) * 0.15 +
      (r.vendor_count / maxVendors) * 0.20;
    return { ...r, score: s, grade_value: gradeKey && gradeApplies(r) ? r.a[gradeKey] ?? null : null };
  }).sort((x, y) => y.score - x.score || y.vendor_count - x.vendor_count);

  const byPrice = [...parsed].sort((x, y) => x.normalised_paise - y.normalised_paise);
  const priceRankOf = (id: string) => byPrice.findIndex((r) => r.product_id === id) + 1;

  const top = scored.slice(0, Math.min(8, a.limit ?? 5)).map((r) => {
    const fresh = assess(r.priced_as_of, r.sla_hours);
    led.paise(r.normalised_paise).number(r.vendor_count, r.offer_count, priceRankOf(r.product_id))
      .entity(r.title, r.brand, r.grade_value, fresh.label, ...(JSON.parse(r.cert_standards || '[]') as string[]));
    return {
      product_id: r.product_id, title: r.title, brand: r.brand,
      declared_grade: r.grade_value,
      certification: ['not declared', 'n/a', 'brand-licensed BIS mark', 'independently certified'][r.cert_rank ?? 0],
      vendors_carrying: r.vendor_count,
      price: R(r.normalised_paise),
      price_rank: `${priceRankOf(r.product_id)} of ${parsed.length} cheapest`,
      standards: JSON.parse(r.cert_standards || '[]'),
      freshness: fresh.label,
    };
  });

  const guides = (APPLICATION_GUIDE[cat] ?? []).map((g) => {
    const winner = scored.find((r) => g.match(r.a));
    if (winner) led.entity(winner.title, winner.brand).paise(winner.normalised_paise);
    return { why: g.why, best: winner ? { product_id: winner.product_id, title: winner.title, brand: winner.brand, price: R(winner.normalised_paise) } : null };
  }).filter((g) => g.best);

  for (const g of guides) led.claim(g.why);

  const rubricText =
    `Ranked on: declared grade (40%), certification state (25%), branded vs unbranded (15%), ` +
    `and how many sellers carry it (20%). Price is deliberately NOT in this score — it is reported beside it.`;
  led.claim(rubricText);

  const honesty: string[] = [];
  if (gradeKey && coverage.grade_declared! < coverage.total) {
    const pct = Math.round((coverage.grade_declared! / coverage.total) * 100);
    led.number(pct, coverage.grade_declared!, coverage.total);
    honesty.push(`Grade is declared on only ${coverage.grade_declared} of ${coverage.total} listings (${pct}%). Everything else scores zero on grade because the seller did not state it — that is missing data, not low quality.`);
  }
  if (gradeMismatch > 0) {
    led.number(gradeMismatch);
    honesty.push(`${gradeMismatch} listings advertise a "53 grade" or "43 grade" PPC or PSC cement. Those grades exist only for OPC under IS 269 — PPC is IS 1489 and PSC is IS 455, and neither is graded that way. I ignored the grade on those rather than repeat the seller's mistake.`);
  }
  if (coverage.certified <= 1) {
    honesty.push(`Almost nothing here carries an independent certificate — ${coverage.brand_licensed} listings show a brand-licensed BIS mark and ${coverage.certified} shows an independent one. I cannot verify a BIS licence number from a marketplace listing.`);
  }
  if (cat === 'cement' || cat === 'tmt_steel') {
    honesty.push(`This category is under a BIS Quality Control Order, so every legally sold unit must carry an ISI mark regardless of what the listing says. Ask the seller for the licence number before you pay.`);
  }
  for (const h of honesty) led.claim(h);

  // The cheapest row is emitted whether or not it scored into `top`, so it needs
  // its own deposit — otherwise a reply that answers "best" by contrasting it
  // with the cheapest is rejected for a price the tool itself handed over.
  const low = byPrice[0];
  led.paise(low.normalised_paise).entity(low.title, low.brand, CATEGORY_LABEL[cat]);

  const caveat =
    '"Best" is not a property of cement — it is a property of cement plus what you are pouring. ' +
    'The by-application answers below are the ones that matter.';
  led.claim(caveat);

  return {
    ok: true, ledger: led,
    // The panel renders this rather than trusting the model to retype it, so
    // the ui payload carries the rows themselves, not just their ids.
    ui: {
      kind: 'quality_ranking', category: CATEGORY_LABEL[cat] ?? cat,
      rubric: rubricText, ranked: top, by_application: guides, honesty, coverage,
    },
    data: {
      category: CATEGORY_LABEL[cat],
      rubric: rubricText,
      caveat,
      coverage, ranked: top,
      by_application: guides,
      honesty,
      cheapest: { title: low.title, brand: low.brand, price: R(low.normalised_paise) },
    },
  };
}

// ─── 5. quantity estimation ──────────────────────────────────────────────────

export function estimateQuantity(a: { kind: string; args: Record<string, unknown> }, _ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const est: Estimate = runEstimator(a.kind, a.args ?? {});

  if (!est.ok) {
    for (const m of est.missing) { led.claim(m.question); for (const o of m.options ?? []) led.entity(o); }
    return { ok: false, ledger: led, ui: { kind: 'slot_prompt', missing: est.missing }, data: est };
  }

  for (const n of est.facts) led.number(n);
  for (const l of est.lines) {
    // note and search_hint reach the model in the payload — "Band, not a figure.
    // Order against your bar bending schedule." and "TMT bar Fe 500" — so they
    // are deposited like everything else the model can read.
    led.entity(l.material, l.unit, l.search_hint).number(l.exact_qty, l.buy_qty).claim(l.note);
    if (l.band) led.number(l.band.low, l.band.high);
  }
  for (const s of est.steps) led.claim(`${s.label}: ${s.expression} = ${s.result}`);
  for (const c of est.coefficients) {
    led.entity(c.label, c.citation).claim(c.note);
    if ('value' in c) led.number(c.value); else led.number(c.low, c.high);
    led.claim(`${c.label} = ${'value' in c ? c.value : `${c.low}–${c.high}`} ${c.unit} (${c.confidence}: ${c.citation})`);
  }
  for (const cv of est.caveats) led.claim(cv);
  for (const as of est.assumptions) { led.entity(as.value).claim(`Assumed ${as.slot} = ${as.value} — ${as.because}`); }

  return { ok: true, ledger: led, ui: { kind: 'estimate', estimate: est }, data: est };
}

// ─── 6. price an estimate ────────────────────────────────────────────────────

/**
 * Turn a quantity into money by pricing each line against the real catalogue.
 *
 * This is where the two halves join, and it is the one place a hallucination
 * would be most expensive — so it does not multiply the model's numbers by the
 * model's prices. It re-runs the estimator, takes the cheapest live offer per
 * line, and does the arithmetic here.
 */
export function priceEstimate(a: { kind: string; args: Record<string, unknown> }, ctx: ToolContext): ToolResult {
  const est = runEstimator(a.kind, a.args ?? {});
  if (!est.ok) return estimateQuantity(a, ctx);

  const led = new FactLedger();
  const base = estimateQuantity(a, ctx);
  led.merge(base.ledger);

  let total = 0;
  let priced = 0;
  const lines = est.lines.map((l) => {
    if (!l.category || !l.search_hint) {
      return { material: l.material, qty: l.buy_qty, unit: l.unit, priced: false, reason: l.note ?? 'not in this catalogue' };
    }
    const r = search({ q: l.search_hint, pincode: ctx.pincode, region_id: ctx.region_id, category: l.category, sort: 'price_low', limit: 1 });
    const hit = r.results[0];
    if (!hit) return { material: l.material, qty: l.buy_qty, unit: l.unit, priced: false, reason: 'no live offer at this pincode' };

    const lineTotal = hit.normalised_paise * l.buy_qty;
    total += lineTotal; priced++;
    const fresh = assess(hit.priced_as_of, hit.sla_hours);
    // Both ends of the band are formatted into the payload, so both are
    // deposited. Every R() that reaches a reply needs a paise() beside it.
    const band = l.band
      ? { low: hit.normalised_paise * Math.ceil(l.band.low), high: hit.normalised_paise * Math.ceil(l.band.high) }
      : null;
    led.paise(hit.normalised_paise, lineTotal, band?.low, band?.high).number(l.buy_qty)
      .entity(hit.title, hit.brand, hit.best_vendor, hit.unit_canonical, fresh.label)
      .source({ label: hit.best_vendor, url: hit.source_url, fetched_at: hit.priced_as_of, confidence: fresh.state });

    return {
      material: l.material, qty: l.buy_qty, unit: l.unit, priced: true,
      product_id: hit.product_id, matched: hit.title, brand: hit.brand, vendor: hit.best_vendor,
      unit_price: R(hit.normalised_paise), per: hit.unit_canonical,
      line_total: R(lineTotal), freshness: fresh.label,
      band: band ? { low_total: R(band.low), high_total: R(band.high) } : undefined,
      source_url: hit.source_url,
    };
  });

  led.paise(total).number(priced, est.lines.length);

  const unpriced = lines.filter((l) => !l.priced).map((l) => l.material);
  const note = unpriced.length
    ? `This total covers ${priced} of ${est.lines.length} lines. Not priced: ${unpriced.join(', ')} — I hold quantities for these but no offers.`
    : `All ${priced} lines priced.`;
  led.claim(note);

  return {
    ok: true, ledger: led,
    ui: { kind: 'priced_estimate', estimate: est, lines, subtotal: R(total), lines_priced: priced, lines_total: est.lines.length },
    data: {
      headline: est.headline,
      lines,
      subtotal_priced: R(total),
      lines_priced: priced,
      lines_total: est.lines.length,
      note,
      basis: 'Cheapest live offer per line, landed at your pincode, GST included. A real order moves — get a written quote.',
      steps: est.steps, caveats: est.caveats, assumptions: est.assumptions,
    },
  };
}

// ─── 7. options, for slot filling ────────────────────────────────────────────

/**
 * The list a question offers as answers.
 *
 * A slot question with free-text answers is a slot question that never gets
 * answered. Every "which one?" the bot asks comes with the real options, and
 * they come from here rather than from the model's memory of what bricks exist.
 */
export function listOptions(a: { slot: string }, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const slot = a.slot.toLowerCase();

  const emit = (label: string, options: Array<{ id: string; label: string; note?: string }>) => {
    // Notes go through claim() rather than entity(): the numbers in them are
    // facts ("18–25 kg/m³", "41 listings"), the prose around them is not a name.
    // `label` is the group heading the model repeats back when it asks the
    // question — "Which brand?" — so it is deposited too.
    led.entity(label);
    for (const o of options) led.entity(o.label, o.id).claim(o.note);
    return { ok: true, ledger: led, ui: { kind: 'options', slot, options }, data: { slot, label, options } };
  };

  if (/brick|block|masonry|unit_id/.test(slot)) {
    return emit('Brick or block', UNITS_FOR_OPTS.map((u) => ({ id: u.id, label: u.label, note: u.note })));
  }
  if (/grade|mix|concrete/.test(slot)) {
    return emit('Concrete grade', MIX_GRADES.map((m) => ({
      id: m.grade, label: `${m.grade} (${m.cement}:${m.sand}:${m.aggregate})`,
      note: m.code_nominal ? undefined : m.note,
    })));
  }
  if (/mortar|plaster_mix/.test(slot)) {
    return emit('Mortar mix', MORTAR_MIXES.map((m) => ({ id: m.id, label: m.label, note: m.used_for })));
  }
  if (/element|steel|reinforce/.test(slot)) {
    return emit('Structural element', STEEL_BANDS.map((b) => ({ id: b.id.replace('steel_', ''), label: b.label, note: `${b.low}–${b.high} kg/m³ budgeting band` })));
  }
  if (/bore|diameter|pipe_size/.test(slot)) {
    const rows = prep(
      `SELECT DISTINCT json_extract(attrs,'$.nominal_bore_mm') AS mm FROM product
        WHERE category='water_pipes' AND mm IS NOT NULL ORDER BY mm`,
    ).all() as any[];
    for (const r of rows) led.number(r.mm);
    return emit('Pipe bore', rows.map((r) => ({ id: String(r.mm), label: `${r.mm} mm` })));
  }
  if (/brand/.test(slot)) {
    const cat = slot.split(':')[1];
    const rows = prep(
      `SELECT p.brand, COUNT(DISTINCT p.product_id) n FROM price_current pc JOIN product p ON p.product_id=pc.product_id
        WHERE pc.region_id=? AND p.brand IS NOT NULL ${cat ? 'AND p.category=?' : ''}
        GROUP BY p.brand ORDER BY n DESC LIMIT 20`,
    ).all(...(cat ? [ctx.region_id, cat] : [ctx.region_id])) as any[];
    return emit('Brand', rows.map((r) => ({ id: r.brand, label: r.brand, note: `${r.n} listings` })));
  }
  if (/categor|product|material/.test(slot)) {
    return emit('Category', CATEGORIES.map((c) => ({ id: c, label: CATEGORY_LABEL[c] })));
  }
  if (/city|region|pincode/.test(slot)) {
    const rows = prep(`SELECT region_id, name, pincode_from, pincode_to FROM region`).all() as any[];
    for (const r of rows) led.entity(r.name, r.pincode_from, r.pincode_to);
    return emit('City', rows.map((r) => ({ id: r.region_id, label: r.name, note: `pincodes ${r.pincode_from}–${r.pincode_to}` })));
  }

  return { ok: false, ledger: led, data: { error: 'UNKNOWN_SLOT', slot, known: ['brick', 'grade', 'mortar', 'element', 'bore', 'brand', 'category', 'city'] } };
}

// ─── 8. compare ──────────────────────────────────────────────────────────────

export function compareProducts(a: { product_ids: string[] }, ctx: ToolContext): ToolResult {
  const led = new FactLedger();
  const ids = (a.product_ids ?? []).slice(0, 4);
  if (ids.length < 2) return { ok: false, ledger: led, data: { error: 'NEED_TWO', message: 'Give me at least two product ids.' } };

  const rows = ids.map((id) => {
    const d = getProductDetail({ product_id: id }, ctx);
    led.merge(d.ledger);
    return d.ok ? d.data : { error: 'NOT_AVAILABLE', product_id: id };
  });

  const priced = rows.filter((r: any) => !('error' in r)) as any[];
  let comparability: string | null = null;
  if (priced.length >= 2) {
    const units = new Set(priced.map((r) => r.product.unit));
    if (units.size > 1) comparability = `These are quoted in different units (${[...units].join(', ')}) — the per-unit numbers are not directly comparable. Tell me the quantity you need and I will put both on the same basis.`;
    if (comparability) led.claim(comparability);
  }

  return {
    ok: true, ledger: led,
    ui: {
      kind: 'compare',
      note: comparability,
      products: priced.map((r: any) => ({
        title: r.product.title, brand: r.product.brand, unit: r.product.unit,
        best: r.vendors[0]?.per_unit ?? null, vendor: r.vendors[0]?.vendor ?? null,
        vendors: r.total_vendors,
      })),
    },
    data: { products: rows, comparability_note: comparability },
  };
}

// ─── registry ────────────────────────────────────────────────────────────────

export const TOOLS = {
  get_catalogue_scope: getCatalogueScope,
  search_products: searchProducts,
  get_product_detail: getProductDetail,
  rank_by_quality: rankByQuality,
  estimate_quantity: estimateQuantity,
  price_estimate: priceEstimate,
  list_options: listOptions,
  compare_products: compareProducts,
} as const;

export type ToolName = keyof typeof TOOLS;

export function callTool(name: string, args: any, ctx: ToolContext): ToolResult {
  const fn = (TOOLS as Record<string, (a: any, c: ToolContext) => ToolResult>)[name];
  if (!fn) return { ok: false, ledger: new FactLedger(), data: { error: 'UNKNOWN_TOOL', name, available: Object.keys(TOOLS) } };
  try {
    return fn(args ?? {}, ctx);
  } catch (e: any) {
    return { ok: false, ledger: new FactLedger(), data: { error: 'TOOL_FAILED', name, message: String(e?.message ?? e) } };
  }
}
