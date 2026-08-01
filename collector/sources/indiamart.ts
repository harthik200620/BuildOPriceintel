/**
 * IndiaMART city directory.
 *
 * The richest vein for Hyderabad and Vijayawada by a wide margin: this is where
 * the long tail of local dealers actually lists, with a name, a locality, a
 * price, a unit and an MOQ. One page returns ~28 named sellers.
 *
 * Two things make this adapter exhaustive rather than a sample:
 *   1. Pagination via ?page=N, followed until a page yields no listing we have
 *      not already seen.
 *   2. A crawl frontier — every directory page embeds ~43 related-category
 *      links, so seeding a handful of slugs and following the on-topic ones
 *      discovers the rest of the category rather than guessing URL slugs.
 *
 * Two card layouts exist (list `li.pCard1` and grid `.template7-product-card`)
 * and both are parsed, because which one a URL serves is not stable.
 */
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, RawOffer, SourceResult } from '../types';
import { classifyFailure } from '../fetch';

const CITY_SLUG: Record<string, string> = {
  hyderabad: 'hyderabad',
  vijayawada: 'vijayawada',
};

/** Seeds. The frontier expands these; they are a starting point, not the list. */
const SEEDS: Record<string, string[]> = {
  cement: [
    'ultratech-cement', 'cement', 'acc-cement', 'ppc-cement', 'opc-cement',
    'portland-cement', 'ambuja-cement', 'dalmia-cement', 'ramco-cement',
    'penna-cement', 'white-cement', 'jsw-cement', 'bharathi-cement',
  ],
  tmt_steel: [
    'tmt-bar', 'tmt-steel-bars', 'tmt-bars', 'steel-tmt-bar', 'iron-rods',
    'tata-tmt-bar', 'jsw-tmt-bar', 'sail-tmt-bar', 'vizag-tmt-bar',
    'fe-500-tmt-bar', 'reinforcement-steel', 'kamdhenu-tmt-bar',
  ],
  water_pipes: [
    'cpvc-pipe', 'upvc-pipe', 'pvc-pipe', 'swr-pipe', 'gi-pipe', 'hdpe-pipe',
    'astral-pipe', 'supreme-pipe', 'finolex-pipe', 'ashirvad-pipe',
    'prince-pipe', 'water-pipe', 'plumbing-pipe', 'drainage-pipe',
  ],
  // Probed against dir.indiamart.com before being listed. The old set was mostly
  // guesses at plural forms and nine of its twelve seeds returned 404 —
  // `aac-block`, `aac-blocks`, `red-bricks`, `clay-bricks`, `concrete-block`,
  // `building-bricks`, `solid-concrete-blocks`, `cement-bricks` and
  // `clc-blocks`. So bricks read as a blocked category when it was really a
  // mistyped one, and the crawl frontier could not rescue it: a brick directory
  // page links to almost no sibling brick categories.
  //
  // Every slug below returned HTTP 200 with priced listings on 2026-08-01;
  // the comment is the count seen on that probe. AAC has no working slug of its
  // own on this host — AAC blocks surface inside `concrete-blocks` and
  // `bricks`, and the category guard sorts out what does not belong.
  bricks_blocks: [
    'bricks',              // 167 priced listings
    'red-brick',           // 153  — singular, not "red-bricks"
    'concrete-blocks',     // 147  — plural, not "concrete-block"
    'fly-ash-bricks',      // 138
    'interlocking-bricks', //  67
    'hollow-blocks',       //  56
  ],
};

/** Keeps the frontier on-topic. A cement page links to concrete mixers too. */
const INCLUDE: Record<string, RegExp> = {
  cement: /cement|portland|pozzolana|clinker/,
  tmt_steel: /tmt|steel-bar|steel-rod|iron-rod|iron-bar|rebar|reinforc|sariya|binding-wire/,
  water_pipes: /pipe|cpvc|upvc|pvc|swr|hdpe|plumbing/,
  bricks_blocks: /brick|block|aac|clc|masonry|paver/,
};

/**
 * Water pipes is the plumbing branch only — electrical conduit is a separate
 * L1 branch that shares the word "pipe" and almost none of the filters.
 */
const EXCLUDE: Record<string, RegExp> = {
  cement: /machine|mixer|plant|silo|bag-making|paint|adhesive|tile-adhesive|sheet|pipe|block|brick|testing|admixture/,
  tmt_steel: /machine|scrap|furniture|utensil|wire-mesh|nail|welding|cutting|almirah|pipe|tube|sheet|plate|angle|channel/,
  water_pipes: /conduit|electric|cable|wire|casing|column-pipe|duct|machine|making|extruder|mould|scrap|fitting-machine/,
  bricks_blocks: /machine|making|mould|plant|mixer|kiln-machine|hollow-brick-machine|paver-machine|adhesive/,
};

