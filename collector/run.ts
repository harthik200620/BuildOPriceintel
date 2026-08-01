/**
 * The collector.
 *
 * Sweeps every registered adapter across every (category, region) pair and
 * keeps going until two consecutive full passes surface no new vendor and no
 * new offer — collect until dry, not until a quota.
 *
 * Three rules held here rather than hoped for:
 *   - No silent caps. Every block, rate-limit, truncated pagination and
 *     unvisited frontier slug becomes a source_log row with an honest estimate
 *     of the volume missed, and appears in data/logs/collection-<date>.md.
 *   - Never fabricate an offer. A listing with no published price is counted
 *     and logged; it never acquires a number.
 *   - The load is transactional. price_current is rebuilt inside one
 *     transaction, so the app never reads a half-written state.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, initSchema, prep, tx, dbExists } from '../lib/db';
import { rebuildPrices, rebuildSearchIndex } from '../lib/rebuild';
import { resolveGstRate, gstKeyFor, GST_RATES } from '../lib/gst';
import { fetchText } from './fetch';
import { normalise, moqFromSpecs } from './normalize';
import type { Adapter, RawOffer, SourceResult } from './types';
import { CATEGORIES } from '../lib/types';

import { indiamart } from './sources/indiamart';
import { regionalPlatforms } from './sources/platforms';
import { tgpred } from './sources/tgpred';
import { tradeDirectories } from './sources/directories';
import { exportersindia } from './sources/exportersindia';
import { assisted } from './sources/assisted';

const ADAPTERS: Adapter[] = [indiamart, exportersindia, regionalPlatforms, tradeDirectories, tgpred, assisted];

const ROOT = process.cwd();
const ALL_REGIONS = ['hyderabad', 'vijayawada'];
const today = () => new Date().toISOString().slice(0, 10);

const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'scheduled') as
  'seed' | 'scheduled' | 'manual';
const ONLY_CATEGORY = process.argv.find((a) => a.startsWith('--category='))?.split('=')[1];
const MAX_PASSES = Number(process.argv.find((a) => a.startsWith('--passes='))?.split('=')[1] ?? 3);

/**
 * `--region=vijayawada` exists because the per-host budget is spent in the
 * order the loop walks it. Hyderabad is listed first and has far more supply,
 * so on a category with a lot of Hyderabad stock it consumes the whole window
 * and every Vijayawada seed then meets a 429 — which reads as "Vijayawada has
 * no supply" when it means "we never got to ask". This scopes a re-run to the
 * starved region so it is first in line rather than last.
 *
 * What it does NOT do is reset the budget. IndiaMART throttles on wall-clock
 * per host, so a new process inherits whatever window the previous run left
 * behind: re-running immediately after a sweep takes a 429 on the first seed
 * regardless of scope. This flag is only useful once the limit has cleared —
 * `scripts/collect-missing-when-clear.sh` is what decides that it has.
 */
const ONLY_REGION = process.argv.find((a) => a.startsWith('--region='))?.split('=')[1];
const REGIONS = ONLY_REGION ? ALL_REGIONS.filter((r) => r === ONLY_REGION) : ALL_REGIONS;
if (ONLY_REGION && !REGIONS.length) {
  console.error(`--region=${ONLY_REGION} is not one of: ${ALL_REGIONS.join(', ')}`);
  process.exit(2);
}

const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const log = (m: string) => console.log(m);

// ── geocoding vendors from their published locality ──────────────────────────

let localityIndex: Array<{ locality: string; lat: number; lon: number; region_id: string }> = [];
export function loadLocalities() {
  localityIndex = prep(`SELECT locality, lat, lon, region_id FROM pincode WHERE confidence='quoted'`).all() as any[];
}

function geocodeVendor(locality: string | null, region_id: string): { lat: number; lon: number; confidence: string } | null {
  if (!locality) return null;
  const clean = locality.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const pool = localityIndex.filter((l) => l.region_id === region_id);
  // Exact locality name first, then a contains match. No fuzzy guessing —
  // an unresolved vendor gets the seeded fallback, which is honest, rather
  // than a confident wrong coordinate.
  for (const l of pool) if (l.locality.toLowerCase() === clean) return { ...l, confidence: 'derived' };
  for (const l of pool) {
    const ll = l.locality.toLowerCase();
    if (ll.length >= 5 && (clean.includes(ll) || ll.includes(clean))) return { ...l, confidence: 'derived' };
  }
  return null;
}

