/**
 * Print every dataset number the README publishes, measured.
 *
 * The README's coverage table, picture buckets and totals are transcribed from
 * this output rather than assembled by hand, because a hand-maintained table is
 * how a document quietly drifts away from the database it describes. Run it
 * after any collection or rebuild and copy the numbers across.
 *
 *   npx tsx scripts/coverage.ts
 */
import { prep, close } from '../lib/db';

const CATS = ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'] as const;
const REGIONS = ['hyderabad', 'vijayawada'] as const;

// ── coverage against the floor ───────────────────────────────────────────────
// Counted per REGION off offer_price, because that is the supply a search in
// that city can actually reach. Counting by the vendor's own city instead would
// credit a Hyderabad seller who delivers to Vijayawada to neither or both.
const region = prep(`
  SELECT p.category AS category, op.region_id AS region,
         COUNT(DISTINCT op.offer_id)  AS offers,
         COUNT(DISTINCT o.vendor_id)  AS vendors,
         COUNT(DISTINCT p.brand)      AS brands,
         COUNT(DISTINCT v.platform)   AS platforms
    FROM offer_price op
    JOIN offer o   ON o.offer_id  = op.offer_id
    JOIN product p ON p.product_id = op.product_id
    JOIN vendor v  ON v.vendor_id  = o.vendor_id
   GROUP BY p.category, op.region_id`).all() as any[];

const cell = (c: string, r: string) =>
  region.find((x) => x.category === c && x.region === r) ??
  { offers: 0, vendors: 0, brands: 0, platforms: 0 };

console.log('COVERAGE  (floor: >=25 offers per category per city, >=6 brands, >=4 platforms)\n');
console.log('category         offers H/V     vendors H/V   brands H/V   platforms   floor');
for (const c of CATS) {
  const h = cell(c, 'hyderabad'), v = cell(c, 'vijayawada');
  const miss: string[] = [];
  if (h.offers < 25 || v.offers < 25) miss.push('offers');
  if (Math.max(h.brands, v.brands) < 6) miss.push('brands');
  if (Math.max(h.platforms, v.platforms) < 4) miss.push('platforms');
  if (Math.max(h.vendors, v.vendors) < 2) miss.push('vendors');
  console.log(
    `${c.padEnd(15)} ${`${h.offers} / ${v.offers}`.padEnd(14)} ${`${h.vendors} / ${v.vendors}`.padEnd(13)}` +
    ` ${`${h.brands} / ${v.brands}`.padEnd(12)} ${String(Math.max(h.platforms, v.platforms)).padEnd(11)}` +
    ` ${miss.length ? miss.join(', ') + ' short' : 'met'}`,
  );
}

const tot = prep(`
  SELECT (SELECT COUNT(*) FROM offer)   AS offers,
         (SELECT COUNT(*) FROM product) AS products,
         (SELECT COUNT(*) FROM vendor)  AS vendors,
         (SELECT COUNT(DISTINCT brand) FROM product WHERE brand IS NOT NULL) AS brands,
         (SELECT COUNT(DISTINCT platform) FROM vendor) AS platforms`).get() as any;
console.log(`\ntotals: ${tot.offers} offers · ${tot.products} products · ${tot.vendors} vendors · ` +
  `${tot.brands} brands · ${tot.platforms} platforms`);

// ── brands actually resolved, per category ───────────────────────────────────
const brands = prep(`
  SELECT p.category AS category, p.brand AS brand, COUNT(DISTINCT o.offer_id) AS n
    FROM offer o JOIN product p ON p.product_id = o.product_id
   WHERE p.brand IS NOT NULL GROUP BY p.category, p.brand ORDER BY n DESC, p.brand`).all() as any[];
const branded = prep(`
  SELECT p.category AS category,
         SUM(CASE WHEN p.brand IS NOT NULL THEN 1 ELSE 0 END) AS with_brand,
         COUNT(*) AS total
    FROM offer o JOIN product p ON p.product_id = o.product_id
   GROUP BY p.category`).all() as any[];

console.log('\nBRANDS RESOLVED');
for (const c of CATS) {
  const b = brands.filter((x) => x.category === c);
  const cov = branded.find((x) => x.category === c);
  const pct = cov ? ((cov.with_brand / cov.total) * 100).toFixed(0) : '0';
  console.log(`\n  ${c} — ${b.length} brands over ${pct}% of offers`);
  console.log(`    ${b.map((x) => `${x.brand}(${x.n})`).join(', ') || '(none)'}`);
}

// ── picture pool ─────────────────────────────────────────────────────────────
// Bucketed per OFFER, because the results list is one card per vendor, so a
// card is a seller's listing. scripts/collect-images.ts buckets the same way;
// counting per product here would quietly disagree with the tool of record.
// Datasheet scans are excluded — they are deliberately kept out of the gallery.
const pics = prep(`
  SELECT o.offer_id AS id,
         (SELECT COUNT(*) FROM product_image i
           WHERE i.product_id = o.product_id AND i.kind = 'photo') AS n
    FROM offer o`).all() as any[];
const capped = pics.map((r) => Math.min(5, r.n));
const bucket = (f: (n: number) => boolean) =>
  `${((capped.filter(f).length / capped.length) * 100).toFixed(1)}%`;
const assets = prep(`SELECT COUNT(*) c, SUM(local_path IS NOT NULL) d FROM product_image`).get() as any;
const pages = prep(`SELECT COUNT(*) c FROM image_page_log`).get() as any;
const withPics = prep(`SELECT COUNT(DISTINCT product_id) c FROM product_image WHERE kind = 'photo'`).get() as any;

console.log(`\nPICTURES  ${assets.c} assets · ${withPics.c} of ${tot.products} products carry a photo` +
  ` · ${assets.d} downloaded to public/img · ${pages.c} detail pages read`);
console.log(`  five        ${bucket((n) => n >= 5)}`);
console.log(`  rotates >=2 ${bucket((n) => n >= 2)}`);
console.log(`  exactly one ${bucket((n) => n === 1)}`);
console.log(`  none        ${bucket((n) => n === 0)}`);

close();
