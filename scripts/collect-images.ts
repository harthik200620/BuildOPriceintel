/**
 * Product photography — collected offline, stored locally.
 *
 * The card rotates up to five pictures on hover, which only works if five
 * exist. The collector had been keeping exactly one image per listing (the
 * directory card's thumbnail), so this fills the pool from three places, in
 * increasing order of cost:
 *
 *   1. What is already in `offer.images`, deduplicated properly and upgraded to
 *      a larger variant. imimg serves the same photograph at 125/250/500/1000
 *      and bare — five URLs, one asset. Treating them as five pictures would
 *      be a rotation between identical frames, which is worse than no rotation.
 *   2. The listing's own detail page, which carries the seller's full gallery.
 *      dir.indiamart.com is rate-limited; www.indiamart.com/proddetail is not.
 *   3. Sibling offers of the same product — free, no network. This is where
 *      most of the count comes from: one seller has one photo, but twelve
 *      sellers of the same bag have twelve.
 *
 * Everything is then DOWNLOADED to public/img. The app then renders its own
 * files: no third-party request when a card is viewed, nothing to break when a
 * marketplace changes its hotlink policy, and the demo still works offline.
 *
 *   npx tsx scripts/collect-images.ts [--apply] [--pages=N] [--category=cement]
 *
 * Without --apply it reports what it would gather and writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, prep, initSchema, close } from '../lib/db';
import { fetchText } from '../collector/fetch';

const APPLY = process.argv.includes('--apply');
const MAX_PAGES = Number(process.argv.find((a) => a.startsWith('--pages='))?.split('=')[1] ?? 140);
const ONLY_CAT = process.argv.find((a) => a.startsWith('--category='))?.split('=')[1];
/**
 * The card plate is 92 px and the sheet's is 110 px, so at 2x DPR 250 px is
 * exactly enough and 500 was over-specified. It is not free: decoding 24
 * oversized JPEGs on every keystroke cost ~22 ms of the keystroke-to-paint
 * budget, and four times the bytes on disk, for pixels no one can see.
 */
const VARIANT = Number(process.argv.find((a) => a.startsWith('--px='))?.split('=')[1] ?? 250);
/** Re-fetch the files for assets already recorded, without re-reading any page. */
const REFRESH_FILES = process.argv.includes('--refresh-files');
const OUT_DIR = path.join(process.cwd(), 'public', 'img');
const NOW = new Date().toISOString();

/** Strip imimg's size suffix so every variant of one photograph collapses to one key. */
const SIZE_RE = /-(\d{2,4})x(\d{2,4})(?=\.[a-z]{3,4}$)/i;
function assetKeyOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(SIZE_RE, '').toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Prefer a variant big enough for a retina card plate without being a 1 MB original. */
function preferredVariant(url: string, width = VARIANT): string {
  return SIZE_RE.test(url) ? url.replace(SIZE_RE, `-${width}x${width}`) : url;
}

/**
 * What kind of picture is this?
 *
 * PDFImage assets are scanned datasheet pages. They are genuinely useful and
 * they belong in the detail sheet's datasheet block — not in a card's hover
 * rotation, where a buyer expects to see the product. GLADMIN assets are
 * IndiaMART's own category stock art, not this seller's goods.
 */
function kindOf(url: string): 'photo' | 'datasheet' | 'generic' {
  if (/\/PDFImage\//i.test(url)) return 'datasheet';
  if (/\/GLADMIN\//i.test(url)) return 'generic';
  return 'photo';
}

const IMG_RE = /https:\/\/[0-9]\.imimg\.com\/[^"'\\\s)]+?\.(?:jpg|jpeg|png)/gi;

function galleryFrom(html: string): string[] {
  const seen = new Map<string, string>();
  for (const raw of html.match(IMG_RE) ?? []) {
    const key = assetKeyOf(raw);
    // Keep the largest variant seen for each asset.
    const w = Number(raw.match(SIZE_RE)?.[1] ?? 0);
    const prevW = Number(seen.get(key)?.match(SIZE_RE)?.[1] ?? -1);
    if (!seen.has(key) || w > prevW) seen.set(key, raw);
  }
  return [...seen.values()];
}

interface Row { offer_id: string; product_id: string; images: string | null; source_url: string; category: string }

async function download(url: string): Promise<{ file: string; bytes: number } | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'BuildObjectsPriceIntel/0.1 (local research demo; contact harthikvarma0@gmail.com)',
        Accept: 'image/avif,image/webp,image/jpeg,image/png,*/*',
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A 43-byte "image" is a placeholder, not a photograph.
    if (buf.length < 2000) return null;
    const ext = /\.png$/i.test(new URL(url).pathname) ? 'png' : 'jpg';
    const name = `${crypto.createHash('sha1').update(assetKeyOf(url)).digest('hex').slice(0, 16)}.${ext}`;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, name), buf);
    return { file: `/img/${name}`, bytes: buf.length };
  } catch {
    return null;
  }
}