const num = (s: string | undefined | null): number | null => {
  if (!s) return null;
  const m = s.replace(/[, ]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function parseMoq(t: string): { qty: number | null; unit: string | null } {
  const m = t.match(/([\d,.]+)\s*([A-Za-z%]+)?/);
  if (!m) return { qty: null, unit: null };
  return { qty: num(m[1]), unit: m[2] ?? null };
}

function parseCards(html: string, url: string, category: string, region_id: string): RawOffer[] {
  const $ = cheerio.load(html);
  const out: RawOffer[] = [];
  const now = new Date().toISOString();

  $('a.prdtitle').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') ?? '';
    const title = $a.text().trim();
    if (!title) return;

    // Walk up to whichever card container this layout uses.
    const $card = $a.closest('li.pCard1, .template7-product-card, article, li');
    if (!$card.length) return;

    const priceText = $card.find('span.prc').first().text().trim();
    const unitText = $card.find('span.prcut').first().text().trim();
    // No price published is a real, common state. It is captured verbatim and
    // counted in the log; it never becomes an invented number.
    const rupees = num(priceText);

    const specs: Record<string, string> = {};
    $card.find('dl.isq-dl').each((__, dl) => {
      const dts = $(dl).find('dt');
      const dds = $(dl).find('dd');
      dts.each((i, dt) => {
        const k = $(dt).text().trim();
        const v = $(dds[i]).text().trim();
        if (k && v) specs[k] = v;
      });
    });

    const vendorName =
      $card.find('a.cncf1').first().text().trim() ||
      $card.find('.companyname, .cmpnyName').first().text().trim() ||
      $card.find('aside a[target="_blank"]').first().text().trim();
    if (!vendorName) return;

    const locality = $card.find('[itemProp="addressLocality"]').first().text().trim() || null;

    // Rating markup is "3.6 (73)".
    const ratingBlock = $card.find('.dag5').first().text().trim();
    const rm = ratingBlock.match(/([\d.]+)\s*\((\d+)\)/);

    const moqText = $card.find('.moq, .prdMOQ').first().text().trim() || null;
    const moq = moqText ? parseMoq(moqText) : { qty: null, unit: null };

    const images: string[] = [];
    $card.find('img').each((__, img) => {
      const s = $(img).attr('src');
      if (s && /imimg\.com/.test(s)) images.push(s);
    });

    const idm = href.match(/(\d{6,})\.html/);
    const source_ref = idm ? `im:${idm[1]}` : `im:${href}`;

    out.push({
      source_id: 'indiamart',
      source_class: 'b2b_directory',
      fetch_mode: 'http',
      source_url: href || url,
      source_ref,
      fetched_at: now,
      region_id,
      category,
      platform: 'IndiaMART',
      title,
      brand: specs['Brand'] ?? specs['Brand Name'] ?? null,
      vendor_name: vendorName,
      vendor_locality: locality,
      vendor_city: region_id === 'hyderabad' ? 'Hyderabad' : 'Vijayawada',
      vendor_profile_url: $card.find('a.cncf1').first().attr('href') ?? null,
      vendor_rating: rm ? Number(rm[1]) : null,
      vendor_review_count: rm ? Number(rm[2]) : null,
      seller_type: 'dealer',
      price_text: priceText ? `${priceText} /${unitText}` : 'price not published',
      price_paise: rupees != null ? Math.round(rupees * 100) : null,
      price_unit: unitText.replace(/^\/?\s*/, '') || null,
      // IndiaMART B2B listings are quoted ex-GST by convention and the PDP says
      // "Excluding all taxes"; the city and category pages say nothing at all.
      gst_treatment: 'EXCL',
      gst_note: 'IndiaMART product pages state "Excluding all taxes"; directory pages state no basis. Treated as ex-GST.',
      moq_text: moqText,
      moq_qty: moq.qty,
      moq_unit: moq.unit,
      stock_state: rupees != null ? 'unknown' : 'on_request',
      specs,
      images: images.slice(0, 6),
      cert_text: /isi|bis|is\s?\d{3,}/i.test(JSON.stringify(specs)) ? JSON.stringify(specs) : null,
    });
  });

  return out;
}

function frontierLinks(html: string, city: string, category: string): string[] {
  const inc = INCLUDE[category];
  const exc = EXCLUDE[category];
  const found = new Set<string>();
  for (const m of html.matchAll(new RegExp(`href="/${city}/([a-z0-9\\-]+)\\.html"`, 'g'))) {
    const slug = m[1];
    if (inc.test(slug) && !exc.test(slug)) found.add(slug);
  }
  return [...found];
}

