/**
 * Verify every price, end to end.
 *
 * For every active offer in the store this re-derives what the store says
 * from what the collector saw, and checks the arithmetic on top of it:
 *
 *   1. RAW → STORED   The raw capture (collector/raw/*.jsonl, latest record
 *                     per offer) is put through normalise() again with the
 *                     code as it stands today, and the seller's figure per
 *                     canonical unit, the quoted unit, the GST rate and the
 *                     product identity are compared with the stored row.
 *   2. ARITHMETIC     On every published price: ex-GST base, GST, freight,
 *                     handling, loading sum to the landed figure; the trade
 *                     landed figure is that × the trade multiple; the
 *                     freshness stamp is the capture's own.
 *   3. PLAUSIBILITY   No active offer is one lib/plausibility.ts would refuse;
 *                     every published price sits inside its category band.
 *   4. FRESHNESS      Per category and region: how many are quotable, and the
 *                     oldest stamp still on the surface.
 *   5. THE TWO CITIES The medians and floors of Hyderabad and Vijayawada agree
 *                     within a factor of two — the reader's own test.
 *   6. COVERAGE       Raw captures that normalise today but have no row.
 *   7. LIVE (--live)  A polite sample of source pages is fetched now and the
 *                     stored seller figure is looked for on the page.
 *
 * Writes data/logs/verify-<date>.md and exits 1 on any hard failure.
 *
 *   npm run verify            npm run verify -- --live
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initSchema, prep } from '../lib/db';
import { normalise } from '../collector/normalize';
import { resolveGstRate, gstKeyFor, GST_RATES } from '../lib/gst';
import { gstOn, baseFromInclusive, roundHalfUp, median } from '../lib/money';
import { assess, SLA_HOURS, CATEGORY_VOLATILITY } from '../lib/freshness';
import { implausibleReason, PRICE_BAND } from '../lib/plausibility';
import { CATEGORIES, CATEGORY_LABEL } from '../lib/types';
import { categoryStats } from '../lib/meta';
import { search } from '../lib/search';
import { fetchText } from '../collector/fetch';
import type { RawOffer } from '../collector/types';

const ROOT = process.cwd();
const RAW_DIR = path.join(ROOT, 'collector', 'raw');
const LIVE = process.argv.includes('--live');
const LIVE_N = Number(process.argv.find((a) => a.startsWith('--live-n='))?.split('=')[1] ?? 6);
const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const rs = (p: number) => `₹${(p / 100).toFixed(2)}`;

const lines: string[] = [];
const out = (s = '') => { console.log(s); lines.push(s); };
let hard = 0;
const check = (name: string, ok: boolean, detail = '') => {
  out(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) hard++;
};

initSchema();
const now = new Date();
out(`# Price verification — ${now.toISOString()}`);
out('');

/* ── the raw archive, latest record per offer ─────────────────────────────── */
const rawById = new Map<string, RawOffer>();
let rawRecords = 0;
for (const f of fs.readdirSync(RAW_DIR).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(RAW_DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: RawOffer;
    try { r = JSON.parse(line); } catch { continue; }
    rawRecords++;
    const id = `o_${hash(`${r.source_id}|${r.source_ref}`)}`;
    const cur = rawById.get(id);
    if (!cur || (r.fetched_at ?? '') > (cur.fetched_at ?? '')) rawById.set(id, r);
  }
}
out(`raw archive: ${rawRecords.toLocaleString('en-IN')} records, ${rawById.size.toLocaleString('en-IN')} distinct listings`);

/* ── the store ─────────────────────────────────────────────────────────────── */
const offers = prep(`
  SELECT o.offer_id, o.product_id, o.vendor_id, o.region_id, o.source_id, o.source_url, o.listing_title, o.platform,
         o.base_paise, o.base_unit, o.base_paise_canonical, o.trade_multiple, o.gst_treatment, o.gst_rate_bp, o.hsn,
         o.fetched_at, o.moq_qty,
         p.category, p.title AS product_title, p.pack_size, p.attrs, p.unit_canonical
    FROM offer o JOIN product p ON p.product_id = o.product_id
   WHERE o.is_active = 1`).all() as any[];
