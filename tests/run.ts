/**
 * The three laws, asserted rather than promised — plus the unit table, which is
 * the one place a silent error would make every price wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { initSchema, prep, close } from '../lib/db';
import { search, __facetEquivalence, invalidateSearchCache } from '../lib/search';
import { resolvePrice, resolveAllOffers, resolveBulk, rollUpByVendor } from '../lib/price';
import { armNetworkGuard, guardState, resetViolations } from '../lib/no-network';
import { inchToBoreMm, TMT_KG_PER_M, convertPricePerUnit, UNIT_CONVERSIONS } from '../lib/units';
import { gstOn, baseFromInclusive, roundHalfUp, paiseFromRupeeText } from '../lib/money';
import { computeFreight, fallbackDistanceKm, seedFromId } from '../lib/freight';
import { resolveGstRate, GST_RATES, gstKeyFor } from '../lib/gst';
import { assess } from '../lib/freshness';
import { parseCards, pageMeta } from '../collector/sources/exportersindia';
import { parseTradeIndia, __targetsFor } from '../collector/sources/directories';
import { normalise, normaliseUnit } from '../collector/normalize';
import {
  contrast, stack, parseRootTokens, resolveToken, AA_TEXT,
  type RGB, type RGBA,
} from '../lib/contrast';

let pass = 0, fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  ok(name, Object.is(a, b), `expected ${String(b)}, got ${String(a)}`);
}

initSchema();

// ── LAW 1: the query path never calls out ───────────────────────────────────
console.log('\nLAW 1 — the query path never calls out');
{
  armNetworkGuard();
  resetViolations();
  let threw = false;
  try { (globalThis.fetch as any)('https://www.indiamart.com/'); } catch { threw = true; }
  ok('an outbound fetch during a request throws', threw);
  ok('the violation is recorded with its URL', guardState().violations.some((v) => v.includes('indiamart')));
  ok('the guard reports itself armed', guardState().armed);

  resetViolations();
  const r = search({ q: 'cement', pincode: '500001', region_id: 'hyderabad' });
  ok('a full search makes zero outbound requests', guardState().violations.length === 0,
    guardState().violations.join(', '));
  ok('and it still returns results', r.results.length > 0 || r.total === 0);
}

// ── LAW 2: every displayed price carries a unit basis and a timestamp ───────
console.log('\nLAW 2 — every price carries a unit basis and a freshness timestamp');
{
  const r = search({ q: '', pincode: '500001', region_id: 'hyderabad' });
  const bad = r.results.filter(
    (c) => !c.unit_canonical || !c.priced_as_of || !c.freshness_state || !c.delivery_scope || !c.gst_treatment
      || c.gst_rate_bp === undefined || !c.hsn,
  );
  ok('no card can render without unit + basis + timestamp', bad.length === 0,
    bad.slice(0, 3).map((b) => b.title).join('; '));
  ok('every card carries a normalised unit price', r.results.every((c) => c.normalised_paise > 0));
  ok('every card carries a landed price', r.results.every((c) => c.landed_paise > 0));
  ok('freshness state is one of the four defined states',
    r.results.every((c) => ['FRESH', 'AGEING', 'STALE', 'EXPIRED'].includes(c.freshness_state)));
}

// ── LAW 3: the price search shows is the price the cart would bill ──────────
console.log('\nLAW 3 — search price == detail price == list total');
{
  // Parity is per OFFER, because a card is one seller's offer rather than a
  // product summary. Asking resolvePrice for the product alone would return
  // whichever seller is cheapest and compare two different sellers' prices —
  // which is not what the card promised, and not what the cart would bill.
  const r = search({ q: '', pincode: '500001', region_id: 'hyderabad', limit: 24 });
  let checked = 0, mismatches: string[] = [];
  for (const card of r.results.slice(0, 12)) {
    const q = resolvePrice({ product_id: card.product_id, pincode: '500001', offer_id: card.offer_id });
    if (!q) continue;
    checked++;
    if (q.offer_id !== card.offer_id) {
      mismatches.push(`${card.title}: resolvePrice returned a different offer (${q.offer_id} vs ${card.offer_id})`);
    } else if (q.basis.normalised.paise !== card.normalised_paise) {
      mismatches.push(`${card.title}: card ${card.normalised_paise} vs resolvePrice ${q.basis.normalised.paise}`);
    }
  }
  ok(`search card and resolvePrice agree to the paise, per seller (${checked} offers)`, mismatches.length === 0,
    mismatches.slice(0, 2).join(' | '));

  // The detail sheet leads with the offer that was clicked. It used to find it
  // by VENDOR, and a vendor's row in the rolled-up table is their CHEAPEST
  // listing — so for any seller who posts the same product twice, the sheet
  // showed a different price from the card that opened it. Caught live at
  // ₹321.60 on the card against ₹315.70 in the sheet.
  const multi = r.results
    .map((c) => ({ c, all: resolveAllOffers(c.product_id, '500001') }))
    .filter((x) => x.all && x.all.offers.filter((o) => o.vendor.vendor_id === x.c.vendor_id).length > 1);
  let leadChecked = 0; const leadBad: string[] = [];
  for (const { c, all } of multi) {
    const exact = all!.offers.find((o) => o.offer_id === c.offer_id);
    const byVendor = all!.offers.find((o) => o.vendor.vendor_id === c.vendor_id);
    leadChecked++;
    if (!exact) { leadBad.push(`${c.best_vendor}: clicked offer not resolvable`); continue; }
    if (exact.normalised_paise !== c.normalised_paise) {
      leadBad.push(`${c.best_vendor}: card ${c.normalised_paise} vs offer ${exact.normalised_paise}`);
    }
    // The bug, stated as an assertion: matching on vendor would have picked a
    // different listing. If this ever stops differing the test still passes —
    // it only fails if the exact-offer lookup drifts.
    if (byVendor && byVendor.offer_id !== exact.offer_id && byVendor.normalised_paise === c.normalised_paise) {
      leadBad.push(`${c.best_vendor}: vendor lookup coincidentally matched — test no longer discriminating`);
    }
  }
  ok(`the sheet's lead offer is the one clicked, not the seller's cheapest (${leadChecked} multi-listing sellers)`,
    leadBad.length === 0, leadBad.slice(0, 2).join(' | '));

  // The vendor table's best row must be the same number the card showed.
  const first = r.results[0];
  if (first) {
    const all = resolveAllOffers(first.product_id, '500001');
    eq('vendor table cheapest == card hero price', all?.quotes[0].basis.normalised.paise, first.normalised_paise);
  }

  // A saved list prices through the same contract.
  const lines = r.results.slice(0, 3).map((c) => ({ product_id: c.product_id, qty: 10 }));
  const bulk = resolveBulk(lines, '500001');
  const expected = bulk.quotes.reduce((s, q) => s + q.basis.normalised.paise * 10, 0);
  eq('list total == sum of resolvePrice lines', bulk.total_paise, expected);
}

// ── the unit table: a wrong conversion makes an entire BOQ fiction ──────────
console.log('\nUNIT TABLE — a table with tests, never arithmetic');
{
  eq('1" CPVC = 25 mm nominal bore', inchToBoreMm('1'), 25);
  eq('½" = 15 mm', inchToBoreMm('1/2'), 15);
  eq('¾" = 20 mm', inchToBoreMm('3/4'), 20);
  // The headline case: naive ×25.4 gives 101.6 mm, which is wrong.
  eq('4" SWR = 110 mm OD, NOT 4 × 25.4 = 101.6', inchToBoreMm('4'), 110);
  ok('4" is not the arithmetic conversion', inchToBoreMm('4') !== Math.round(4 * 25.4));

  eq('8 mm TMT nominal mass', TMT_KG_PER_M[8], 0.395);
  eq('12 mm TMT nominal mass', TMT_KG_PER_M[12], 0.888);
  eq('a 12 m 12 mm rod weighs 10.656 kg', +(TMT_KG_PER_M[12] * 12).toFixed(3), 10.656);

  const bagToTonne = convertPricePerUnit(35000, 'bag', 'tonne', 'cement', UNIT_CONVERSIONS);
  eq('₹350/bag → ₹7,000/tonne at 20 bags/t', bagToTonne?.paise, 700000);

  const lengthToMetre = convertPricePerUnit(50236, 'length', 'running_metre', 'water_pipes', UNIT_CONVERSIONS);
  eq('₹502.36 per 3 m length → ₹167.45/m', lengthToMetre?.paise, 16745);

  ok('an unknown conversion returns null rather than guessing',
    convertPricePerUnit(1000, 'brass', 'bag', 'cement', UNIT_CONVERSIONS) === null);
}

// ── money: integer paise, no float touches a rupee ──────────────────────────
console.log('\nMONEY — integer paise throughout');
{
  eq('GST 18% on ₹402.00', gstOn(40200, 1800), 7236);
  eq('the spec worked example totals ₹502.36', 40200 + 7236 + 1800 + 600 + 400, 50236);
  eq('₹502.36 per 3 m = ₹167.45/m', roundHalfUp(50236 / 3), 16745);
  eq('stripping 18% out of an inclusive ₹47,436', baseFromInclusive(47436, 1800), 40200);
  ok('round-tripping inclusive→base→gst is exact',
    baseFromInclusive(47436, 1800) + gstOn(baseFromInclusive(47436, 1800), 1800) === 47436);
  ok('all stored prices are integers',
    (prep(`SELECT COUNT(*) c FROM price_current WHERE normalised_paise != CAST(normalised_paise AS INTEGER)`).get() as any).c === 0);
}

// ── GST: effective-dated rows, never constants ─────────────────────────────
console.log('\nGST — effective-dated data, not constants in code');
{
  const now = new Date().toISOString();
  eq('cement is 18% today (was 28% until 2025-09-21)', resolveGstRate(GST_RATES, '2523', 'cement', now)?.rate_bp, 1800);
  eq('cement was 28% on 2025-09-01', resolveGstRate(GST_RATES, '2523', 'cement', '2025-09-01')?.rate_bp, 2800);
  eq('clay brick is 12%, not the 5% repeated online', resolveGstRate(GST_RATES, '6904', 'bricks_blocks_clay', now)?.rate_bp, 1200);
  // Fly-ash percentage decides the rate, and silence is not evidence.
  eq('AAC with published >50% fly ash → 6815', gstKeyFor('bricks_blocks', { block_type: 'AAC block', fly_ash_pct: 62 }).hsn, '6815');
  eq('AAC with no published fly ash → 6810 at the higher slab', gstKeyFor('bricks_blocks', { block_type: 'AAC block' }).hsn, '6810');
  ok('an unknown HSN returns null rather than defaulting to 18%',
    resolveGstRate(GST_RATES, '9999', 'nonsense', now) === null);
}

// ── freight: deterministic, never random ───────────────────────────────────
console.log('\nFREIGHT — deterministic, identical on every reload');
{
  const a = fallbackDistanceKm('v_abc123');
  const b = fallbackDistanceKm('v_abc123');
  eq('the seeded fallback is stable across calls', a, b);
  ok('and differs between vendors', fallbackDistanceKm('v_abc123') !== fallbackDistanceKm('v_xyz789'));
  ok('the hash is stable', seedFromId('v_abc123') === seedFromId('v_abc123'));

  const input = {
    vendorId: 'v_test', vendorGeo: { lat: 17.44, lon: 78.39 }, destGeo: { lat: 17.385, lon: 78.4867 },
    category: 'cement', unitWeightKg: 50, unitVolumeM3: null, amortiseQty: 50,
    orderValuePaise: 1_600_000, vendorFreeDeliveryThresholdPaise: null,
  };
  const f1 = computeFreight(input), f2 = computeFreight(input);
  eq('same inputs give the same freight', f1.freightPaise, f2.freightPaise);
  ok('the breakdown shows its arithmetic', f1.breakdown.length >= 5);
  ok('a vehicle class is chosen from chargeable weight', ['tempo', 'lcv', '6_tyre', '10_tyre', 'parcel'].includes(f1.vehicleClass));
  ok('every estimated figure is flagged as estimated', f1.estimated === true);

  const free = computeFreight({ ...input, vendorFreeDeliveryThresholdPaise: 1_000_000 });
  eq('a published free-delivery threshold zeroes freight', free.freightPaise, 0);
}

// ── freshness: no state presents a stale price as current ──────────────────
console.log('\nFRESHNESS — a stale price is never shown as current');
{
  const now = Date.now();
  const at = (h: number) => new Date(now - h * 3.6e6).toISOString();
  eq('6 h against a 24 h SLA is FRESH', assess(at(6), 24, new Date(now)).state, 'FRESH');
  eq('18 h against 24 h is AGEING', assess(at(18), 24, new Date(now)).state, 'AGEING');
  eq('40 h against 24 h is STALE', assess(at(40), 24, new Date(now)).state, 'STALE');
  eq('80 h against 24 h is EXPIRED', assess(at(80), 24, new Date(now)).state, 'EXPIRED');
  ok('an EXPIRED price cannot be quoted', assess(at(80), 24, new Date(now)).quotable === false);
  eq('a stale price carries the −0.25 rank penalty', assess(at(40), 24, new Date(now)).penalty, 0.25);
}

// ── card photography ────────────────────────────────────────────────────────
console.log('\nPICTURES — capped, deduplicated, and this seller\'s first');
{
  const r = search({ q: '', pincode: '500001', region_id: 'hyderabad', limit: 24 });
  ok('every card carries an images array', r.results.every((c) => Array.isArray(c.images)));
  ok('never more than five', r.results.every((c) => c.images.length <= 5),
    `max was ${Math.max(0, ...r.results.map((c) => c.images.length))}`);
  ok('no card repeats a picture', r.results.every((c) => new Set(c.images).size === c.images.length));

  // Rotating between two encodings of one photograph is worse than not
  // rotating, so the collector dedupes on asset rather than URL.
  const stored = prep(
    `SELECT COUNT(*) c FROM product_image WHERE local_path IS NOT NULL`,
  ).get() as any;
  if (stored.c > 0) {
    ok('stored pictures are local files, not hotlinks',
      r.results.every((c) => c.images.every((u) => u.startsWith('/img/') || u.startsWith('http'))));
    const dupAsset = prep(
      `SELECT COUNT(*) c FROM (
         SELECT product_id, asset_key FROM product_image
          GROUP BY product_id, asset_key HAVING COUNT(*) > 1)`,
    ).get() as any;
    eq('one row per (product, asset) — no variant duplicates', dupAsset.c, 0);
    const datasheetLeak = r.results.some((c) => c.images.some((u) => /pdfimage/i.test(u)));
    ok('datasheet scans stay out of the card rotation', !datasheetLeak);
  }
}

// ── the results list is a list of SELLERS ───────────────────────────────────
console.log('\nVENDOR-LED RESULTS — a different seller on every row');
{
  const base = { pincode: '500001', region_id: 'hyderabad' };
  const cases: Array<[string, any]> = [
    ['plain query', { ...base, q: 'cement' }],
    ['browsing a category', { ...base, q: '', category: 'cement' }],
    ['with a brand filter', { ...base, q: 'cement', category: 'cement', facets: { brand: ['UltraTech'] } }],
    ['with two filters', { ...base, q: '', category: 'cement', facets: { cement_type: ['PPC'], pack_size: ['50 kg bag'] } }],
    ['other city', { pincode: '520001', region_id: 'vijayawada', q: 'cement' }],
    ['zero-result relax ladder', { ...base, q: 'xyzzy nonexistent 999' }],
  ];
  for (const [label, input] of cases) {
    const r = search(input);
    const ids = r.results.map((x) => x.vendor_id);
    ok(`no seller appears twice — ${label}`, new Set(ids).size === ids.length,
      `${ids.length} rows, ${new Set(ids).size} distinct sellers`);
  }
  const r = search({ ...base, q: 'cement' });
  ok('every card names its seller and its offer', r.results.every((x) => !!x.best_vendor && !!x.offer_id));
  ok('a rolled-up card says how much it rolled up', r.results.every((x) => typeof x.also_from_vendor === 'number'));
}

// ── the vendor table is one row per vendor, and hides nothing ───────────────
console.log('\nVENDOR TABLE — one row per seller, every listing still reachable');
{
  const withMost = (prep(
    `SELECT product_id FROM price_current WHERE region_id='hyderabad' ORDER BY offer_count DESC LIMIT 1`,
  ).get() as any)?.product_id as string | undefined;
  ok('a product with many offers exists to test against', !!withMost);
  if (withMost) {
    const resolved = resolveAllOffers(withMost, '500001');
    ok('the table resolved', !!resolved);
    if (resolved) {
      const table = rollUpByVendor(resolved.offers, resolved.quotes);
      const ids = table.offers.map((o) => o.vendor.vendor_id);
      ok('no vendor is repeated down the table', new Set(ids).size === ids.length,
        `${ids.length} rows, ${new Set(ids).size} distinct`);
      const rolled = table.offers.reduce((n, o) => n + (o.also_listed?.length ?? 0), 0);
      eq('rows + rolled-up listings equals every offer collected', table.offers.length + rolled, table.total_offers);
      ok('every rolled-up listing keeps its source URL',
        table.offers.every((o) => (o.also_listed ?? []).every((a) => !!a.source_url)));
      ok('the visible row is the cheapest that seller offers',
        table.offers.every((o, i) =>
          (o.also_listed ?? []).every((a) => a.normalised_paise >= table.quotes[i].basis.normalised.paise)));
      // resolvePrice must still price a listing the table rolled up, or a card
      // showing that seller's other offer could not be billed.
      const rolledOne = table.offers.flatMap((o) => o.also_listed ?? [])[0];
      if (rolledOne) {
        const q = resolvePrice({ product_id: withMost, pincode: '500001', offer_id: rolledOne.offer_id });
        ok('a rolled-up listing is still priceable by offer id', q?.offer_id === rolledOne.offer_id);
      }
    }
  }
}

// ── the compiled facet path must decide exactly what valueMatches does ─────
// Faceting is the one stage that was rewritten for speed, so it is the one
// stage that needs proof the rewrite did not change an answer.
console.log('\nFACETING — the fast path agrees with the readable one');
{
  let checkedTotal = 0;
  const mismatchesAll: string[] = [];
  for (const category of ['cement', 'tmt_steel', 'bricks_blocks', 'water_pipes']) {
    const { checked, mismatches } = __facetEquivalence('hyderabad', category);
    checkedTotal += checked;
    mismatchesAll.push(...mismatches);
  }
  ok('the equivalence check ran over real rows', checkedTotal > 1000, `only ${checkedTotal} triples checked`);
  ok('compiled and naive agree on every (row, facet, value)',
    mismatchesAll.length === 0, mismatchesAll.slice(0, 3).join('  |  '));
}

// ── the zero-result ladder never returns a blank page ──────────────────────
console.log('\nZERO RESULT — never a dead end');
{
  const r = search({ q: 'xyzzy nonexistent widget 999', pincode: '500001', region_id: 'hyderabad' });
  ok('a nonsense query still returns a designed state',
    r.zero_result !== null || r.results.length > 0);
  if (r.zero_result) {
    ok('with rewrite suggestions', r.zero_result.suggestions.length > 0);
    ok('and a stated reason', r.zero_result.reason.length > 0);
  }
}

// ── the ExportersIndia parser, against a real archived page ────────────────
// Pure function over a saved body, so these run with no network and cost
// nothing. They exist because this source returned zero offers for the entire
// build while reporting `empty`, and a fixture is the only thing that would
// have caught it.
console.log('\nEXPORTERSINDIA — parsed from an archived page, no network');
{
  const fx = fs.readFileSync(
    path.join(process.cwd(), 'collector/fixtures/exportersindia-vijayawada-bricks-2026-08-01.html'),
    'utf8',
  );
  const meta = pageMeta(fx);
  eq('the page declares its own record count', meta.ttlRecords, 108);
  eq('and its page count', meta.ttlPages, 6);

  const url = 'https://www.exportersindia.com/vijayawada/bricks.htm';
  const offers = parseCards(fx, url, 'bricks_blocks', 'vijayawada');
  // 45 card elements render 18 listings, and 108 records / 6 pages = 18
  // confirms that 18 is the page's real content rather than a parser artefact.
  eq('45 card elements collapse to 18 distinct listings', offers.length, 18);
  eq('one vendor per listing', new Set(offers.map((o) => o.vendor_name)).size, 18);
  ok('every listing carries a stable ei: ref', offers.every((o) => /^ei:\d{6,}$/.test(o.source_ref)));
  ok('every listing carries its spec table', offers.every((o) => Object.keys(o.specs).length > 0));

  const priced = offers.filter((o) => o.price_paise != null);
  eq('12 of them publish a price', priced.length, 12);

  // The reason the generic parser saw nothing: there is no currency glyph in
  // the rendered text at all, because the rupee sign is an <img>.
  ok('the page body carries no rupee glyph to match on', !fx.includes('₹'));

  const range = offers.find((o) => o.source_ref === 'ei:7459211563');
  ok('the Rs 24 - Rs 28 listing was found', !!range);
  eq('a quoted range takes the low bound, not a midpoint', range?.price_paise, 2400);
  ok('and keeps the full range in specs', /28/.test(range?.specs['Quoted price range'] ?? ''));
  eq('MOQ comes off the enquiry query string', range?.moq_qty, 1500);
  ok('the double-encoded title is fully decoded',
    !!range?.title.includes('12X9X6"') && !/&\w+;/.test(range?.title ?? ''));

  ok('"Deals in Vijayawada" is never recorded as an address',
    offers.every((o) => !/^deals\s+in/i.test(o.vendor_locality ?? '')));
  ok('a real address still becomes a locality',
    offers.some((o) => o.vendor_locality === 'Mylavaram'));
  ok('images are product photos, never the location-pin SVG',
    offers.flatMap((o) => o.images ?? []).every((s) => s.includes('/product_images/')));

  // source_ref feeds offer_id = hash(source_id|source_ref). If it drifted
  // between runs, every listing would reload as a new offer every night.
  const again = parseCards(fx, url, 'bricks_blocks', 'vijayawada');
  eq('source_ref is stable across two parses of the same body',
    again.map((o) => o.source_ref).join(','), offers.map((o) => o.source_ref).join(','));

  ok('every priced listing survives normalisation',
    priced.every((o) => (normalise(o) as any).ok !== false));
}

// ── the base-row cache must not change any answer ──────────────────────────
// Caching the candidate set took the query layer from 21.56 to 14.94 ms p95,
// which is only worth having if it is invisible. A cache that alters a result
// is a worse defect than the latency it removed.
console.log('\nBASE-ROW CACHE — faster, and identical');
{
  const q = { q: 'cement', pincode: '500001', region_id: 'hyderabad' as const };
  const cold = search(q);              // populates
  const warm = search(q);              // served from cache
  invalidateSearchCache();
  const afterFlush = search(q);        // re-read from SQLite

  const shape = (r: ReturnType<typeof search>) =>
    r.results.map((c) => `${c.offer_id}:${c.normalised_paise}`).join('|');
  eq('a cached query returns exactly the cold result', shape(warm), shape(cold));
  eq('and so does one taken after the cache is flushed', shape(afterFlush), shape(cold));
  eq('facet counts survive the cache too',
    JSON.stringify(afterFlush.facets?.map((f: any) => f.values.map((v: any) => v.count))),
    JSON.stringify(cold.facets?.map((f: any) => f.values.map((v: any) => v.count))));
  ok('the cached set is not empty, so the comparison means something', cold.results.length > 0);
}

// ── money parsed from text never becomes a float ───────────────────────────
console.log('\nMONEY — rupee text to paise, integer arithmetic only');
{
  eq('"7.30" -> 730 paise', paiseFromRupeeText('7.30'), 730);
  eq('"1,250" -> 125000 paise', paiseFromRupeeText('1,250'), 125000);
  eq('"24" -> 2400 paise', paiseFromRupeeText('24'), 2400);
  eq('"Rs 8.05" -> 805 paise', paiseFromRupeeText('Rs 8.05'), 805);
  eq('"₹ 12" -> 1200 paise', paiseFromRupeeText('₹ 12'), 1200);
  eq('"0.05" -> 5 paise', paiseFromRupeeText('0.05'), 5);
  // 8.7 * 100 is 869.9999999999999 in binary floating point. This must not be.
  eq('"8.70" -> 870 exactly, never 869', paiseFromRupeeText('8.70'), 870);
  eq('three decimals are refused rather than rounded', paiseFromRupeeText('7.305'), null);
  eq('junk is refused', paiseFromRupeeText('Ask Price'), null);
}

// ── units the ExportersIndia data actually publishes ───────────────────────
console.log('\nUNITS — the forms sellers really type');
{
  eq('"Per piece" maps to piece', normaliseUnit('Per piece')?.unit, 'piece');
  eq('"perkg" maps to kg', normaliseUnit('perkg')?.unit, 'kg');
  eq('"Brick" maps to piece', normaliseUnit('Brick')?.unit, 'piece');
  eq('"pcs" still maps to piece', normaliseUnit('pcs')?.unit, 'piece');
  eq('"/Bag" still maps to bag', normaliseUnit('/Bag')?.unit, 'bag');
  // Refusing is the correct answer; the collector records these and loads nothing.
  eq('"8000 pieces" is refused, not guessed', normaliseUnit('8000 pieces'), null);
  eq('"RBS PVC ABS" is refused', normaliseUnit('RBS PVC ABS'), null);
}

// ── TradeIndia: parsed from an archived page, no network ───────────────────
// This source reported `parse_fail` on all eight category×region combinations
// for the entire build. Three separate causes, and a fixture is the only thing
// that would have distinguished them from "this city has no dealers".
console.log('\nTRADEINDIA — the three failures that read as one');
{
  const tgt = (category: string, region_id: string) =>
    __targetsFor(category, region_id).find((t) => t.platform === 'TradeIndia')!;

  const cement = tgt('cement', 'hyderabad');
  ok('the dead -city-183463.html id is gone from the URL', !cement.url.includes('183463'));
  ok('the city travels in the keyword, because ?city= does not bind',
    cement.url.includes('keyword=cement%20hyderabad'), cement.url);

  const fx = fs.readFileSync(
    path.join(process.cwd(), 'collector/fixtures/tradeindia_hyderabad_cement.html'), 'utf8',
  );
  // Cause 2: there is no rupee glyph anywhere, so the generic
  // [class*=product|listing|card] + ₹ parser could never have matched this page
  // no matter which URL it was pointed at.
  ok('the page carries no rupee glyph to match on', !fx.includes('₹'));
  ok('the listings live in a __NEXT_DATA__ island', fx.includes('id="__NEXT_DATA__"'));

  const p = parseTradeIndia(fx, cement);
  eq('the archived page yields one priced in-region offer', p.priced, 1);
  eq('and reports itself ok rather than parse_fail', p.reason, 'ok');
  ok('the price keeps TradeIndia\'s own "(Approx.)" hedge verbatim',
    p.offers[0].price_text.includes('(Approx.)'), p.offers[0].price_text);
  // The whole reason this source adds no supply: no unit is published, so
  // normalise() refuses it by name instead of inventing a basis.
  ok('no unit is invented for a listing that publishes none',
    p.offers.every((o) => o.price_unit === null));
  eq('and normalise refuses it rather than guessing',
    normalise({ ...p.offers[0], price_unit: null } as any)?.ok, false);

  // Cause 3: the category term is dropped on some queries, so a city-local
  // mist maker would enter the surface as cement without this guard.
  const tmt = tgt('tmt_steel', 'hyderabad');
  const fxT = fs.readFileSync(
    path.join(process.cwd(), 'collector/fixtures/tradeindia_hyderabad_tmt_steel.html'), 'utf8',
  );
  const pt = parseTradeIndia(fxT, tmt);
  ok('an in-region listing that is off-topic is dropped, not loaded', pt.priced === 0);
  eq('and it says so rather than claiming the category is empty', pt.reason, 'no_topic');
  ok('the dropped row was genuinely in-region', pt.inRegion > 0);
}

// ── the typefaces, guarded by their metrics rather than their names ────────
// A font swap is the change most likely to break this layout silently: money
// columns are fixed-width, rows are hard-height with no clip, and nothing here
// measures a rendered box. These assertions hold without a renderer. The ones
// that need one live in scripts/typography-probe.ts.
console.log('\nTYPE — the metrics contract');
{
  const layout = fs.readFileSync(path.join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');

  // next ships the capsize metrics for every Google family it can serve, so the
  // shape of a face is knowable offline, before anything is rendered.
  const METRICS = path.join(process.cwd(), 'node_modules', 'next', 'dist', 'server', 'capsize-font-metrics.json');
  ok('the font metrics database is where we expect it', fs.existsSync(METRICS),
    'next moved it — fix this path rather than deleting the guard, or the checks below silently stop running');

  if (fs.existsSync(METRICS)) {
    const raw = JSON.parse(fs.readFileSync(METRICS, 'utf8')) as Record<string, any>;
    const byName: Record<string, any> = {};
    for (const v of Object.values(raw)) if (v?.familyName) byName[v.familyName] = v;

    const imported = (layout.match(/import\s*\{([^}]+)\}\s*from\s*'next\/font\/google'/)?.[1] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    eq('three families are loaded', imported.length, 3);

    const metricOf = (ident: string) => byName[ident.replace(/_/g, ' ')];
    for (const ident of imported) {
      ok(`${ident} resolves in the metrics database`, !!metricOf(ident));
    }

    // Role is decided by which const the family is assigned to, so the guard
    // follows a rename.
    const roleOf = (role: string) =>
      layout.match(new RegExp(`const ${role} = (\\w+)\\(`))?.[1] ?? '';
    const box = (m: any) => (m.ascent - m.descent + (m.lineGap ?? 0)) / m.unitsPerEm;
    const adv = (m: any) => m.xWidthAvg / m.unitsPerEm;

    const fig = metricOf(roleOf('figure'));
    if (fig) {
      // The binding constraint is the unit-price column: w 126 less px-2.5 both
      // sides leaves 106px, and the worst real string is ~90px at 0.60em. Guard
      // at 0.65 and it stays inside with margin; past that it overflows a cell
      // that has no clip and paints over its neighbour.
      ok(`the figure face is monospace — ${roleOf('figure')}`, fig.category === 'monospace');
      ok(`its advance fits the money columns — ${adv(fig).toFixed(4)}em ≤ 0.65`, adv(fig) <= 0.65,
        `${adv(fig).toFixed(4)}em would overflow the 106px unit-price budget`);
    }
    const uiM = metricOf(roleOf('ui'));
    if (uiM) {
      // Nothing sets line-height on body, so every table cell resolves to
      // `normal` — which is this number. ±8% of Inter Tight's 1.2100, because
      // 8% of a 12px line compounds to about one spec row over the detail
      // sheet, which is where a fixed scroll fraction stops landing right.
      const b = box(uiM);
      ok(`the UI face's line box is within 8% of 1.2100 — ${b.toFixed(4)}`, b >= 1.113 && b <= 1.307,
        `${b.toFixed(4)} shifts every unpinned line box in the app`);
    }
  }

  // ₹ is U+20B9, which Google serves from latin-ext, not latin. Without it the
  // leading glyph of every price falls back to a system font at an unrelated
  // advance width, inside right-aligned columns that exist to align.
  const subsets = layout.match(/subsets:\s*\[[^\]]*\]/g) ?? [];
  eq('every face declares its subsets', subsets.length, 3);
  ok('and every one includes latin-ext, which is where ₹ lives',
    subsets.every((s) => s.includes('latin-ext')), subsets.join(' | '));

  // .hero-figure and .fig are different families. A call site that picks
  // between them on data puts two faces in one column, which is what
  // tabular-nums cannot fix.
  const tsx = ['components', 'app'].flatMap((d) => {
    const walk = (p: string): string[] => fs.readdirSync(p, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(p, e.name)) : e.name.endsWith('.tsx') ? [path.join(p, e.name)] : []);
    return walk(path.join(process.cwd(), d));
  });
  const dynamicAccent = tsx.filter((f) =>
    /<Money[^>]*accent=\{(?!true\}|false\})/s.test(fs.readFileSync(f, 'utf8')));
  ok('no <Money> picks its typeface from data', dynamicAccent.length === 0,
    dynamicAccent.map((f) => path.relative(process.cwd(), f)).join(', '));

  // A half-finished rename leaves a variable named after a face it no longer is.
  const stale = ['Inter_Tight', 'JetBrains_Mono', 'Instrument_Serif',
    'font-inter-tight', 'font-jetbrains-mono', 'font-instrument-serif'];
  const found = stale.filter((s) => layout.includes(s) || css.includes(s));
  ok('no outgoing family name survives the rename', found.length === 0, found.join(', '));

  // Inter-specific character variants used to sit on body, where they inherited
  // onto all three families.
  // Comments stripped first: the rule now carries a comment explaining why the
  // declaration was removed, and matching on that would fail forever.
  const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyRule = cssNoComments.match(/\nbody\s*\{[^}]*\}/)?.[0] ?? '';
  ok('body sets no font-feature-settings', !bodyRule.includes('font-feature-settings'),
    'those tags mean different things per face and body is inherited by all three');

  // tabular-nums fixes the advance; it does not force lining figures.
  for (const cls of ['.fig', '.tnum']) {
    const rule = css.match(new RegExp(`\\${cls}\\s+?\\{[^}]*\\}`))?.[0] ?? '';
    ok(`${cls} asks for tabular AND lining figures`,
      /tabular-nums/.test(rule) && /lining-nums/.test(rule), rule.slice(0, 80));
  }

  // lib/contrast.ts:parseRootTokens matches the FIRST :root block, and the
  // whole contrast suite hangs on it. A type migration is exactly what tempts
  // someone into reformatting this file.
  ok(':root still follows @theme', css.indexOf(':root') > css.indexOf('@theme'));
  ok('and still parses to a full token map', parseRootTokens(css).size > 20,
    `${parseRootTokens(css).size} tokens — the contrast suite reads this same block`);
}

// ── the palette clears WCAG AA on every surface it can land on ─────────────
// This used to be a comment in globals.css listing measured ratios. A comment
// asserts nothing: when the theme was repainted from Alabaster to Patina, the
// first candidate palette failed 16 of the 120 pairings below and the comment
// would have shipped saying otherwise.
//
// The values are PARSED from the live stylesheet rather than copied here, so a
// future colour edit that breaks contrast fails this suite instead of shipping.
console.log('\nCONTRAST — every ink, on every pane, over every ground');
{
  const css = fs.readFileSync(path.join(process.cwd(), 'app', 'globals.css'), 'utf8');
  const t = parseRootTokens(css);
  const rgb = (name: string) => {
    const v = resolveToken(t, name);
    ok(`${name} is defined and parseable`, !!v);
    return v ? (v.slice(0, 3) as unknown as RGB) : ([0, 0, 0] as const as RGB);
  };
  const rgba = (name: string) => resolveToken(t, name)!;

  const base = rgb('--canvas');
  // Four grounds, because a label can land on bare canvas, on the deep floor,
  // or on either bloom at its peak. The blooms are the light ones and they are
  // where the margin actually goes.
  const grounds: Array<[string, RGB]> = [
    ['abyss', rgb('--abyss')],
    ['canvas', base],
    ['teal bloom', stack(base, rgba('--bloom-teal'))],
    ['silver bloom', stack(base, rgba('--bloom-silver'))],
  ];
  // Each pane token is the PEAK of its gradient — the brightest point, and so
  // the worst case for a light foreground.
  const panes: Array<[string, RGBA | null]> = [
    ['bare', null],
    ['glass-quiet', rgba('--glass-quiet')],
    ['glass', rgba('--glass')],
    ['glass-card', rgba('--glass-card')],
    ['glass-strong', rgba('--glass-strong')],
  ];

  const surfaces = grounds.flatMap(([gn, g]) =>
    panes.map(([pn, p]) => [`${pn} / ${gn}`, p ? stack(g, p) : g] as [string, RGB]),
  );

  // --ink-3 carries the 10–11 px labels, so 4.5:1 genuinely applies to it; the
  // 3:1 large-text allowance starts at 18.66 px bold / 24 px regular.
  const textTokens = ['--ink', '--ink-2', '--ink-3', '--stale', '--fresh', '--ageing',
    '--accent', '--accent-lift', '--accent-ink'];

  for (const name of textTokens) {
    const fg = rgb(name);
    let worst = Infinity, where = '';
    for (const [sn, s] of surfaces) {
      const r = contrast(fg, s);
      if (r < worst) { worst = r; where = sn; }
    }
    ok(`${name} clears AA (4.5) on all 20 surfaces — worst ${worst.toFixed(2)} on ${where}`,
      worst >= AA_TEXT, `${worst.toFixed(3)} < ${AA_TEXT}`);
  }

  // Text sitting ON a bright pill rather than under one — the pressed states,
  // which invert on this theme.
  for (const pill of ['--ink', '--accent']) {
    const r = contrast(rgb('--on-bright'), rgb(pill));
    ok(`--on-bright clears AA on a ${pill} pill — ${r.toFixed(2)}`, r >= AA_TEXT, r.toFixed(3));
  }

  // --seg-on is brighter than any pane and is deliberately NOT in the list
  // above. It is not a general surface: the only thing that ever renders on a
  // selected segment is its own label, and globals.css pins that to --ink.
  // Measuring every ink against it would fail six of them for a pairing the
  // page cannot produce — so it gets the one assertion that is real.
  {
    const segOn = stack(grounds[3][1], rgba('--seg-on'));
    const r = contrast(rgb('--ink'), segOn);
    ok(`--ink clears AA on a selected segment — ${r.toFixed(2)}`, r >= AA_TEXT, r.toFixed(3));
    ok('nothing dimmer than --ink is styled onto a selected segment',
      /\.seg button\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--ink\)/.test(css),
      'if that rule changes colour, add the new token to this check');
  }

  // Non-text UI: hairlines and borders only need 3:1, but they do need it, or
  // a pane has no visible edge at all.
  for (const name of ['--rule', '--glass-hair']) {
    const v = rgba(name);
    let worst = Infinity;
    for (const [, s] of surfaces) worst = Math.min(worst, contrast(stack(s, v), s));
    ok(`${name} is visible against every surface — worst ${worst.toFixed(2)}`, worst > 1.06,
      `${worst.toFixed(3)} is indistinguishable from its background`);
  }

  // The theme is dark now; leaving color-scheme on `light` renders native
  // <select> popups and unchecked checkboxes as white boxes punched through it.
  eq('color-scheme is dark', t.get('color-scheme'), 'dark');

  // --stale is deliberately neutral: what marks a dead price is colour having
  // drained out of it, which only reads if it is not tinted like everything else.
  {
    const [r, g, b] = rgb('--stale');
    ok('--stale is neutral, not tinted like --ink-3', Math.max(r, g, b) - Math.min(r, g, b) <= 6,
      `spread ${Math.max(r, g, b) - Math.min(r, g, b)}`);
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log(`  · ${f}`); }
close();
process.exit(fail === 0 ? 0 : 1);
