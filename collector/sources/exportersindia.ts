/**
 * ExportersIndia city-category listings.
 *
 * This source was in the build from the start, inside the shared
 * `parseGeneric` in directories.ts, and it returned **zero offers for every
 * category in both cities for the entire build**. Not because the supply is not
 * there — `exportersindia.com/vijayawada/bricks.htm` serves 503 KB with 108
 * records behind it — but because two independent gates in the generic parser
 * closed on it:
 *
 *   1. The container selector `[class*="product"],[class*="listing"],[class*="card"]`
 *      matches nothing here. The card is `div.clsProDet`.
 *   2. The price regex required a literal `₹`. **The rupee sign on this page is
 *      an `<img>`**, so `$(el).text()` yields "Price: 24 - 28/ Piece" — no
 *      currency character at all. Widening the regex to accept "Rs" would still
 *      have found nothing; the price lives in a `data-tooltip` attribute.
 *
 * It read as absent supply because a 200-OK 500 KB body that parsed to nothing
 * was reported as `empty`, the same label as a genuine 404. This adapter reports
 * `parse_fail` instead, and it can do so honestly because the page publishes its
 * own record count — see `pageMeta`.
 *
 * `parseCards` and `pageMeta` are exported so tests and scripts/parse-fixture.ts
 * can exercise them against collector/fixtures/*.html with no network at all.
 */
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, RawOffer, SourceResult } from '../types';
import { classifyFailure } from '../fetch';
import { paiseFromRupeeText } from '../../lib/money';

const CITY: Record<string, string> = { hyderabad: 'hyderabad', vijayawada: 'vijayawada' };

/**
 * Probed against exportersindia.com on 2026-08-01; the comment is the record
 * count the page itself published for Vijayawada.
 *
 * ExportersIndia pluralises where IndiaMART does not — `red-bricks` works here,
 * `red-brick` is the IndiaMART form — so these are not interchangeable with
 * SEEDS in indiamart.ts and were each confirmed separately.
 *
 * Deliberately absent: `hollow-blocks` and `interlocking-bricks` return HTTP 200
 * with a 36,046-byte stub carrying no cards and no ttl_records — a genuinely
 * empty category on this host, not a parse failure. `fly-ash-bricks` and
 * `aac-blocks` 404. Adding them would spend requests to confirm nothing.
 */
const SLUGS: Record<string, string[]> = {
  bricks_blocks: ['bricks', 'concrete-blocks', 'clay-bricks', 'red-bricks'], // 108 · 39 · 30 · 22
  cement: ['cement'],                                                        // 52
  water_pipes: ['pvc-pipes'],                                                // 95
  tmt_steel: ['tmt-bars'],                                                   // 404 on both cities — see note below
};

/** Cards per page, measured: 108 records / 6 pages = 18. Used only for estimates. */
const PER_PAGE = 18;
const MAX_PAGES = 6;

export interface PageMeta {
  ttlRecords: number | null;
  ttlPages: number | null;
  solrRandNo: string | null;
  pagingUri: string | null;
}

/**
 * The page declares how much it holds. That turns two guesses into measurements:
 * `estimated_missed` becomes real rather than a hardcoded 45, and "we parsed
 * nothing" can be told apart from "there is nothing" without inference.
 */
export function pageMeta(html: string): PageMeta {
  const grab = (k: string) => {
    const m = html.match(new RegExp(`${k}\\s*=\\s*['"]?([^'";\\n]+)`));
    return m ? m[1].trim() : null;
  };
  const n = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : null);
  return {
    ttlRecords: n(grab('ttl_records')),
    ttlPages: n(grab('ttl_pages')),
    solrRandNo: grab('solr_random_no'),
    pagingUri: grab('paging_uri'),
  };
}

/**
 * cheerio decodes entities once, but this source double-encodes: the raw HTML
 * carries `&AMP;quot;` so a single decode leaves `&quot;` sitting in the title.
 * A brick listed as `12X9X6&quot;` would otherwise reach the search index and
 * the card with the entity intact.
 */
