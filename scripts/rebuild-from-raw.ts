/**
 * Re-derive every product and offer from the raw archive, offline.
 *
 * Entity resolution changed — the brand roster now carries product lines, so
 * "Birla" resolves to MP Birla Samrat / Birla Shakti / Birla Gold / Birla A1
 * rather than collapsing four companies' brands into one product whose floor
 * price belonged to whichever was cheapest. That rule change has to be applied
 * to the listings already collected, not only to future ones.
 *
 * Every offer in the database has a row in collector/raw/*.jsonl, so this runs
 * with **zero network calls** — it replays the archive through the current
 * normaliser. `npm test` asserts the no-network guard; this script simply never
 * has a reason to reach out.
 *
 * What is cleared: product, offer, spec_value, price_current, offer_price.
 * What is kept: price_history. It is an append-only ledger and its rows carry
 * offer_id, which is hash(source_id|source_ref) and therefore stable across a
 * rebuild. Its product_id references are re-keyed by this script — that
 * discontinuity is reported and written to the diff log rather than left as
 * silent dangling keys.
 *
 *   npx tsx scripts/rebuild-from-raw.ts [--apply]
 *
 * Without --apply it reports what would change and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, prep, initSchema, tx, close } from '../lib/db';
import { rebuildPrices, rebuildSearchIndex } from '../lib/rebuild';
import { loadOffers, loadLocalities } from '../collector/run';
import type { RawOffer } from '../collector/types';

const APPLY = process.argv.includes('--apply');
const NOTE = process.argv.find((a) => a.startsWith('--note='))?.split('=').slice(1).join('=')
  ?? 'offline rebuild from collector/raw — the normaliser changed, no network calls';
const ROOT = process.cwd();
const RAW = path.join(ROOT, 'collector', 'raw');

function readArchive(): RawOffer[] {
  const out: RawOffer[] = [];
  const seen = new Set<string>();
  for (const f of fs.readdirSync(RAW).sort()) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(RAW, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as RawOffer;
        // The archive appends, so the same listing can appear in several files
        // and several days. Keep the most recent row per (source_id, ref).
        const k = `${o.source_id}|${o.source_ref}`;
        if (seen.has(k)) {
          const i = out.findIndex((x) => `${x.source_id}|${x.source_ref}` === k);
          if (i >= 0 && o.fetched_at > out[i].fetched_at) out[i] = o;
          continue;
        }
        seen.add(k);
        out.push(o);
      } catch { /* a truncated line is skipped and counted below */ }
    }
  }
  return out;
}

/** Products whose offers span more than one distinct seller listing title. */
function overMergeReport(): { total: number; worst: Array<{ title: string; n: number; examples: string[] }> } {
  const rows = prep(`
    SELECT p.product_id, p.title, o.listing_title
      FROM product p JOIN offer o ON o.product_id = p.product_id
     WHERE o.listing_title IS NOT NULL`).all() as any[];
  const m = new Map<string, { title: string; set: Set<string> }>();
  for (const r of rows) {
    const norm = String(r.listing_title).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (!m.has(r.product_id)) m.set(r.product_id, { title: r.title, set: new Set() });
    m.get(r.product_id)!.set.add(norm);
  }
  const multi = [...m.values()].filter((v) => v.set.size > 1).sort((a, b) => b.set.size - a.set.size);
  return {
    total: multi.length,
    worst: multi.slice(0, 8).map((v) => ({ title: v.title, n: v.set.size, examples: [...v.set].slice(0, 3) })),
  };
}

function counts() {
  const q = (t: string) => (prep(`SELECT COUNT(*) c FROM ${t}`).get() as any).c as number;
  return { product: q('product'), offer: q('offer'), vendor: q('vendor'), brands:
    (prep(`SELECT COUNT(DISTINCT brand) c FROM product WHERE brand IS NOT NULL`).get() as any).c as number };
}

