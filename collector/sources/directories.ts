/**
 * B2B directories other than IndiaMART: TradeIndia, ExportersIndia, Justdial.
 *
 * These hold real long-tail dealer supply for both cities, but each guards it
 * differently — Justdial returns a 30-byte body to a scripted client, TradeIndia
 * renders listings client-side, ExportersIndia serves partial markup. Every
 * attempt is recorded with its real outcome and an estimate of what was behind
 * the wall, because a quiet cap reads as "we covered everything" when we didn't.
 */
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, RawOffer, SourceResult } from '../types';
import { classifyFailure } from '../fetch';

export interface Target {
  id: string; platform: string; source_class: 'b2b_directory';
  url: string; category: string; region_id: string; estimatedListings: number;
}

/** Exposed for tests and for probing a live page without running a sweep. */
export { targetsFor as __targetsFor };

const CITY = { hyderabad: 'hyderabad', vijayawada: 'vijayawada' } as const;
const SLUG: Record<string, { ti: string; jd: string }> = {
  cement: { ti: 'cement', jd: 'Cement-Dealers' },
  tmt_steel: { ti: 'tmt bar', jd: 'Iron-Steel-Dealers' },
  water_pipes: { ti: 'pvc pipe', jd: 'Pipe-Dealers' },
  bricks_blocks: { ti: 'bricks', jd: 'Brick-Dealers' },
};

/**
 * Which city names count as "in region". TradeIndia returns a free-text city
 * per listing, and the results are national unless the city is in the keyword,
 * so this is the guard that keeps an Ahmedabad seller out of a Hyderabad
 * delivered-price surface.
 */
const IN_REGION: Record<string, RegExp> = {
  hyderabad: /\b(hyderabad|secunderabad|hitech city|medchal|rangareddy|ranga reddy)\b/i,
  vijayawada: /\b(vijayawada|bezawada|gannavaram|guntur|krishna)\b/i,
};

/**
 * ExportersIndia used to be a third target here and now has its own adapter,
 * `collector/sources/exportersindia.ts`. It needed a slug vocabulary, real
 * pagination and one SourceResult per slug — none of which fits this file's
 * one-target-one-URL loop — and its markup needs selectors of its own, which is
 * why it returned nothing for the whole build while sitting on `parseGeneric`.
 *
 * TradeIndia was fixed on 2026-08-05, and the fix is three separate findings:
 *
 * 1. **The old URL was a soft-404.** `/{city}/{slug}-city-183463.html` carried a
 *    hardcoded numeric id that never varied by category or city, so all eight
 *    combinations fetched the same page. It now returns a 160 KB body, which is
 *    why the size heuristic below started calling it `parse_fail` — but its
 *    `listing_data` is an empty array. There was never anything to parse.
 *
 * 2. **The listings are not in the markup.** TradeIndia is a Next.js app and
 *    renders results client-side; the server sends them in `__NEXT_DATA__`. The
 *    page contains zero `₹` characters, which is why `parseGeneric` — which
 *    looks for a rupee sign inside `[class*=product|listing|card]` — could never
 *    have matched regardless of the URL. We now read the JSON, which is both the
 *    only thing that works and considerably more stable than class-name
 *    heuristics.
 *
 * 3. **`?city=` is decorative.** Probed 2026-08-05: `keyword=cement&city=hyderabad`
 *    returned 28 rows of which **one** was in Hyderabad; page 2 returned 28 of
 *    which **none** were. TradeIndia's own city chip for Hyderabad carries
 *    `state: "Sind"` — the Pakistani one — so their city taxonomy cannot be
 *    relied on at all. Putting the city in the *keyword* does scope it, and that
 *    is what we do, with IN_REGION as a second guard on each row.
 *
 * What this source can actually contribute is small and the numbers are in the
 * collection log rather than hidden: scoped to the city, a category returns
 * single digits, and TradeIndia publishes **no unit** with any price — the field
 * is a bare string like `"1650.00 INR (Approx.)"`. Those rows are passed through
 * with `price_unit: null` and the normaliser refuses them by name rather than
 * inventing a basis (`normalize.ts:648`). "(Approx.)" is TradeIndia's own hedge
 * and is preserved verbatim in `price_text`.
 */
function targetsFor(category: string, region_id: string): Target[] {
  const c = CITY[region_id as keyof typeof CITY];
  const s = SLUG[category];
  if (!c || !s) return [];
  return [
    { id: `tradeindia:${c}:${category}`, platform: 'TradeIndia', source_class: 'b2b_directory',
      url: `https://www.tradeindia.com/search.html?keyword=${encodeURIComponent(`${s.ti} ${c}`)}`,
      category, region_id, estimatedListings: 60 },
    { id: `justdial:${c}:${category}`, platform: 'Justdial', source_class: 'b2b_directory',
      url: `https://www.justdial.com/${c.charAt(0).toUpperCase() + c.slice(1)}/${s.jd}`, category, region_id, estimatedListings: 120 },
  ];
}

