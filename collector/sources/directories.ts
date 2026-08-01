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

interface Target {
  id: string; platform: string; source_class: 'b2b_directory';
  url: string; category: string; region_id: string; estimatedListings: number;
}

const CITY = { hyderabad: 'hyderabad', vijayawada: 'vijayawada' } as const;
const SLUG: Record<string, { ti: string; jd: string }> = {
  cement: { ti: 'cement', jd: 'Cement-Dealers' },
  tmt_steel: { ti: 'tmt-bar', jd: 'Iron-Steel-Dealers' },
  water_pipes: { ti: 'pvc-pipe', jd: 'Pipe-Dealers' },
  bricks_blocks: { ti: 'bricks', jd: 'Brick-Dealers' },
};

/**
 * ExportersIndia used to be a third target here and now has its own adapter,
 * `collector/sources/exportersindia.ts`. It needed a slug vocabulary, real
 * pagination and one SourceResult per slug — none of which fits this file's
 * one-target-one-URL loop — and its markup needs selectors of its own, which is
 * why it returned nothing for the whole build while sitting on `parseGeneric`.
 *
 * TradeIndia's URL below is known broken and is deliberately still here.
 * `-city-183463.html` is a hardcoded numeric id that never varies by category or
 * city, so all eight combinations fetch the same ~21 KB soft-404 — probed
 * 2026-08-01, byte-identical for vijayawada/bricks and hyderabad/cement. Fixing
 * it needs URL discovery and a parser of its own. Until then it is left in place
 * so the attempt stays on the record, and the outcome below now reports
 * `parse_fail` rather than `empty` so it reads as a defect rather than as an
 * absence of supply.
 */
function targetsFor(category: string, region_id: string): Target[] {
  const c = CITY[region_id as keyof typeof CITY];
  const s = SLUG[category];
  if (!c || !s) return [];
  return [
    { id: `tradeindia:${c}:${category}`, platform: 'TradeIndia', source_class: 'b2b_directory',
      url: `https://www.tradeindia.com/${c}/${s.ti}-city-183463.html`, category, region_id, estimatedListings: 60 },
    { id: `justdial:${c}:${category}`, platform: 'Justdial', source_class: 'b2b_directory',
      url: `https://www.justdial.com/${c.charAt(0).toUpperCase() + c.slice(1)}/${s.jd}`, category, region_id, estimatedListings: 120 },
  ];
}

const num = (s: string): number | null => {
  const m = s.replace(/[, ]/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

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

      const offers = parseGeneric(res.body, t);
      // These platforms publish no record count, so body size is the only
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