out(`store: ${offers.length.toLocaleString('en-IN')} active offers`);
out('');

/* ── 1. raw → stored ───────────────────────────────────────────────────────── */
out('## 1. Raw capture → stored row, re-derived today');
let rawMissing = 0, exact = 0, priceDrift = 0, unitDrift = 0, gstDrift = 0, identityDrift = 0, nowRefused = 0, refusedNonPlaus = 0;
const drift: string[] = [];
const missingBySource = new Map<string, number>();
for (const o of offers) {
  const raw = rawById.get(o.offer_id);
  if (!raw) { rawMissing++; missingBySource.set(o.source_id, (missingBySource.get(o.source_id) ?? 0) + 1); continue; }
  const n = normalise(raw) as any;
  if (n.ok === false) {
    nowRefused++;
    if (!/different product class|plausible band|retail pouch|coil length|bore is outside/.test(n.reason)) {
      refusedNonPlaus++;
      if (drift.length < 12) drift.push(`refused (not plausibility): ${o.offer_id} "${String(raw.title).slice(0, 50)}" — ${n.reason.slice(0, 80)}`);
    }
    continue;
  }
  let same = true;
  if (n.base_paise_per_canonical !== o.base_paise_canonical) {
    same = false; priceDrift++;
    if (drift.length < 12) drift.push(`price: ${o.offer_id} "${String(raw.title).slice(0, 44)}" stored ${rs(o.base_paise_canonical)}/${o.unit_canonical} vs re-derived ${rs(n.base_paise_per_canonical)} (${raw.price_text})`);
  }
  if (n.unit_trade !== o.base_unit) { same = false; unitDrift++; if (drift.length < 12) drift.push(`unit: ${o.offer_id} stored ${o.base_unit} vs ${n.unit_trade}`); }
  const { hsn, key } = gstKeyFor(n.category, n.attrs);
  const rate = resolveGstRate(GST_RATES, hsn, key, now.toISOString());
  if (!rate || rate.rate_bp !== o.gst_rate_bp) { same = false; gstDrift++; if (drift.length < 12) drift.push(`gst: ${o.offer_id} stored ${o.gst_rate_bp} bp vs ${rate?.rate_bp ?? 'none'} (${hsn})`); }
  if (n.product_id !== o.product_id) { identityDrift++; }
  if (same) exact++;
}
const derived = offers.length - rawMissing - nowRefused;
out(`  raw record found for ${(offers.length - rawMissing).toLocaleString('en-IN')} of ${offers.length.toLocaleString('en-IN')} active offers` +
  (rawMissing ? ` — ${rawMissing} without a raw file on disk (${[...missingBySource].map(([s, n]) => `${s} ${n}`).join(', ')})` : ''));
out(`  re-derived: ${exact.toLocaleString('en-IN')} exact · price drift ${priceDrift} · unit drift ${unitDrift} · GST drift ${gstDrift} · identity drift ${identityDrift} (attrs parse differently now — the same seller figure under a different product key; the next collection re-keys it)`);
out(`  refused by today's rules: ${nowRefused} (${refusedNonPlaus} for a non-plausibility reason)`);
for (const d of drift) out(`    · ${d}`);
check('every stored seller figure per canonical unit re-derives exactly from its raw capture', priceDrift === 0);
check('every stored quoted unit re-derives exactly', unitDrift === 0);
check('every stored GST rate is the rate in force for its HSN', gstDrift === 0);
check('no active offer is refused today for a parse or unit reason', refusedNonPlaus === 0);
check('no active offer is refused today by the plausibility rules', nowRefused - refusedNonPlaus === 0,
  `${nowRefused - refusedNonPlaus} would be — run npm run rebuild`);
out('');