export const indiamart: Adapter = {
  id: 'indiamart',
  source_class: 'b2b_directory',
  label: 'IndiaMART city directory',
  covers: Object.keys(SEEDS).flatMap((category) =>
    Object.keys(CITY_SLUG).map((region_id) => ({ category, region_id })),
  ),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const city = CITY_SLUG[region_id];
    const results: SourceResult[] = [];
    const seenRefs = new Set<string>();

    // Frontier widens on later passes; pass 1 stays on the seeds plus whatever
    // they link to, which is already the bulk of the category. These caps are
    // real bounds on the work and every slug left unvisited is reported at the
    // end of this function with an estimate of the supply behind it.
    const maxSlugs = ctx.pass === 1 ? 18 : 34;
    const maxPages = 4;

    const queue = [...SEEDS[category]];
    const visited = new Set<string>();

    while (queue.length && visited.size < maxSlugs) {
      const slug = queue.shift()!;
      if (visited.has(slug)) continue;
      visited.add(slug);

      let pagesFetched = 0;
      let paginationExhausted = false;
      let throttled = false;
      const offers: RawOffer[] = [];
      let lastStatus = 0;
      let firstOutcome: SourceResult['outcome'] = 'ok';

      for (let page = 1; page <= maxPages; page++) {
        const url =
          page === 1
            ? `https://dir.indiamart.com/${city}/${slug}.html`
            : `https://dir.indiamart.com/${city}/${slug}.html?page=${page}`;
        const res = await ctx.fetchText(url);
        lastStatus = res.status;

        if (!res.ok) {
          if (page === 1) firstOutcome = res.status === 404 ? 'empty' : classifyFailure(res.status, res.body);
          if (res.status === 429) {
            throttled = true;
            ctx.log(`  indiamart: 429 on ${slug} — host gap widened to ${res.throttledTo ?? '?'} ms`);
          }
          break;
        }
        pagesFetched++;

        if (page === 1) {
          for (const s of frontierLinks(res.body, city, category)) {
            if (!visited.has(s) && !queue.includes(s)) queue.push(s);
          }
        }

        const cards = parseCards(res.body, url, category, region_id);
        const fresh = cards.filter((c) => !seenRefs.has(c.source_ref));
        for (const c of fresh) seenRefs.add(c.source_ref);
        offers.push(...fresh);

        // Stop when a page adds nothing new — that is pagination exhausted,
        // not a quota.
        if (fresh.length === 0) {
          paginationExhausted = true;
          break;
        }
        if (page === maxPages) paginationExhausted = false;
      }

      results.push({
        source_id: `indiamart:${city}:${slug}`,
        source_class: 'b2b_directory',
        category,
        region_id,
        url: `https://dir.indiamart.com/${city}/${slug}.html`,
        fetch_mode: 'http',
        http_status: lastStatus,
        outcome: throttled ? 'rate_limited' : offers.length ? 'ok' : firstOutcome === 'ok' ? 'empty' : firstOutcome,
        offers,
        pages_fetched: pagesFetched,
        pagination_exhausted: paginationExhausted,
        estimated_missed: throttled
          ? 28 * (maxPages - pagesFetched)
          : !paginationExhausted && pagesFetched >= maxPages
            ? 28 * 2 // roughly two more pages' worth, at ~28 cards per page
            : null,
        note: throttled
          ? `IndiaMART returned HTTP 429 partway through this slug. The client backed off and widened its per-host gap; roughly ${28 * (maxPages - pagesFetched)} listings behind the remaining pages were not captured on this run.`
          : !paginationExhausted && pagesFetched >= maxPages
            ? `Stopped at the ${maxPages}-page cap while pages were still returning new listings — more supply exists behind this slug.`
            : null,
      });

      ctx.log(`  indiamart/${city}/${slug}: ${offers.length} new (${pagesFetched}p)`);
    }

    if (queue.length) {
      results.push({
        source_id: `indiamart:${city}:frontier-remainder`,
        source_class: 'b2b_directory',
        category, region_id,
        url: `https://dir.indiamart.com/${city}/`,
        fetch_mode: 'http', http_status: null,
        outcome: 'skipped', offers: [], pages_fetched: 0, pagination_exhausted: false,
        estimated_missed: queue.length * 25,
        note: `${queue.length} on-topic category slugs discovered by the crawl frontier were not visited under the ${maxSlugs}-slug cap for this pass: ${queue.slice(0, 12).join(', ')}${queue.length > 12 ? ' …' : ''}`,
      });
    }

    return results;
  },
};