// ── raw archive ──────────────────────────────────────────────────────────────

function writeRaw(sourceId: string, offers: RawOffer[]) {
  if (!offers.length) return;
  // Rows that CAME from a browser-assisted capture must not be written back as
  // a new raw file: the assisted adapter reads every assisted-*.jsonl, so
  // re-archiving its own input creates a feedback loop that double-counts the
  // same listings on the next run.
  if (offers[0].fetch_mode === 'assisted' || offers[0].fetch_mode === 'browser') return;
  const dir = path.join(ROOT, 'collector', 'raw');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sourceId.replace(/[^a-z0-9]+/gi, '_')}-${today()}.jsonl`);
  fs.appendFileSync(file, offers.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8');
}

// ── load ─────────────────────────────────────────────────────────────────────

interface LoadStats {
  offersNew: number; offersSeen: number; vendorsNew: number; skipped: Record<string, number>;
  ladder: { quoted: number; derived: number; typical: number; unknown: number };
  noPrice: number;
}

export function loadOffers(runId: string, raws: RawOffer[]): LoadStats {
  const st: LoadStats = {
    offersNew: 0, offersSeen: 0, vendorsNew: 0, skipped: {},
    ladder: { quoted: 0, derived: 0, typical: 0, unknown: 0 }, noPrice: 0,
  };
  const now = new Date().toISOString();

  const upVendor = db().prepare(
    `INSERT INTO vendor (vendor_id,name,platform,seller_type,locality,city,region_id,lat,lon,
       geo_confidence,rating,review_count,profile_url,free_delivery_threshold_paise,first_seen,last_seen)
     VALUES (@vendor_id,@name,@platform,@seller_type,@locality,@city,@region_id,@lat,@lon,
       @geo_confidence,@rating,@review_count,@profile_url,NULL,@now,@now)
     ON CONFLICT(vendor_id) DO UPDATE SET last_seen=@now,
       rating=COALESCE(excluded.rating,vendor.rating),
       review_count=COALESCE(excluded.review_count,vendor.review_count),
       lat=COALESCE(excluded.lat,vendor.lat), lon=COALESCE(excluded.lon,vendor.lon)`,
  );
  const upProduct = db().prepare(
    `INSERT INTO product (product_id,item_code,category,category_path,title,brand,model,attrs,
       unit_canonical,unit_trade,pack_size,pack_unit,unit_weight_kg,unit_volume_m3,hsn,gst_rate_bp,
       qco_regulated,qco_citation,cert_standards,country_of_origin,volatility_class,image_url,
       datasheet_url,search_blob,created_at,updated_at)
     VALUES (@product_id,@item_code,@category,@category_path,@title,@brand,NULL,@attrs,
       @unit_canonical,@unit_trade,@pack_size,@pack_unit,@unit_weight_kg,@unit_volume_m3,@hsn,@gst_rate_bp,
       @qco_regulated,@qco_citation,@cert_standards,@country_of_origin,@volatility_class,@image_url,
       NULL,'',@now,@now)
     ON CONFLICT(product_id) DO UPDATE SET updated_at=@now,
       image_url=COALESCE(product.image_url,excluded.image_url),
       unit_weight_kg=COALESCE(excluded.unit_weight_kg,product.unit_weight_kg)`,
  );
  const upOffer = db().prepare(
    `INSERT INTO offer (offer_id,product_id,vendor_id,region_id,platform,source_id,source_url,source_ref,
       listing_title,
       base_paise,base_unit,base_qty,base_paise_canonical,trade_multiple,gst_treatment,gst_rate_bp,hsn,
       mrp_paise,delivery_scope,moq_qty,moq_unit,bulk_slabs,stock_state,lead_time_days,cert_state,
       cert_ref,cert_valid_to,rating,review_count,images,datasheet_url,fetched_at,collection_run_id,is_active)
     VALUES (@offer_id,@product_id,@vendor_id,@region_id,@platform,@source_id,@source_url,@source_ref,
       @listing_title,
       @base_paise,@base_unit,1,@base_paise_canonical,@trade_multiple,@gst_treatment,@gst_rate_bp,@hsn,
       @mrp_paise,@delivery_scope,@moq_qty,@moq_unit,@bulk_slabs,@stock_state,@lead_time_days,@cert_state,
       @cert_ref,NULL,@rating,@review_count,@images,@datasheet_url,@fetched_at,@run,1)
     ON CONFLICT(offer_id) DO UPDATE SET
       base_paise=excluded.base_paise, base_paise_canonical=excluded.base_paise_canonical,
       listing_title=excluded.listing_title,
       stock_state=excluded.stock_state, fetched_at=excluded.fetched_at,
       collection_run_id=excluded.collection_run_id, is_active=1`,
  );
  const upSpec = db().prepare(
    `INSERT INTO spec_value (product_id,offer_id,field,label,value,unit,source_url,fetched_at,confidence,derivation)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(product_id,offer_id,field) DO UPDATE SET
       value=excluded.value, confidence=excluded.confidence, fetched_at=excluded.fetched_at,
       derivation=excluded.derivation, source_url=excluded.source_url`,
  );
  const existsOffer = db().prepare(`SELECT 1 FROM offer WHERE offer_id=?`);
  const existsVendor = db().prepare(`SELECT 1 FROM vendor WHERE vendor_id=?`);

  tx(() => {
    for (const raw of raws) {
      if (raw.price_paise == null) { st.noPrice++; continue; }
      const n = normalise(raw);
      if (!('ok' in n) || n.ok !== true) {
        const reason = (n as any).reason ?? 'unknown';
        st.skipped[reason] = (st.skipped[reason] ?? 0) + 1;
        continue;
      }

      const vendor_id = `v_${hash(`${raw.platform}|${raw.vendor_name}|${raw.vendor_locality ?? ''}`)}`;
      const geo = geocodeVendor(raw.vendor_locality ?? raw.vendor_city ?? null, raw.region_id);
      if (!existsVendor.get(vendor_id)) st.vendorsNew++;
      upVendor.run({
        vendor_id, name: raw.vendor_name, platform: raw.platform,
        seller_type: raw.seller_type ?? 'dealer',
        locality: raw.vendor_locality ?? null, city: raw.vendor_city ?? null,
        region_id: raw.region_id, lat: geo?.lat ?? null, lon: geo?.lon ?? null,
        geo_confidence: geo ? 'derived' : 'unknown',
        rating: raw.vendor_rating ?? null, review_count: raw.vendor_review_count ?? null,
        profile_url: raw.vendor_profile_url ?? null, now,
      });

      const { hsn, key } = gstKeyFor(n.category, n.attrs);
      const rate = resolveGstRate(GST_RATES, hsn, key, now);
      if (!rate) { st.skipped['no GST rate in force'] = (st.skipped['no GST rate in force'] ?? 0) + 1; continue; }

      const qco = n.category === 'cement' || n.category === 'tmt_steel';
      upProduct.run({
        product_id: n.product_id, item_code: n.item_code, category: n.category,
        category_path: `${n.category}`, title: n.title, brand: n.brand,
        attrs: JSON.stringify(n.attrs),
        unit_canonical: n.unit_canonical, unit_trade: n.unit_trade,
        pack_size: n.pack_size, pack_unit: n.pack_unit,
        unit_weight_kg: n.unit_weight_kg, unit_volume_m3: n.unit_volume_m3,
        hsn, gst_rate_bp: rate.rate_bp,
        qco_regulated: qco ? 1 : 0,
        qco_citation: qco
          ? n.category === 'cement'
            ? 'Cement (Quality Control) Order 2003, S.O. 191(E) — named in a secondary source, not yet read against the gazette'
            : 'IS 1786 deformed bars are under a mandatory certification regime; the specific QCO instrument is unconfirmed'
          : null,
        cert_standards: JSON.stringify(certStandardsFor(n.category, n.attrs)),
        country_of_origin: n.country_of_origin,
        volatility_class: n.category === 'water_pipes' ? 'V1' : 'V0',
        image_url: raw.images?.[0] ?? null,
        now,
      });

      const moq = moqFromSpecs(raw);
      const offer_id = `o_${hash(`${raw.source_id}|${raw.source_ref}`)}`;
      if (existsOffer.get(offer_id)) st.offersSeen++; else st.offersNew++;
      upOffer.run({
        offer_id, product_id: n.product_id, vendor_id, region_id: raw.region_id,
        platform: raw.platform, source_id: raw.source_id, source_url: raw.source_url,
        source_ref: raw.source_ref,
        listing_title: raw.title ?? null,
        base_paise: raw.price_paise, base_unit: n.unit_trade,
        base_paise_canonical: n.base_paise_per_canonical,
        trade_multiple: tradeMultiple(n),
        gst_treatment: raw.gst_treatment ?? 'EXCL', gst_rate_bp: rate.rate_bp, hsn,
        mrp_paise: raw.mrp_paise ?? null,
        delivery_scope: 'EX_WORKS',
        // Falls back to the spec table: IndiaMART publishes MOQ as a spec row on
        // 156 offers while its card selector matches nothing, so this column was
        // being filled from ExportersIndia alone.
        moq_qty: moq.qty, moq_unit: moq.unit,
        bulk_slabs: raw.bulk_slabs ? JSON.stringify(raw.bulk_slabs) : null,
        stock_state: raw.stock_state ?? 'unknown', lead_time_days: raw.lead_time_days ?? null,
        cert_state: n.cert_state, cert_ref: n.cert_ref,
        rating: raw.vendor_rating ?? null, review_count: raw.vendor_review_count ?? null,
        images: raw.images ? JSON.stringify(raw.images) : null,
        datasheet_url: raw.datasheet_url ?? null,
        fetched_at: raw.fetched_at, run: runId,
      });

      for (const r of n.ladder.rows) {
        upSpec.run(n.product_id, offer_id, r.field, r.label, r.value, r.unit,
          r.source_url, r.fetched_at, r.confidence, r.derivation);
        st.ladder[r.confidence]++;
      }
    }
  });

  return st;
}

function tradeMultiple(n: any): number {
  const a = n.attrs;
  if (n.unit_trade === n.unit_canonical) return 1;
  if (n.category === 'tmt_steel' && n.unit_trade === 'piece' && a.rod_weight_kg) return a.rod_weight_kg;
  if (n.category === 'water_pipes' && (n.unit_trade === 'piece' || n.unit_trade === 'length')) return a.length_m ?? 3;
  if (n.category === 'bricks_blocks' && n.unit_trade === 'per_1000') return 1000;
  return 1;
}

function certStandardsFor(category: string, a: Record<string, any>): string[] {
  if (category === 'cement') {
    return a.cement_type === 'PPC' ? ['IS 1489'] : a.cement_type === 'PSC' ? ['IS 455']
      : a.cement_type === 'White cement' ? ['IS 8042'] : ['IS 269'];
  }
  if (category === 'tmt_steel') return ['IS 1786'];
  if (category === 'water_pipes') {
    const m: Record<string, string> = { CPVC: 'IS 15778', 'UPVC / PVC': 'IS 4985', SWR: 'IS 13592', GI: 'IS 1239', HDPE: 'IS 4984' };
    return a.pipe_system && m[a.pipe_system] ? [m[a.pipe_system]] : [];
  }
  if (category === 'bricks_blocks') {
    const m: Record<string, string> = {
      'Red clay brick': 'IS 1077', 'AAC block': 'IS 2185 Pt 3', 'Fly ash brick': 'IS 12894',
      'Concrete solid block': 'IS 2185 Pt 1', 'Concrete hollow block': 'IS 2185 Pt 1', 'CLC block': 'IS 2185 Pt 4',
    };
    return a.block_type && m[a.block_type] ? [m[a.block_type]] : [];
  }
  return [];
}

// ── source logging ───────────────────────────────────────────────────────────

function logSources(runId: string, results: SourceResult[]) {
  const ins = db().prepare(
    `INSERT INTO source_log (run_id,source_id,source_class,category,region_id,url,fetch_mode,
       http_status,outcome,offers_captured,pages_fetched,pagination_exhausted,estimated_missed,note,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const now = new Date().toISOString();
  tx(() => {
    for (const r of results) {
      ins.run(runId, r.source_id, r.source_class, r.category, r.region_id, r.url, r.fetch_mode,
        r.http_status, r.outcome, r.offers.length, r.pages_fetched,
        r.pagination_exhausted === null ? null : r.pagination_exhausted ? 1 : 0,
        r.estimated_missed, r.note, now);
    }
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!dbExists()) initSchema();
  initSchema();
  loadLocalities();

  const runId = `run_${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();
  db().prepare(
    `INSERT INTO collection_run (run_id,started_at,mode,status) VALUES (?,?,?,'running')`,
  ).run(runId, startedAt, MODE);

  const categories = (ONLY_CATEGORY ? [ONLY_CATEGORY] : [...CATEGORIES]) as string[];
  log(`\nBuildO collector — run ${runId}, mode=${MODE}`);
  log(`categories: ${categories.join(', ')}  regions: ${REGIONS.join(', ')}\n`);

  const totals = {
    sourcesAttempted: 0, sourcesOk: 0, sourcesBlocked: 0,
    byOutcome: {} as Record<string, number>,
    offersCaptured: 0, offersNew: 0, vendorsNew: 0, noPrice: 0,
    ladder: { quoted: 0, derived: 0, typical: 0, unknown: 0 },
    skipped: {} as Record<string, number>,
  };
  const allResults: SourceResult[] = [];
  let dryPasses = 0;

  for (let pass = 1; pass <= MAX_PASSES && dryPasses < 2; pass++) {
    log(`── pass ${pass} ──────────────────────────────────────────`);
    let passNewOffers = 0, passNewVendors = 0;

    for (const adapter of ADAPTERS) {
      for (const category of categories) {
        for (const region_id of REGIONS) {
          const covered = adapter.covers.some((c) => c.category === category && c.region_id === region_id);
          if (!covered) continue;

          let results: SourceResult[] = [];
          try {
            results = await adapter.run(category, region_id, { fetchText, log, pass });
          } catch (e) {
            results = [{
              source_id: adapter.id, source_class: adapter.source_class, category, region_id,
              url: adapter.id, fetch_mode: 'http', http_status: null, outcome: 'parse_fail',
              offers: [], pages_fetched: 0, pagination_exhausted: null, estimated_missed: null,
              note: `adapter threw: ${(e as Error).message}`,
            }];
          }

          allResults.push(...results);
          logSources(runId, results);
          totals.sourcesAttempted += results.length;
          // Every outcome is counted, not just the two buckets the headline used
          // to name. `ok` and the blocked family were tallied and `empty`,
          // `parse_fail` and `skipped` were silently dropped, so a run reading
          // "34 attempted · 2 ok · 24 blocked" left eight rows unaccounted for —
          // and those eight were where the ExportersIndia parser was failing.
          for (const r of results) totals.byOutcome[r.outcome] = (totals.byOutcome[r.outcome] ?? 0) + 1;
          totals.sourcesOk = totals.byOutcome.ok ?? 0;
          totals.sourcesBlocked = (['blocked', 'rate_limited', 'login_wall', 'captcha'] as const)
            .reduce((n, k) => n + (totals.byOutcome[k] ?? 0), 0);

          const raws = results.flatMap((r) => r.offers);
          if (!raws.length) continue;
          for (const r of results) writeRaw(r.source_id, r.offers);

          const st = loadOffers(runId, raws);
          totals.offersCaptured += raws.length;
          totals.offersNew += st.offersNew;
          totals.vendorsNew += st.vendorsNew;
          totals.noPrice += st.noPrice;
          for (const k of ['quoted', 'derived', 'typical', 'unknown'] as const) totals.ladder[k] += st.ladder[k];
          for (const [k, v] of Object.entries(st.skipped)) totals.skipped[k] = (totals.skipped[k] ?? 0) + v;
          passNewOffers += st.offersNew;
          passNewVendors += st.vendorsNew;

          log(`  ${adapter.id}/${category}/${region_id}: +${st.offersNew} offers, +${st.vendorsNew} vendors`);
        }
      }
    }

    log(`  pass ${pass} total: +${passNewOffers} offers, +${passNewVendors} vendors`);
    // Collect until dry: two consecutive passes that surface nothing new.
    if (passNewOffers === 0 && passNewVendors === 0) dryPasses++;
    else dryPasses = 0;
  }

  log(`\nrebuilding price surface…`);
  const pr = rebuildPrices(runId, MODE === 'seed' ? 'seed' : 'schedule');
  const indexed = rebuildSearchIndex();
  log(`  price_current ${pr.rows} rows over ${pr.products} (product,region) pairs; ` +
    `price_history +${pr.historyRows}; search index ${indexed} products`);
  if (pr.quarantined.length) {
    log(`  absurdity gate quarantined ${pr.quarantined.length} price(s) outside [0.1x, 10x] of their category median — never published:`);
    for (const q of pr.quarantined.slice(0, 8)) {
      log(`    ₹${(q.paise / 100).toFixed(2)} vs median ₹${(q.median / 100).toFixed(2)} (${q.ratio}×) — ${q.key}`);
    }
  }

  // The breakdown has to account for every attempt. If it does not, some outcome
  // is being dropped from the headline the way empty/parse_fail/skipped were.
  const outcomeBreakdown = Object.entries(totals.byOutcome)
    .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ');
  const counted = Object.values(totals.byOutcome).reduce((a, b) => a + b, 0);
  if (counted !== totals.sourcesAttempted) {
    log(`  WARNING: outcome breakdown sums to ${counted} but ${totals.sourcesAttempted} sources were attempted`);
  }

  const finishedAt = new Date().toISOString();
  db().prepare(
    `UPDATE collection_run SET finished_at=?, status=?, sources_attempted=?, sources_ok=?,
       sources_blocked=?, offers_captured=?, offers_new=?, vendors_new=?,
       ladder_quoted=?, ladder_derived=?, ladder_typical=?, ladder_unknown=?, notes=?
     WHERE run_id=?`,
  ).run(finishedAt, totals.sourcesBlocked > totals.sourcesOk ? 'partial' : 'ok',
    totals.sourcesAttempted, totals.sourcesOk, totals.sourcesBlocked,
    totals.offersCaptured, totals.offersNew, totals.vendorsNew,
    totals.ladder.quoted, totals.ladder.derived, totals.ladder.typical, totals.ladder.unknown,
    `dryPasses=${dryPasses}; listings with no published price=${totals.noPrice}; outcomes: ${outcomeBreakdown}`,
    runId);

  const { writeSnapshots } = await import('../scripts/snapshot');
  await writeSnapshots(runId);
  const { writeCollectionLog } = await import('../scripts/collection-log');
  writeCollectionLog(runId, totals, allResults);

  log(`\ndone. run ${runId}`);
  log(`  sources ${totals.sourcesAttempted} attempted — ${outcomeBreakdown}`);
  log(`  offers captured ${totals.offersCaptured}, new ${totals.offersNew}, vendors new ${totals.vendorsNew}`);
  log(`  ladder: quoted ${totals.ladder.quoted}, derived ${totals.ladder.derived}, ` +
    `typical ${totals.ladder.typical}, unknown ${totals.ladder.unknown}`);
  if (Object.keys(totals.skipped).length) {
    log(`  not loaded (recorded, never invented):`);
    for (const [k, v] of Object.entries(totals.skipped).sort((a, b) => b[1] - a[1])) log(`    ${v}× ${k}`);
  }
}

// Only sweep when this file is the thing being run. scripts/rebuild-from-raw.ts
// imports loadOffers from here to re-load the archive under new normalisation
// rules, and importing a module must not fire 600 HTTP requests.
if (/[\\/]collector[\\/]run\.ts$/.test(process.argv[1] ?? '')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