/* ── 2. arithmetic on every published price ────────────────────────────────── */
out('## 2. Arithmetic on every published price');
const surface = prep(`
  SELECT op.offer_id, op.region_id, op.base_paise, op.gst_paise, op.freight_paise, op.handling_paise, op.loading_paise,
         op.landed_paise, op.normalised_paise, op.priced_as_of, op.sla_hours,
         o.base_paise_canonical, o.trade_multiple, o.gst_treatment, o.gst_rate_bp, o.fetched_at,
         p.category
    FROM offer_price op JOIN offer o ON o.offer_id = op.offer_id JOIN product p ON p.product_id = op.product_id
   WHERE o.is_active = 1`).all() as any[];
let badBase = 0, badGst = 0, badSum = 0, badTrade = 0, badStamp = 0, badSla = 0, negative = 0;
const arith: string[] = [];
for (const r of surface) {
  const baseEx = r.gst_treatment === 'INCL' ? baseFromInclusive(r.base_paise_canonical, r.gst_rate_bp) : r.base_paise_canonical;
  const gst = gstOn(baseEx, r.gst_rate_bp);
  if (baseEx !== r.base_paise) { badBase++; if (arith.length < 8) arith.push(`base: ${r.offer_id} ${rs(r.base_paise)} vs ${rs(baseEx)} (${r.gst_treatment}, ${r.gst_rate_bp} bp)`); }
  if (gst !== r.gst_paise) { badGst++; if (arith.length < 8) arith.push(`gst: ${r.offer_id} ${rs(r.gst_paise)} vs ${rs(gst)}`); }
  if (r.base_paise + r.gst_paise + r.freight_paise + r.handling_paise + r.loading_paise !== r.normalised_paise) { badSum++; if (arith.length < 8) arith.push(`sum: ${r.offer_id}`); }
  if (roundHalfUp(r.normalised_paise * (r.trade_multiple || 1)) !== r.landed_paise) { badTrade++; if (arith.length < 8) arith.push(`trade: ${r.offer_id} ${rs(r.landed_paise)} vs ${rs(roundHalfUp(r.normalised_paise * (r.trade_multiple || 1)))} ×${r.trade_multiple}`); }
  if (r.priced_as_of !== r.fetched_at) badStamp++;
  if (r.sla_hours !== SLA_HOURS[CATEGORY_VOLATILITY[r.category] ?? 'V1']) badSla++;
  if (r.freight_paise < 0 || r.handling_paise < 0 || r.loading_paise < 0 || r.base_paise <= 0) negative++;
}
for (const a of arith) out(`    · ${a}`);
check(`${surface.length.toLocaleString('en-IN')} published prices: ex-GST base is the seller figure on its stated GST basis`, badBase === 0, String(badBase));
check('GST on every price is the rate × the ex-GST base', badGst === 0, String(badGst));
check('base + GST + freight + handling + loading = landed per canonical unit, every row', badSum === 0, String(badSum));
check('landed per trade unit = landed per canonical × trade multiple, every row', badTrade === 0, String(badTrade));
check('every price carries the capture\'s own timestamp', badStamp === 0, String(badStamp));
check('every price carries its category\'s refresh SLA', badSla === 0, String(badSla));
check('no negative component and no zero base', negative === 0, String(negative));
out('');