function decodeResidual(s: string): string {
  return s
    .replace(/&quot;/gi, '"').replace(/&#0?39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

const PRICE_RE =
  /^Price\s*-\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:-\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s*)?Per\s+(.+)$/i;

/**
 * One RawOffer per DISTINCT listing on the page.
 *
 * The page renders each listing two or three times — 45 card elements for 18
 * listings on the Vijayawada brick page, which is exactly the 108 records / 6
 * pages the page declares. So this merges on source_ref and keeps the richest
 * instance: a duplicate that carries the price tooltip beats one that does not,
 * because whether a given render includes the price is a layout accident and
 * dropping the priced copy would silently lose a real published price.
 */
export function parseCards(
  html: string,
  pageUrl: string,
  category: string,
  region_id: string,
): RawOffer[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const byRef = new Map<string, RawOffer>();

  $('div.clsProDet').each((_, el) => {
    const card = $(el).closest('li');
    const a = card.find('a.prdclk').first();
    const href = a.attr('href') ?? '';
    if (!href) return;

    // The listing id in the detail URL. Never the slug or page number: the same
    // listing surfaces under `bricks` and `clay-bricks` and must collapse to one
    // offer, because offer_id is hash(source_id|source_ref).
    const idm = href.match(/-(\d{6,})\.htm/);
    const source_ref = idm ? `ei:${idm[1]}` : `ei:${href}`;

    const title = decodeResidual(a.attr('title') || a.text());
    if (!title || title.length < 4) return;

    const vendorRaw = card.find('h3._company a.com_nam').first().text().trim();
    // Long names are truncated server-side to "Kadukar Enpro Enterprises Private..".
    // The truncation is deterministic, so vendor_id stays stable; strip the dots
    // rather than inventing the rest of the name.
    const vendor_name = vendorRaw.replace(/\.{2,}$/, '').trim();
    if (!vendor_name) return;

    const tooltip = card.find('div._price[data-tooltip]').first().attr('data-tooltip') ?? null;
    const pm = tooltip ? tooltip.match(PRICE_RE) : null;
    // The low bound. It is a figure the seller printed; a midpoint is not, and
    // this build does not publish a price nobody quoted. The high bound is kept
    // verbatim in specs and the whole tooltip in price_text.
    const price_paise = pm ? paiseFromRupeeText(pm[1]) : null;
    const price_unit = pm ? pm[3].trim() : null;
    const highText = pm?.[2] ?? null;

    const specs: Record<string, string> = {};
    card.find('ul._attriButes li').each((__, li) => {
      const k = $(li).find('.eipdt-lbl').text().trim().replace(/\s*:\s*$/, '');
      const v = $(li).find('.eipdt-val').text().trim();
      if (k && v) specs[k] = decodeResidual(v);
    });
    if (highText) {
      specs['Quoted price range'] = `Rs ${pm![1]} – Rs ${highText} per ${price_unit}`;
    }

    // "Deals in Vijayawada" is a delivery claim, not an address. Recording it as
    // a locality would give a seller a street they never published — and the
    // generic parser it replaces did worse, stamping the city name on every row
    // regardless of what the page said.
    const addr = card.find('span._fAdre').first().text().trim().replace(/\s+/g, ' ');
    const isRealAddress = !!addr && !/^deals\s+in\b/i.test(addr);
    if (!isRealAddress && addr) specs['Seller address basis'] = `${addr} — no postal address published`;

    // MOQ rides in the enquiry-form query string, and falls back to the spec list.
    let moq_text: string | null = null, moq_qty: number | null = null, moq_unit: string | null = null;
    const qstr = card.find('[data-qstr]').first().attr('data-qstr');
    if (qstr) {
      const p = new URLSearchParams(qstr.replace(/&AMP;/gi, '&'));
      const q = p.get('moq'), u = p.get('quantity_unit');
      if (q && /^\d+$/.test(q)) { moq_qty = Number(q); moq_unit = u; moq_text = `${q} ${u ?? ''}`.trim(); }
    }
    if (moq_qty == null) {
      const s = specs['MOQ'] ?? specs['Min. Order Quantity'] ?? null;
      const m = s?.match(/([\d,]+)\s*(.*)/);
      if (m) { moq_text = s; moq_qty = Number(m[1].replace(/,/g, '')); moq_unit = m[2]?.trim() || null; }
    }

    // Filter by PATH, not host: the same host also serves the location pin and
    // the rupee sign as SVGs, and matching on host makes every hero image an icon.
    const images: string[] = [];
    card.find('img[src*="/product_images/"]').each((__, img) => {
      const s = $(img).attr('src');
      if (s) images.push(s);
    });

    const offer: RawOffer = {
      source_id: 'exportersindia',
      source_class: 'b2b_directory',
      fetch_mode: 'http',
      source_url: href,
      source_ref,
      fetched_at: now,
      region_id,
      category,
      platform: 'ExportersIndia',
      title,
      brand: specs['Brand Name'] ?? specs['Brand'] ?? null,
      vendor_name,
      vendor_locality: isRealAddress ? addr.split(',')[0].trim() : null,
      vendor_city: isRealAddress ? (addr.split(',')[1]?.trim() ?? null) : null,
      vendor_profile_url: card.find('h3._company a.com_nam').first().attr('href') ?? null,
      // ExportersIndia publishes "Verified" and a tenure in years. Neither is a
      // rating, and putting tenure in a rating field would invent a score.
      vendor_rating: null,
      vendor_review_count: null,
      seller_type: 'dealer',
      price_text: tooltip ?? 'price not published',
      price_paise,
      price_unit,
      gst_treatment: 'EXCL',
      gst_note: 'B2B directory listing; treated as ex-GST, the convention on these platforms.',
      moq_text, moq_qty, moq_unit,
      stock_state: price_paise != null ? 'unknown' : 'on_request',
      specs,
      images: images.slice(0, 6),
      cert_text: /isi|bis|is\s?\d{3,}/i.test(JSON.stringify(specs)) ? JSON.stringify(specs) : null,
    };

    const prev = byRef.get(source_ref);
    if (!prev || (prev.price_paise == null && offer.price_paise != null)) byRef.set(source_ref, offer);
  });

  return [...byRef.values()];
}

export const exportersindia: Adapter = {
  id: 'exportersindia',
  source_class: 'b2b_directory',
  label: 'ExportersIndia city directory',
  covers: Object.keys(SLUGS).flatMap((category) =>
    Object.keys(CITY).map((region_id) => ({ category, region_id })),
  ),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const city = CITY[region_id];
    const results: SourceResult[] = [];
    // Scoped to this (category, region) run so the same listing appearing under
    // `bricks` and `clay-bricks` is loaded once.
    const seenRefs = new Set<string>();

    for (const slug of SLUGS[category] ?? []) {
      const base = `https://www.exportersindia.com/${city}/${slug}.htm`;
      const offers: RawOffer[] = [];
      let pagesFetched = 0;
      let lastStatus = 0;
      let meta: PageMeta = { ttlRecords: null, ttlPages: null, solrRandNo: null, pagingUri: null };
      let firstOutcome: SourceResult['outcome'] | null = null;
      let throttled = false;

      const maxPages = ctx.pass === 1 ? 3 : MAX_PAGES;

      for (let page = 1; page <= maxPages; page++) {
        const url =
          page === 1
            ? base
            : `${meta.pagingUri ?? base}?action=ajax_load_classified` +
              `&solr_rand_no=${meta.solrRandNo ?? ''}&catg_page=${page}`;

        const res = await ctx.fetchText(url);
        lastStatus = res.status;

        if (!res.ok) {
          if (page === 1) firstOutcome = classifyFailure(res.status, res.body);
          if (res.status === 429) {
            throttled = true;
            ctx.log(`  exportersindia: 429 on ${slug} — host gap widened to ${res.throttledTo ?? '?'} ms`);
          }
          break;
        }
        pagesFetched++;
        if (page === 1) meta = pageMeta(res.body);

        const cards = parseCards(res.body, url, category, region_id);
        const fresh = cards.filter((c) => !seenRefs.has(c.source_ref));
        for (const c of fresh) seenRefs.add(c.source_ref);
        offers.push(...fresh);

        // Nothing new on this page means pagination is done, not that a quota hit.
        if (!fresh.length) break;
        if (meta.ttlPages != null && page >= meta.ttlPages) break;
      }

      const declared = meta.ttlRecords;
      const exhausted =
        meta.ttlPages != null ? pagesFetched >= meta.ttlPages : pagesFetched < maxPages;
      // The page tells us how many records it holds, so what we did not reach is
      // arithmetic rather than a guess.
      const missed = throttled
        ? (declared != null ? Math.max(0, declared - offers.length) : PER_PAGE * (maxPages - pagesFetched))
        : declared != null
          ? Math.max(0, declared - offers.length)
          : null;

      results.push({
        source_id: `exportersindia:${city}:${slug}`,
        source_class: 'b2b_directory',
        category, region_id, url: base,
        fetch_mode: 'http', http_status: lastStatus,
        outcome: throttled
          ? 'rate_limited'
          : offers.length
            ? 'ok'
            // The discriminator this source makes possible: a page that declares
            // records but yields none is a broken parser, not an empty market.
            : firstOutcome ?? (declared && declared > 0 ? 'parse_fail' : 'empty'),
        offers,
        pages_fetched: pagesFetched,
        pagination_exhausted: exhausted,
        estimated_missed: missed,
        note: throttled
          ? `ExportersIndia returned HTTP 429 partway through this slug; roughly ${missed} of its ${declared ?? '?'} declared records were not captured on this run.`
          : !offers.length && declared && declared > 0
            ? `Page returned HTTP ${lastStatus} with ${declared} declared records and no card matched the parser — a parse failure, not an empty category.`
            : missed && missed > 0
              ? `Stopped at the ${maxPages}-page cap for this pass; the page declares ${declared} records and ${offers.length} distinct listings were captured.`
              : null,
      });

      ctx.log(`  exportersindia/${city}/${slug}: ${offers.length} new (${pagesFetched}p of ${meta.ttlPages ?? '?'}, ${declared ?? '?'} declared)`);
    }

    return results;
  },
};