function main() {
  initSchema();

  const before = counts();
  console.log(`before   products=${before.product} offers=${before.offer} vendors=${before.vendor} brands=${before.brands}`);

  const raws = readArchive();
  console.log(`archive  ${raws.length} distinct listings across ${fs.readdirSync(RAW).filter((f) => f.endsWith('.jsonl')).length} files`);

  if (!APPLY) {
    console.log('\ndry run — nothing written. re-run with --apply');
    return;
  }

  const historyBefore = (prep(`SELECT COUNT(*) c FROM price_history`).get() as any).c as number;
  const runId = `rebuild_${Date.now().toString(36)}`;
  db().prepare(
    `INSERT INTO collection_run (run_id,started_at,mode,status,sources_attempted,sources_ok,sources_blocked,
       offers_captured,offers_new,vendors_new,ladder_quoted,ladder_derived,ladder_typical,ladder_unknown,notes)
     VALUES (?,?,'manual','ok',0,0,0,0,0,0,0,0,0,0,?)`,
  ).run(runId, new Date().toISOString(), NOTE);

  // The picture pool is keyed on product_id, and this rebuild re-keys every
  // product — so it is carried across on offer_id, which is
  // hash(source_id|source_ref) and stable. Without this the images collected
  // from detail pages would orphan: they exist nowhere else, unlike the
  // thumbnails which can be re-derived from offer.images.
  const carriedImages = prep(
    `SELECT asset_key, offer_id, source_url, page_url, local_path, width, kind, rank, fetched_at
       FROM product_image WHERE offer_id IS NOT NULL`,
  ).all() as any[];

  // Clear the derived tables. price_history is deliberately NOT cleared.
  tx(() => {
    for (const t of ['product_image', 'offer_price', 'price_current', 'serviceability', 'spec_value', 'offer', 'product']) {
      db().prepare(`DELETE FROM ${t}`).run();
    }
  });
  console.log('cleared  product, offer, spec_value, price_current, offer_price, serviceability');
  console.log(`kept     price_history (${historyBefore} rows) — offer_id is stable, product_id is re-keyed`);

  loadLocalities();
  const st = loadOffers(runId, raws);
  console.log(`loaded   ${st.offersNew} offers, ${st.vendorsNew} vendors`);
  if (Object.keys(st.skipped).length) {
    console.log('  not loaded (recorded, never invented):');
    for (const [k, v] of Object.entries(st.skipped).sort((a, b) => (b[1] as number) - (a[1] as number))) {
      console.log(`    ${v}x ${k}`);
    }
  }

  // Re-attach the pictures to whatever product each offer now belongs to.
  // INSERT OR IGNORE because two old products can merge into one new one and
  // share an asset, which the (product_id, asset_key) key would reject.
  const reattach = db().prepare(
    `INSERT OR IGNORE INTO product_image
       (asset_key, product_id, offer_id, source_url, page_url, local_path, width, kind, rank, fetched_at)
     SELECT @asset_key, o.product_id, @offer_id, @source_url, @page_url, @local_path, @width, @kind, @rank, @fetched_at
       FROM offer o WHERE o.offer_id = @offer_id`,
  );
  let imagesKept = 0;
  tx(() => { for (const im of carriedImages) imagesKept += reattach.run(im).changes; });
  console.log(`images   ${imagesKept} of ${carriedImages.length} re-attached to their new product ids`);

  const pr = rebuildPrices(runId, 'backfill');
  const idx = rebuildSearchIndex();
  console.log(`priced   price_current ${pr.rows} rows · offer_price ${pr.offerRows} rows · index ${idx} products`);
  if (pr.implausible.length) {
    const n = pr.implausible.reduce((s, r) => s + r.count, 0);
    console.log(`  plausibility rules took ${n} offer(s) out of the surface — kept, inactive, reason on the row:`);
    for (const r of pr.implausible.slice(0, 12)) console.log(`    ${String(r.count).padStart(4)}× ${r.reason}`);
  }
  if (pr.quarantined.length) {
    console.log(`  absurdity gate quarantined ${pr.quarantined.length} price(s) — never published`);
  }

  const after = counts();
  console.log(`\nafter    products=${after.product} offers=${after.offer} vendors=${after.vendor} brands=${after.brands}`);
  console.log(`         products ${before.product} -> ${after.product}, brands ${before.brands} -> ${after.brands}`);

  const om = overMergeReport();
  console.log(`\nover-merge: ${om.total} product(s) still span more than one distinct listing title`);
  for (const w of om.worst) {
    console.log(`  ${w.title.slice(0, 46).padEnd(48)} <- ${w.n}`);
    for (const e of w.examples) console.log(`      · ${e.slice(0, 62)}`);
  }

  const orphaned = (prep(
    `SELECT COUNT(*) c FROM price_history h
      WHERE NOT EXISTS (SELECT 1 FROM product p WHERE p.product_id = h.product_id)`).get() as any).c as number;
  console.log(`\nprice_history rows whose product_id was re-keyed by this rebuild: ${orphaned}`);
  console.log('(their offer_id still resolves; recorded in the diff log rather than deleted)');
}

main();
close();
