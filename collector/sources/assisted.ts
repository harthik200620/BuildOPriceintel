/**
 * Browser-assisted sources.
 *
 * Amazon.in, Flipkart, Meesho, JioMart, BigBMart, BuildersMART, Moglix and
 * Justdial all refuse a scripted client — 503s, browser challenges, and
 * client-rendered listings. Their data is captured through the in-app browser
 * and written to collector/raw/assisted-<source>-<date>.jsonl in the same
 * RawOffer shape as every other adapter.
 *
 * This adapter re-reads those files so a scheduled run still loads whatever the
 * last assisted pass captured, and — crucially — logs the sources as `assisted`
 * with the date of that capture, so a stale assisted file shows up in the diff
 * log as needing a fresh pass rather than silently ageing into the background.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Adapter, AdapterCtx, RawOffer, SourceResult } from '../types';

const RAW_DIR = path.join(process.cwd(), 'collector', 'raw');

/** Sources known to require a browser, with an honest estimate of their depth. */
export const BROWSER_ONLY: Array<{ id: string; platform: string; klass: 'marketplace' | 'platform' | 'b2b_directory'; est: number; why: string }> = [
  { id: 'amazon', platform: 'Amazon.in', klass: 'marketplace', est: 60, why: 'Returns HTTP 503 to a scripted client.' },
  { id: 'flipkart', platform: 'Flipkart', klass: 'marketplace', est: 50, why: 'Listings and the seller list are rendered client-side.' },
  { id: 'jiomart', platform: 'JioMart', klass: 'marketplace', est: 0, why: 'JioMart has no construction-materials category at all — /cement/6017 returns 404. Removed from the competitive set rather than reported as an empty fetch.' },
  { id: 'meesho', platform: 'Meesho', klass: 'marketplace', est: 15, why: 'Client-rendered; carries almost no construction material.' },
  { id: 'bigbmart', platform: 'BigBMart', klass: 'platform', est: 60, why: 'Serves a "Checking your browser" interstitial to a scripted client.' },
  { id: 'buildersmart', platform: 'BuildersMART', klass: 'platform', est: 90, why: 'Returns HTTP 403 with an Enable-JavaScript body.' },
  { id: 'moglix', platform: 'Moglix', klass: 'platform', est: 40, why: 'JS wall on the catalogue.' },
  { id: 'justdial', platform: 'Justdial', klass: 'b2b_directory', est: 120, why: 'Returns a 30-byte body to a scripted client.' },
];

function readAssisted(category: string, region_id: string): { offers: RawOffer[]; files: string[] } {
  if (!fs.existsSync(RAW_DIR)) return { offers: [], files: [] };
  const files = fs.readdirSync(RAW_DIR).filter((f) => f.startsWith('assisted') && f.endsWith('.jsonl'));
  const offers: RawOffer[] = [];
  const used: string[] = [];
  for (const f of files) {
    let hit = false;
    for (const line of fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as RawOffer;
        if (o.category === category && o.region_id === region_id) { offers.push(o); hit = true; }
      } catch { /* a malformed line is skipped, never guessed at */ }
    }
    if (hit) used.push(f);
  }
  return { offers, files: used };
}

export const assisted: Adapter = {
  id: 'assisted',
  source_class: 'marketplace',
  label: 'Browser-assisted captures (marketplaces and walled platforms)',
  covers: ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'].flatMap((category) =>
    ['hyderabad', 'vijayawada'].map((region_id) => ({ category, region_id })),
  ),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const { offers, files } = readAssisted(category, region_id);
    const results: SourceResult[] = [];

    if (offers.length) {
      const byPlatform = new Map<string, RawOffer[]>();
      for (const o of offers) {
        if (!byPlatform.has(o.platform)) byPlatform.set(o.platform, []);
        byPlatform.get(o.platform)!.push(o);
      }
      for (const [platform, list] of byPlatform) {
        const newest = list.reduce((m, o) => (o.fetched_at > m ? o.fetched_at : m), list[0].fetched_at);
        const ageDays = (Date.now() - new Date(newest).getTime()) / 86_400_000;
        results.push({
          source_id: `assisted:${platform}:${category}:${region_id}`,
          source_class: list[0].source_class, category, region_id,
          url: list[0].source_url, fetch_mode: 'assisted', http_status: null,
          outcome: 'ok', offers: list, pages_fetched: 0, pagination_exhausted: null,
          estimated_missed: null,
          note: `Loaded from a browser-assisted capture (${files.join(', ')}). Captured ${ageDays < 1 ? 'today' : `${Math.round(ageDays)} d ago`}.` +
            (ageDays > 2 ? ' This capture is stale — a fresh assisted pass is needed; the scheduled job cannot refresh it unattended.' : ''),
        });
        ctx.log(`  assisted/${platform}/${category}/${region_id}: ${list.length} offers`);
      }
    }

    // Always record the walled sources, whether or not a capture exists, so the
    // gap is visible in every run's log rather than only the first.
    const covered = new Set(offers.map((o) => o.platform));
    for (const b of BROWSER_ONLY) {
      if (covered.has(b.platform)) continue;
      results.push({
        source_id: `assisted:${b.id}:${category}:${region_id}`,
        source_class: b.klass, category, region_id,
        url: `https://${b.id}`, fetch_mode: 'browser', http_status: null,
        outcome: b.est === 0 ? 'skipped' : 'blocked',
        offers: [], pages_fetched: 0, pagination_exhausted: false,
        estimated_missed: b.est || null,
        note: `${b.platform}: ${b.why}` +
          (b.est ? ` No browser-assisted capture exists for ${category} in ${region_id} this run — roughly ${b.est} listings not captured.` : ''),
      });
    }

    return results;
  },
};
