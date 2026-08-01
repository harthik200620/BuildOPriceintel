/**
 * Regional construction-materials platforms.
 *
 * These are the Telugu-state players that carry real ₹ prices: BigBMart and
 * BuildersMART (Hyderabad), ConstructionKart (Telangana), Moglix, Infra.Market.
 *
 * Reality check, measured rather than assumed: at the time of this build every
 * one of them serves a browser challenge or a JS wall to a scripted client.
 * BigBMart returns "Checking your browser before accessing"; BuildersMART
 * returns 403 with an Enable-JavaScript body; Moglix and Infra.Market serve a
 * JS wall. Rather than pretend these are covered, each attempt is made, the
 * real outcome is recorded, and an estimate of the volume missed goes into the
 * collection log. Their data reaches the store through the browser-assisted
 * path (see sources/assisted.ts) instead.
 */
import * as cheerio from 'cheerio';
import type { Adapter, AdapterCtx, RawOffer, SourceResult } from '../types';
import { classifyFailure } from '../fetch';

interface Target {
  id: string; label: string; url: string; category: string; region_id: string;
  platform: string; estimatedListings: number;
}

/**
 * BigBMart is deliberately NOT listed here. It serves a browser challenge to a
 * scripted client intermittently — sometimes 200, sometimes an interstitial —
 * and when it did answer, this adapter produced a second copy of every listing
 * under a different source_ref from the browser capture, duplicating the whole
 * platform. It is collected once, completely, through the browser-assisted path
 * (all four categories, every page) and the assisted adapter owns it.
 */
const TARGETS: Target[] = [
  { id: 'buildersmart:cement', label: 'BuildersMART', platform: 'BuildersMART', category: 'cement', region_id: 'hyderabad', url: 'https://www.buildersmart.in/cement', estimatedListings: 50 },
  { id: 'buildersmart:steel', label: 'BuildersMART', platform: 'BuildersMART', category: 'tmt_steel', region_id: 'hyderabad', url: 'https://www.buildersmart.in/tmt-steel', estimatedListings: 40 },
  { id: 'constructionkart:cement', label: 'ConstructionKart', platform: 'ConstructionKart', category: 'cement', region_id: 'hyderabad', url: 'https://constructionkart.com/product-category/cement/', estimatedListings: 15 },
];

/** WooCommerce-shaped listing parse — the shape most of these platforms use. */
function parseWoo(html: string, t: Target): RawOffer[] {
  const $ = cheerio.load(html);
  const now = new Date().toISOString();
  const out: RawOffer[] = [];

  $('li.product, .product.type-product, .woocommerce-loop-product__link').each((_, el) => {
    const $el = $(el).closest('li.product, .product');
    const title = $el.find('.woocommerce-loop-product__title, h2, h3').first().text().trim();
    if (!title) return;
    const priceTxt = $el.find('.price ins .amount, .price > .amount, .woocommerce-Price-amount').last().text().trim();
    const rupees = Number(priceTxt.replace(/[^\d.]/g, ''));
    if (!rupees) return;
    const href = $el.find('a').first().attr('href') ?? t.url;

    out.push({
      source_id: t.id, source_class: 'platform', fetch_mode: 'http',
      source_url: href, source_ref: `${t.platform}:${href.split('/').filter(Boolean).pop()}`,
      fetched_at: now, region_id: t.region_id, category: t.category, platform: t.platform,
      title,
      vendor_name: t.platform,
      vendor_locality: 'Hyderabad', vendor_city: 'Hyderabad',
      seller_type: 'platform',
      price_text: priceTxt,
      price_paise: Math.round(rupees * 100),
      price_unit: t.category === 'cement' ? 'Bag' : t.category === 'tmt_steel' ? 'Kg' : 'Piece',
      // Retail platforms in this market quote MRP-style tax-inclusive figures.
      gst_treatment: 'INCL',
      gst_note: 'Retail platform listing; price displayed to a consumer is treated as GST-inclusive.',
      stock_state: 'unknown',
      specs: {},
      images: [$el.find('img').first().attr('src') ?? ''].filter(Boolean),
    });
  });
  return out;
}

export const regionalPlatforms: Adapter = {
  id: 'regional-platforms',
  source_class: 'platform',
  label: 'Regional construction-materials platforms',
  covers: TARGETS.map((t) => ({ category: t.category, region_id: t.region_id })),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const mine = TARGETS.filter((t) => t.category === category && t.region_id === region_id);
    const results: SourceResult[] = [];

    for (const t of mine) {
      const res = await ctx.fetchText(t.url);
      const challenged = /checking your browser|just a moment|enable javascript|cf-browser-verification/i
        .test(res.body.slice(0, 4000));

      if (!res.ok || challenged) {
        const outcome = challenged ? 'blocked' : classifyFailure(res.status, res.body);
        results.push({
          source_id: t.id, source_class: 'platform', category, region_id, url: t.url,
          fetch_mode: 'http', http_status: res.status, outcome,
          offers: [], pages_fetched: challenged ? 1 : 0, pagination_exhausted: false,
          estimated_missed: t.estimatedListings,
          note: challenged
            ? `${t.label} served a browser challenge ("Checking your browser…") to the scripted client. Roughly ${t.estimatedListings} listings behind it were not captured on this path; they are collected through the browser-assisted path instead.`
            : `${t.label} returned HTTP ${res.status}. Approximately ${t.estimatedListings} listings not captured.`,
        });
        ctx.log(`  ${t.id}: ${outcome} (est. ${t.estimatedListings} listings missed)`);
        continue;
      }

      const offers = parseWoo(res.body, t);
      results.push({
        source_id: t.id, source_class: 'platform', category, region_id, url: t.url,
        fetch_mode: 'http', http_status: res.status,
        outcome: offers.length ? 'ok' : 'empty',
        offers, pages_fetched: 1, pagination_exhausted: true,
        estimated_missed: offers.length ? null : t.estimatedListings,
        note: offers.length ? null : `Page fetched but no listing markup matched — layout may have changed.`,
      });
      ctx.log(`  ${t.id}: ${offers.length} offers`);
    }
    return results;
  },
};