/** A file this asset already has on disk, if any. */
function existingFile(assetKey: string): string | null {
  const stem = crypto.createHash('sha1').update(assetKey).digest('hex').slice(0, 16);
  for (const ext of ['jpg', 'png']) {
    if (fs.existsSync(path.join(OUT_DIR, `${stem}.${ext}`))) return `/img/${stem}.${ext}`;
  }
  return null;
}

function logPage(url: string, assets: number) {
  db().prepare(
    `INSERT INTO image_page_log (page_url, read_at, assets_found) VALUES (?,?,?)
     ON CONFLICT(page_url) DO UPDATE SET read_at=excluded.read_at, assets_found=excluded.assets_found`,
  ).run(url, NOW, assets);
}

async function main() {
  initSchema();

  if (REFRESH_FILES) {
    const have = prep(`SELECT asset_key, source_url FROM product_image GROUP BY asset_key`).all() as
      Array<{ asset_key: string; source_url: string }>;
    console.log(`re-fetching ${have.length} assets at ${VARIANT}px…`);
    let got = 0, missed = 0, bytes = 0;
    const upd = db().prepare(`UPDATE product_image SET local_path=?, width=? WHERE asset_key=?`);
    for (const a of have) {
      const d = await download(preferredVariant(a.source_url, VARIANT));
      if (d) { upd.run(d.file, VARIANT, a.asset_key); got++; bytes += d.bytes; } else missed++;
      if ((got + missed) % 150 === 0) console.log(`  ${got} ok · ${missed} unavailable · ${(bytes / 1e6).toFixed(1)} MB`);
    }
    console.log(`done: ${got} rewritten · ${missed} unavailable · ${(bytes / 1e6).toFixed(1)} MB`);
    return;
  }

  const rows = prep(`
    SELECT o.offer_id, o.product_id, o.images, o.source_url, p.category
      FROM offer o JOIN product p ON p.product_id = o.product_id
     WHERE o.is_active = 1 ${ONLY_CAT ? 'AND p.category = ?' : ''}`)
    .all(...(ONLY_CAT ? [ONLY_CAT] : [])) as Row[];

  // ── 1. what we already hold ───────────────────────────────────────────────
  type Found = { asset_key: string; product_id: string; offer_id: string; source_url: string; page_url: string | null; kind: ReturnType<typeof kindOf>; width: number };
  const found = new Map<string, Found>();          // `${product_id}|${asset_key}`
  const add = (f: Found) => {
    const k = `${f.product_id}|${f.asset_key}`;
    const prev = found.get(k);
    if (!prev || f.width > prev.width) found.set(k, f);
  };

  // Everything already recorded, first. A rerun has to be additive: the assets
  // that came from detail pages exist only in product_image, and seeding from
  // offer.images alone would both discard them and reproduce the exact page
  // ordering of the previous run.
  for (const r of prep(
    `SELECT asset_key, product_id, offer_id, source_url, page_url, kind, width FROM product_image`,
  ).all() as any[]) {
    add({
      asset_key: r.asset_key, product_id: r.product_id, offer_id: r.offer_id,
      source_url: r.source_url, page_url: r.page_url, kind: r.kind, width: r.width ?? VARIANT,
    });
  }
  const carriedOver = found.size;

  for (const r of rows) {
    let urls: string[] = [];
    try { urls = JSON.parse(r.images || '[]') || []; } catch { /* a bad row is skipped, not guessed at */ }
    for (const u of urls) {
      add({
        asset_key: assetKeyOf(u), product_id: r.product_id, offer_id: r.offer_id,
        source_url: preferredVariant(u), page_url: r.source_url, kind: kindOf(u), width: VARIANT,
      });
    }
  }
  const fromExisting = found.size;

  // ── 2. detail pages, for the listings that have a gallery to give ─────────
  // Ordered so the products with the fewest pictures are visited first: the
  // budget should go where it changes what a card can show.
  const perProduct = new Map<string, number>();
  for (const f of found.values()) perProduct.set(f.product_id, (perProduct.get(f.product_id) ?? 0) + 1);

  const alreadyRead = new Set(
    (prep(`SELECT page_url FROM image_page_log`).all() as Array<{ page_url: string }>).map((r) => r.page_url),
  );
  const candidates = rows
    .filter((r) => /indiamart\.com\/proddetail/i.test(r.source_url))
    .filter((r) => !alreadyRead.has(r.source_url))
    .sort((a, b) => (perProduct.get(a.product_id) ?? 0) - (perProduct.get(b.product_id) ?? 0))
    .slice(0, MAX_PAGES);

  console.log(`offers: ${rows.length} · carried over from a previous run: ${carriedOver} · after offer.images: ${fromExisting}`);
  console.log(`pages already read: ${alreadyRead.size} · remaining unread: ${rows.filter((r) => /indiamart\.com\/proddetail/i.test(r.source_url) && !alreadyRead.has(r.source_url)).length}`);
  console.log(`detail pages to visit: ${candidates.length}${APPLY ? '' : '  (dry run — none will be fetched)'}`);

  let pagesOk = 0, pagesFailed = 0, fromPages = 0;
  if (APPLY) {
    for (const [i, r] of candidates.entries()) {
      const res = await fetchText(r.source_url, { retries: 1 });
      if (!res.ok) {
        pagesFailed++;
        if (res.breakerOpen) { console.log(`  circuit breaker open after ${i} pages — stopping politely`); break; }
        continue;
      }
      pagesOk++;
      const before = found.size;
      logPage(r.source_url, 0);
      for (const u of galleryFrom(res.body)) {
        add({
          asset_key: assetKeyOf(u), product_id: r.product_id, offer_id: r.offer_id,
          source_url: preferredVariant(u), page_url: r.source_url, kind: kindOf(u),
          width: VARIANT,
        });
      }
      fromPages += found.size - before;
      logPage(r.source_url, found.size - before);
      if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${candidates.length} pages · +${fromPages} new assets`);
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const photos = [...found.values()].filter((f) => f.kind === 'photo');
  const byProd = new Map<string, number>();
  for (const f of photos) byProd.set(f.product_id, (byProd.get(f.product_id) ?? 0) + 1);
  const perCard = rows.map((r) => Math.min(5, byProd.get(r.product_id) ?? 0));
  const hist: Record<string, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const n of perCard) hist[n]++;

  console.log('');
  console.log(`assets found: ${found.size}  (photo ${photos.length} · datasheet ${[...found.values()].filter((f) => f.kind === 'datasheet').length} · generic ${[...found.values()].filter((f) => f.kind === 'generic').length})`);
  if (APPLY) console.log(`detail pages: ${pagesOk} ok · ${pagesFailed} failed · ${fromPages} assets they added`);
  console.log('');
  console.log('PICTURES PER CARD (photos only, product-aggregated, capped at 5):');
  for (const k of ['0', '1', '2', '3', '4', '5']) {
    console.log(`  ${k}: ${String(hist[k]).padStart(4)}  ${(100 * hist[k] / rows.length).toFixed(1)}%`);
  }
  console.log(`  cards that can rotate (>=2): ${(100 * perCard.filter((n) => n >= 2).length / rows.length).toFixed(1)}%`);

  if (!APPLY) { console.log('\ndry run — nothing written. re-run with --apply'); return; }

  // ── download, then record ─────────────────────────────────────────────────
  console.log('\ndownloading…');
  const local = new Map<string, string>();
  let bytes = 0, got = 0, missed = 0, skipped = 0;
  const ordered = [...found.values()].sort((a, b) => (a.kind === 'photo' ? 0 : 1) - (b.kind === 'photo' ? 0 : 1));
  for (const f of ordered) {
    if (local.has(f.asset_key)) continue;
    // Already on disk from an earlier run — do not re-fetch it.
    const onDisk = existingFile(f.asset_key);
    if (onDisk) { local.set(f.asset_key, onDisk); skipped++; continue; }
    const d = await download(f.source_url);
    if (d) { local.set(f.asset_key, d.file); bytes += d.bytes; got++; } else missed++;
    if ((got + missed) % 100 === 0) console.log(`  ${got} downloaded · ${missed} unavailable · ${(bytes / 1e6).toFixed(1)} MB`);
  }
  console.log(`  ${got} downloaded · ${skipped} already on disk · ${missed} unavailable · ${(bytes / 1e6).toFixed(1)} MB new`);

  const ins = db().prepare(
    `INSERT INTO product_image (asset_key,product_id,offer_id,source_url,page_url,local_path,width,kind,rank,fetched_at)
     VALUES (@asset_key,@product_id,@offer_id,@source_url,@page_url,@local_path,@width,@kind,@rank,@fetched_at)
     ON CONFLICT(product_id, asset_key) DO UPDATE SET
       local_path=excluded.local_path, source_url=excluded.source_url,
       width=excluded.width, kind=excluded.kind, fetched_at=excluded.fetched_at`,
  );
  db().transaction(() => {
    // No DELETE: this table is the accumulated pool across runs, and the
    // PRIMARY KEY (product_id, asset_key) already makes re-insertion idempotent.
    for (const f of found.values()) {
      const lp = local.get(f.asset_key);
      if (!lp) continue;   // never record a picture we could not actually get
      ins.run({
        ...f, local_path: lp, fetched_at: NOW,
        // photo first, then datasheet; the card only ever asks for photos
        rank: f.kind === 'photo' ? 10 : f.kind === 'generic' ? 50 : 90,
      });
    }
  })();

  const stored = (prep(`SELECT COUNT(*) c FROM product_image`).get() as any).c;
  const withPhoto = (prep(`SELECT COUNT(DISTINCT product_id) c FROM product_image WHERE kind='photo'`).get() as any).c;
  console.log(`\nproduct_image: ${stored} rows · ${withPhoto} products carry at least one photo`);
}

main().then(() => close()).catch((e) => { console.error(e); process.exit(1); });