/* ── 3. plausibility ───────────────────────────────────────────────────────── */
out('## 3. Plausibility');
let implausible = 0;
const implausibleEg: string[] = [];
for (const o of offers) {
  let attrs: any = {}; try { attrs = JSON.parse(o.attrs || '{}'); } catch { /* ours */ }
  const reason = implausibleReason({
    category: o.category, title: o.listing_title ?? o.product_title ?? '', cement_type: attrs.cement_type ?? null,
    pack_size_kg: o.pack_size ?? attrs.pack_size_kg ?? null, nominal_bore_mm: attrs.nominal_bore_mm ?? null,
    quoted_unit: o.base_unit, bore_trusted: false, base_paise_per_canonical: o.base_paise_canonical,
  });
  if (reason) { implausible++; if (implausibleEg.length < 6) implausibleEg.push(`${o.offer_id} "${String(o.listing_title).slice(0, 44)}" — ${reason.slice(0, 70)}`); }
}
for (const e of implausibleEg) out(`    · ${e}`);
check('no active offer is one the plausibility rules would refuse', implausible === 0, String(implausible));
const quarantined = (prep(`SELECT COUNT(*) AS n FROM offer WHERE is_active = 0 AND quarantine_reason IS NOT NULL`).get() as any).n;
out(`  quarantined with a reason on the row: ${quarantined}`);
const bandFail: string[] = [];
const byKey = new Map<string, number[]>();
for (const r of surface) (byKey.get(`${r.category}|${r.region_id}`) ?? byKey.set(`${r.category}|${r.region_id}`, []).get(`${r.category}|${r.region_id}`)!).push(r.normalised_paise);
for (const [k, vals] of byKey) {
  const [cat] = k.split('|');
  const b = cat === 'cement' ? PRICE_BAND.cement_white : PRICE_BAND[cat];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo < b.lo || hi > b.hi * 1.5) bandFail.push(`${k}: ${rs(lo)}–${rs(hi)} outside ${rs(b.lo)}–${rs(b.hi * 1.5)}`);
}
check('every published price sits inside its category band (with GST and logistics on top)', bandFail.length === 0, bandFail.join(' | '));
out('');

/* ── 4. freshness ──────────────────────────────────────────────────────────── */
out('## 4. Freshness');
out('  category / region            offers  quotable  fresh   oldest stamp on the surface');
for (const cat of CATEGORIES) for (const region of ['hyderabad', 'vijayawada']) {
  const rows = surface.filter((r) => r.category === cat && r.region_id === region);
  if (!rows.length) { out(`  ${`${cat} / ${region}`.padEnd(28)} —`); continue; }
  const q = rows.filter((r) => assess(r.priced_as_of, r.sla_hours, now).quotable).length;
  const f = rows.filter((r) => assess(r.priced_as_of, r.sla_hours, now).state === 'FRESH').length;
  const oldest = rows.reduce((m, r) => (r.priced_as_of < m ? r.priced_as_of : m), rows[0].priced_as_of);
  out(`  ${`${cat} / ${region}`.padEnd(28)} ${String(rows.length).padStart(6)}  ${String(q).padStart(8)}  ${String(f).padStart(5)}   ${oldest.slice(0, 16).replace('T', ' ')}Z`);
}
out('');

/* ── 5. the two cities ─────────────────────────────────────────────────────── */
out('## 5. The two cities');
const stats = categoryStats(now);
for (const cat of CATEGORIES) {
  const h = stats.find((s) => s.category === cat && s.region_id === 'hyderabad');
  const v = stats.find((s) => s.category === cat && s.region_id === 'vijayawada');
  if (!h?.median_paise || !v?.median_paise || h.lo_paise == null || v.lo_paise == null) { check(`${cat}: both cities have quotable prices`, false); continue; }
  const mr = h.median_paise / v.median_paise, lr = h.lo_paise / v.lo_paise;
  check(`${CATEGORY_LABEL[cat]}: typical ${rs(h.median_paise)} vs ${rs(v.median_paise)} (×${mr.toFixed(2)}), from ${rs(h.lo_paise)} vs ${rs(v.lo_paise)} (×${lr.toFixed(2)}) — within 2×`,
    mr >= 0.5 && mr <= 2 && lr >= 0.5 && lr <= 2);
  // The card's LEADING figure is the listing's row count. Both sides were
  // sellers until the list became one card per product; the same drift was in
  // tests/run.ts and this file kept its own copy of it.
  for (const [region, pincode, st] of [['hyderabad', '500001', h], ['vijayawada', '520001', v]] as const) {
    const r = search({ q: '', pincode, region_id: region, category: cat });
    check(`${CATEGORY_LABEL[cat]} / ${region}: card products ${st.products} == listing rows ${r.total}`, st.products === r.total);
  }
}
out('');