const num = (s: string): number | null => {
  const m = s.replace(/[, ]/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/**
 * What a TradeIndia fetch actually told us, so `run` can report the real reason
 * rather than inferring one from body size. `parse_fail` should mean our parser
 * broke — not that a city has no dealers, which is what it meant for this whole
 * build while the URL was dead.
 */
interface TiParse {
  offers: RawOffer[];
  /** rows in listing_data before any filtering */
  seen: number;
  /** rows whose city is inside the target region */
  inRegion: number;
  /** in-region rows whose title still bears the category term */
  onTopic: number;
  /** on-topic rows carrying a parseable amount */
  priced: number;
  /** national result count TradeIndia claims for the query */
  claimed: number;
  reason: 'ok' | 'no_json' | 'no_rows' | 'no_in_region' | 'no_topic' | 'no_priced';
}

/**
 * TradeIndia drops the category term on some queries and returns whatever is
 * tagged with the city: probed 2026-08-05, `cement vijayawada` and
 * `bricks vijayawada` come back byte-identical — 56 claimed, the same 28 rows,
 * led by "Mist Maker Plate" and "HILCO Replacement Filter". Without this guard a
 * priced mist maker would enter the surface as cement.
 *
 * It is deliberately loose — one term token in the title is enough — because it
 * is a first sieve, not the arbiter. `NOT_THIS_CATEGORY` in normalize.ts is what
 * catches the subtler mismatches this cannot, such as a "Cement Feeding Rubber
 * Hose" that does carry the word.
 */
function bearsCategoryTerm(title: string, term: string): boolean {
  const tokens = term.split(/\s+/).filter((w) => w.length >= 3);
  if (!tokens.length) return true;
  const t = title.toLowerCase();
  return tokens.some((w) => t.includes(w.toLowerCase()));
}

/**
 * TradeIndia renders client-side; the server payload is a Next.js data island.
 * Everything below comes out of `serverData.searchListingData.listing_data`.
 */
export function parseTradeIndia(html: string, t: Target): TiParse {
  const empty = (reason: TiParse['reason']): TiParse =>
    ({ offers: [], seen: 0, inRegion: 0, onTopic: 0, priced: 0, claimed: 0, reason });

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return empty('no_json');

  let data: any;
  try { data = JSON.parse(m[1]); } catch { return empty('no_json'); }

  const search = data?.props?.pageProps?.serverData?.searchListingData;
  const rows: any[] = Array.isArray(search?.listing_data) ? search.listing_data : [];
  const claimed = Number(search?.listing_count) || 0;
  if (!rows.length) return { ...empty('no_rows'), claimed };

  const inRegionRe = IN_REGION[t.region_id];
  const local = rows.filter((r) => inRegionRe?.test(String(r?.city ?? '')));
  if (!local.length) {
    return { offers: [], seen: rows.length, inRegion: 0, onTopic: 0, priced: 0, claimed, reason: 'no_in_region' };
  }

  const term = SLUG[t.category]?.ti ?? '';
  const onTopic = local.filter((r) => bearsCategoryTerm(String(r?.product_name ?? ''), term));
  if (!onTopic.length) {
    return {
      offers: [], seen: rows.length, inRegion: local.length, onTopic: 0, priced: 0, claimed,
      reason: 'no_topic',
    };
  }

  const now = new Date().toISOString();
  const out: RawOffer[] = [];

  for (const r of onTopic) {
    const title = String(r?.product_name ?? '').trim();
    const vendor = String(r?.initial_co_name ?? r?.co_name ?? '').trim();
    if (!title || title.length < 4 || !vendor) continue;

    // "1650.00 INR (Approx.)". `amount` next to it is NOT money — it runs to
    // seven digits on a ₹39 listing — so only this string is trusted.
    const priceText = typeof r?.price === 'string' ? r.price : null;
    const rupees = priceText ? num(priceText.replace(/\(approx\.?\)/i, '')) : null;
    if (!rupees) continue;

    const href = String(r?.prod_url ?? '').trim();
    out.push({
      source_id: t.id, source_class: t.source_class, fetch_mode: 'http',
      source_url: href ? new URL(href, 'https://www.tradeindia.com').toString() : t.url,
      source_ref: `TradeIndia:${r?.product_id ?? title.slice(0, 40)}:${vendor.slice(0, 30)}`,
      fetched_at: now, region_id: t.region_id, category: t.category, platform: t.platform,
      title,
      vendor_name: vendor,
      vendor_locality: String(r?.city ?? '').trim() || null,
      vendor_city: String(r?.city ?? '').trim() || null,
      seller_type: r?.ifmanu ? 'manufacturer' : r?.ifdistributor ? 'distributor' : 'dealer',
      // Verbatim, so "(Approx.)" survives into the record. It is TradeIndia's
      // own hedge and the buyer is entitled to see it.
      price_text: priceText!.trim(),
      price_paise: Math.round(rupees * 100),
      // TradeIndia publishes no unit anywhere on the listing — not in `price`,
      // not in `currency`, `price_range`, `deals_in` or the spec hstore, all of
      // which come back null. Passing null is deliberate: normalise() refuses it
      // as `unmappable unit "(none)"` and records the row. Guessing "per bag"
      // here would be inventing the one thing this build refuses to invent.
      price_unit: null,
      gst_treatment: 'EXCL',
      gst_note: 'B2B directory listing; treated as ex-GST, the convention on these platforms.',
      stock_state: r?.in_stock === true ? 'in_stock' : 'unknown',
      specs: {},
    });
  }

  return {
    offers: out, seen: rows.length, inRegion: local.length, onTopic: onTopic.length,
    priced: out.length, claimed,
    reason: out.length ? 'ok' : 'no_priced',
  };
}

/** Generic directory-card parse; tolerant because these layouts differ. */
function parseGeneric(html: string, t: Target): RawOffer[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const out: RawOffer[] = [];

  $('[class*="product"],[class*="listing"],[class*="card"]').each((_, el) => {
    const $el = $(el);
    const text = $el.text();
    if (text.length > 3000) return; // container, not a card
    const priceM = text.match(/₹\s*([\d,]+(?:\.\d+)?)\s*(?:\/\s*([A-Za-z ]{2,18}))?/);
    if (!priceM) return;
    const title = $el.find('h2,h3,h4,a[title]').first().text().trim();
    if (!title || title.length < 4) return;
    const vendor =
      $el.find('[class*="company"],[class*="seller"],[class*="supplier"]').first().text().trim();
    if (!vendor) return;
    const rupees = num(priceM[1]);
    if (!rupees) return;
    const href = $el.find('a').first().attr('href') ?? t.url;

    out.push({
      source_id: t.id, source_class: t.source_class, fetch_mode: 'http',
      source_url: href.startsWith('http') ? href : new URL(href, t.url).toString(),
      source_ref: `${t.platform}:${title.slice(0, 40)}:${vendor.slice(0, 30)}`,
      fetched_at: now, region_id: t.region_id, category: t.category, platform: t.platform,
      title,
      vendor_name: vendor,
      vendor_locality: t.region_id === 'hyderabad' ? 'Hyderabad' : 'Vijayawada',
      vendor_city: t.region_id === 'hyderabad' ? 'Hyderabad' : 'Vijayawada',
      seller_type: 'dealer',
      price_text: priceM[0],
      price_paise: Math.round(rupees * 100),
      price_unit: priceM[2]?.trim() ?? null,
      gst_treatment: 'EXCL',
      gst_note: 'B2B directory listing; treated as ex-GST, the convention on these platforms.',
      stock_state: 'unknown',
      specs: {},
    });
  });
  return out;
}

export const tradeDirectories: Adapter = {
  id: 'trade-directories',
  source_class: 'b2b_directory',
  label: 'TradeIndia · ExportersIndia · Justdial',
  covers: ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'].flatMap((category) =>
    ['hyderabad', 'vijayawada'].map((region_id) => ({ category, region_id })),
  ),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const results: SourceResult[] = [];
    for (const t of targetsFor(category, region_id)) {
      const res = await ctx.fetchText(t.url);
      const tiny = res.body.length < 2000;
      const walled = /enable javascript|checking your browser|captcha|access denied/i.test(res.body.slice(0, 3000));

      if (!res.ok || tiny || walled) {
        // A sub-2 KB body is a bot wall or a stub, not a result. Calling it
        // `empty` put it in the same bucket as a genuine 404 and made a source
        // that refuses us look like a source with nothing in it.
        const outcome = walled ? 'blocked' : tiny ? 'blocked' : classifyFailure(res.status, res.body);
        results.push({
          source_id: t.id, source_class: t.source_class, category, region_id, url: t.url,
          fetch_mode: 'http', http_status: res.status, outcome,
          offers: [], pages_fetched: 0, pagination_exhausted: false,
          estimated_missed: t.estimatedListings,
          note: tiny
            ? `${t.platform} returned a ${res.body.length}-byte body to the scripted client — the listings are rendered client-side or behind a bot check. Roughly ${t.estimatedListings} dealer listings for ${category} in ${region_id} were not captured.`
            : `${t.platform} returned HTTP ${res.status}${walled ? ' with a bot wall' : ''}. Roughly ${t.estimatedListings} listings not captured.`,
        });
        ctx.log(`  ${t.id}: ${outcome} (est. ${t.estimatedListings} missed)`);
        continue;
      }

      // TradeIndia reports its own counts, so it never has to guess from body
      // size. Justdial keeps the size heuristic below.
      if (t.platform === 'TradeIndia') {
        const p = parseTradeIndia(res.body, t);
        // Only `no_json` is our defect now. The rest are true statements about
        // what the source published, and calling them parse_fail would be the
        // same blindness in the other direction.
        const outcome = p.reason === 'ok' ? 'ok' : p.reason === 'no_json' ? 'parse_fail' : 'empty';
        const note =
          p.reason === 'no_json'
            ? `HTTP ${res.status}, ${res.body.length.toLocaleString()}-byte body with no __NEXT_DATA__ island. ` +
              `TradeIndia renders listings client-side, so that island is the whole payload — this is a parser ` +
              `defect on our side and everything behind it is uncaptured.`
            : p.reason === 'no_rows'
              ? `Query returned an empty listing_data (${p.claimed} claimed nationally). Nothing to parse.`
              : p.reason === 'no_in_region'
                ? `${p.seen} listings returned, none in ${region_id}. TradeIndia's ?city= filter does not bind — ` +
                  `the city is in the keyword and rows are re-checked against it, so a national result is dropped ` +
                  `rather than mislabelled as local supply.`
                : p.reason === 'no_topic'
                  ? `${p.inRegion} of ${p.seen} listings are in ${region_id}, but none bear the "${SLUG[category]?.ti}" ` +
                    `term. TradeIndia drops the category from some queries and returns whatever is tagged with the ` +
                    `city, so these are city-local stock of an unrelated class, not ${category} supply.`
                  : p.reason === 'no_priced'
                    ? `${p.onTopic} of ${p.seen} listings are in ${region_id} and on topic, but none publish a ` +
                      `parseable amount.`
                    : `${p.priced} priced of ${p.onTopic} on-topic (${p.inRegion} in-region, ${p.seen} returned, ` +
                      `${p.claimed} claimed nationally). TradeIndia publishes no unit with any price, so these ` +
                      `reach the normaliser with price_unit=null and are refused by name rather than given an ` +
                      `invented basis. Page-one only.`;
        results.push({
          source_id: t.id, source_class: t.source_class, category, region_id, url: t.url,
          fetch_mode: 'http', http_status: res.status, outcome,
          offers: p.offers, pages_fetched: 1, pagination_exhausted: false,
          // What we missed is what was in-region and unusable, not the national
          // count — 9,007 nationwide is not 9,007 Hyderabad dealers.
          estimated_missed: Math.max(0, p.inRegion - p.priced),
          note,
        });
        ctx.log(
          `  ${t.id}: ${p.offers.length} offers (${outcome}; ` +
          `${p.inRegion}/${p.seen} in-region, ${p.onTopic} on-topic)`,
        );
        continue;
      }

      const offers = parseGeneric(res.body, t);
      // Justdial publishes no record count, so body size is the only
      // discriminator available: a substantial page that yields nothing is our
      // parser failing, not the market being empty. Reporting both as `empty`
      // is what let a broken URL read as "this city has no dealers" for the
      // whole build — the line below is the fix for that class of blindness.
      const substantial = res.body.length >= 30_000;
      const outcome = offers.length ? 'ok' : substantial ? 'parse_fail' : 'empty';
      results.push({
        source_id: t.id, source_class: t.source_class, category, region_id, url: t.url,
        fetch_mode: 'http', http_status: res.status,
        outcome,
        offers, pages_fetched: 1, pagination_exhausted: false,
        estimated_missed: offers.length ? Math.max(0, t.estimatedListings - offers.length) : t.estimatedListings,
        note: offers.length
          ? `Page-one only; deeper pagination not followed on this source.`
          : substantial
            ? `HTTP ${res.status}, ${res.body.length.toLocaleString()}-byte body, and no element matched ` +
              `[class*=product|listing|card] carrying a price. That is a parser defect on our side, not an ` +
              `empty category — roughly ${t.estimatedListings} listings behind it are uncaptured.`
            : `Page fetched (${res.body.length} bytes) but no priced listing markup matched.`,
      });
      ctx.log(`  ${t.id}: ${offers.length} offers (${outcome})`);
    }
    return results;
  },
};