/* ── 6. coverage of the raw archive ────────────────────────────────────────── */
out('## 6. Coverage');
const active = new Set(offers.map((o) => o.offer_id));
const inactive = new Set((prep(`SELECT offer_id FROM offer WHERE is_active = 0`).all() as any[]).map((r) => r.offer_id));
let notLoaded = 0, refusedRaw = 0;
const notLoadedBySource = new Map<string, number>();
for (const [id, raw] of rawById) {
  if (active.has(id) || inactive.has(id)) continue;
  if (raw.price_paise == null) continue;
  const n = normalise(raw) as any;
  if (n.ok === false) { refusedRaw++; continue; }
  notLoaded++;
  notLoadedBySource.set(raw.source_id, (notLoadedBySource.get(raw.source_id) ?? 0) + 1);
}
out(`  raw listings that normalise today but have no row: ${notLoaded}${notLoaded ? ` (${[...notLoadedBySource].map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}; refused at normalise: ${refusedRaw}`);
check('every raw listing that normalises today is in the store', notLoaded === 0, `${notLoaded} not loaded — run npm run collect (or --sources=assisted)`);
out('');

/* ── 7. live spot check ────────────────────────────────────────────────────── */
async function live() {
  out(`## 7. Live spot check — ${LIVE_N} per category, fetched now, politely`);
  const results: string[] = [];
  let seen = 0, found = 0, throttled = 0, unreachable = 0;
  for (const cat of CATEGORIES) {
    // Prefer sources that answer a polite scripted client; sample across sellers.
    const pool = offers.filter((o) => o.category === cat && /^https?:/.test(o.source_url) && !/bigbmart/.test(o.source_id))
      .sort((a, b) => (a.source_id === 'exportersindia' ? -1 : 1) - (b.source_id === 'exportersindia' ? -1 : 1) || a.offer_id.localeCompare(b.offer_id));
    const step = Math.max(1, Math.floor(pool.length / LIVE_N));
    for (let i = 0, k = 0; i < pool.length && k < LIVE_N; i += step, k++) {
      const o = pool[i];
      const res = await fetchText(o.source_url, { retries: 0, timeoutMs: 30_000 });
      seen++;
      const label = `${cat} · ${o.source_id} · ${String(o.listing_title).slice(0, 36)} · stored ${rs(o.base_paise)}/${o.base_unit}`;
      if (!res.ok) { if (res.status === 429) throttled++; else unreachable++; results.push(`  ~ ${label} — HTTP ${res.status}${res.status === 429 ? ' (throttled; unverified, not wrong)' : ''}`); continue; }
      const text = res.body.replace(/<[^>]+>/g, ' ').replace(/&#8377;|&#x20b9;|&#8360;/gi, '₹');
      const amounts = new Set([...text.matchAll(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/gi)].map((m) => Math.round(Number(m[1].replace(/,/g, '')) * 100)));
      const hit = amounts.has(o.base_paise);
      if (hit) found++;
      results.push(`  ${hit ? '✓' : '✗'} ${label} — ${hit ? 'figure on the page' : `page shows ${[...amounts].slice(0, 6).map((a) => rs(a)).join(', ') || 'no rupee amount (client-rendered?)'}`}`);
    }
  }
  for (const r of results) out(r);
  out(`  fetched ${seen}: ${found} confirmed on the page · ${throttled} throttled · ${unreachable} unreachable · ${seen - found - throttled - unreachable} differ`);
  check('every reachable sampled page still shows the stored seller figure', seen - found - throttled - unreachable === 0);
  out('');
}

(async () => {
  if (LIVE) await live();
  out(`## Result: ${hard === 0 ? 'PASS' : `${hard} hard failure(s)`}`);
  const file = path.join(ROOT, 'data', 'logs', `verify-${now.toISOString().slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  console.log(`\nreport → ${path.relative(ROOT, file)}`);
  process.exit(hard === 0 ? 0 : 1);
})();
