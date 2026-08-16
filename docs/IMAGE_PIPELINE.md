# Build Objects PriceIntel — Product Image Pipeline

**Design document · 7 August 2026 · written against the repo as it stands today**

All AWS prices are **ap-south-1 (Mumbai), USD, ex-GST**, verified against the AWS Price List API on
6–7 Aug 2026. Vercel prices are **bom1** region, verified against vercel.com/docs. INR conversions
use **USD/INR = 95.2** (RBI reference, 6 Aug 2026). Every number that is an estimate rather than a
verified price is labelled as one.

> **Scale correction, added after first draft.** The first pass of this document costed the catalogue
> as 15,000 products × 5 images = 75,000 images. That undercounts a price-comparison catalogue by
> construction: **15,000 generic products, each carried by an average of 5–10 different brands, each
> brand-listing needing its own 5 images** (packaging differs by brand even when the underlying
> product doesn't). That's **15,000 × ~7.5 brands × 5 images ≈ 562,500 images** at the midpoint —
> **7.5× larger**, with a realistic range of 375,000 (low) to 750,000 (high). Every storage and
> one-time-cost figure below has been recomputed at this corrected scale. The delivery/traffic costs
> in §6 and the architecture, legal and sequencing sections are **unaffected** — they depend on
> visitor traffic and legal exposure, not catalogue size.

---

## 0. The one-page answer

You asked eight questions. Here are the eight answers, then the reasoning.

| # | Question | Answer |
|---|---|---|
| 1 | Process of fetching images | Crawl on your own box with Crawlee, HTTP-first, browser only where the DOM demands it. But **stop trying to crawl every brand site** — see §9, the 20-email move. |
| 2 | Storing the fetched images | **S3 from day one**, content-addressed by SHA-256. Not `public/img`. Not git. |
| 3 | System to manually add images | Presigned S3 upload direct from the browser → S3 event → SQS → Lambda. **This feature is impossible in your current architecture** — see §2. |
| 4 | Compression and storage | sharp/libvips → AVIF + WebP at 3 pre-generated widths; 4th width on demand. Masters kept untouched in Standard-IA. |
| 5 | Retrieving quickly | CloudFront with `immutable` cache headers. Images never touch your Next.js code. That is the entire scaling story. |
| 6 | Checking photos are relevant | 7 cheap gates, then one VLM call per image. **~$65 (₹6,150) for all 562,500.** Rekognition costs 10× more and cannot answer the question. |
| 7 | Automating after 3 months | Weekly coverage job, prioritised by search demand — fix the gaps buyers actually hit. (`search_log` needs a schema change first; see §11.) |
| 8 | Storage estimate | **~257 GB at 15,000 products × ~7.5 brands × 5 images.** Not 1 TB. **~$5/month.** |

**And the question you actually asked me at the end — 1 TB hard disk first, cloud later?**

> No. At the corrected scale — 15,000 products × ~7.5 brands average × 5 images each ≈ **562,500
> images** — your entire image library is **~257 GB, still only about 27% of one 1 TB disk**, and
> S3 for the whole thing is **~$5/month**. Even at the high end of the brand-count range (10 brands/
> product, 750,000 images) it's ~343 GB — a third of the drive — for ~$6.66/month. The disk was
> never the constraint at any plausible scale, so staging on it buys you nothing and costs you a
> migration.
>
> The 1 TB disk has exactly two correct jobs: (a) the scraper's landing zone, where junk gets
> filtered before it earns a PUT charge, and (b) a weekly `aws s3 sync` mirror as insurance against
> your own `rm`. Both are useful. Neither is the system of record.
>
> Full reasoning in **§4**.

---

## 1. Where you actually are today

I read `data/buildobjects.db` rather than trusting the plan. The numbers matter:

Counting `kind='photo'` only — datasheets and IndiaMART stock art excluded — because that is the
population the "4–5 images per product" target refers to:

```
products                        1,087       across 4 categories, 110 brands
offers                          2,023
photo rows                      2,748       = 2.53 per product   (2,580 distinct assets)
products with ≥1 photo            924       85.0%
products with exactly 1 photo     505       54.7% of those
products with ≥5 photos           127       11.7%   ← the real gap
on disk                    2,720 files, 21.5 MiB, median 7.4 KiB  (250px variant, all kinds)
```

*(Counted across all three `kind` values instead, the first two rows read 930 and 167. Pick one
population and hold it — mixing them is how coverage dashboards start lying.)*

Three observations:

1. **The gap is not "get more images", it is "get any image".** 505 of the 924 products with photos
   have exactly one. You are 27× away from 75,000 photos.
2. **Your images are 7 KB thumbnails.** `collect-images.ts` takes the 250px imimg variant, which was
   the right call for a 92px card plate and is the wrong call for a product detail page or zoom.
   Whatever you do next, re-fetch at the largest available variant and keep it as the master.
   **Consequence:** none of the 2,720 files you hold today can serve a PDP. Treat them as a cache to
   be replaced, not a corpus to be migrated.
3. **One product carries 327 images** (`p_bc55663a22ef68e7`, unbranded red clay brick). I initially
   read that as a crawler bug; it isn't — it has 242 offers and the images come from 216 distinct
   `offer_id`s, ~1.5 each. The aggregation is working as designed. It is still a **product** problem:
   nobody needs 327 pictures of a brick, and the card rotation has to cap and rank, not display.

One more, from `next.config.mjs`:

```js
// Product thumbnails come from source CDNs and are rendered with a plain <img>
images: { unoptimized: true },
```

That comment is stale — `collect-images.ts` downloads to `public/img` and the app serves its own
files. Good instinct, wrong destination. Which brings us to the thing that has to be fixed first.

---

## 2. The wall you hit before anything else — and it is not storage

Your images live in `public/img`, committed to git, shipped inside the Vercel deployment. That is
correct for a demo and a dead end for production. Four walls, in the order you hit them:

| Wall | Limit | Where you land |
|---|---|---|
| Source files per CLI deployment | **15,000, counting all source files** ([Vercel limits](https://vercel.com/docs/limits)) | well under 15,000 images once `app/`, `lib/`, `components/`, `scripts/`, `filters/` and `data/` take their share |
| Git repo | practical pain past ~1 GB | 542 MB at 250px-only; **~10 GB** with a full variant set |
| Function bundle | **250 MB uncompressed** ([Vercel](https://vercel.com/docs/functions/limitations)) | your SQLite DB alone: 31 MB @ 1,087 products → **~430 MB @ 15,000** |
| Writable filesystem | **none** — read-only, `/tmp` 500 MB, ephemeral ([Vercel](https://vercel.com/docs/functions/runtimes)) | **the upload portal cannot exist** |

That last row is the one that ends the argument. Checklist item 3 says *"system to manually add
images."* A Vercel function has a read-only filesystem. It physically cannot write to `public/img`.
The only way to add an image in your current design is to commit a binary file and redeploy the
site. That is not an upload system; that is a build step wearing a costume.

**So object storage is not an optimisation you do later. It is a precondition for a feature you
already committed to.** This is the one-way door in this project. Walk through it now, while you
have 2,720 files to migrate instead of 75,000.

> **Adjacent risk, flagged not solved:** the same 250 MB cap kills `data/buildobjects.prod.db` at roughly
> 8,000 products, and the bundled SQLite is read-only, so vendor uploads have nowhere to write
> metadata either. Images and the database hit the same wall for the same reason. Vercel now offers
> 5 GB "large functions" on Fluid compute for projects created after 30 June 2026, which buys time
> but does not make the file writable. Worth its own document; out of scope here.

---

## 3. The architecture

Five planes. The only one that touches a user request is the last, and it contains none of your code.

```
 ┌─ ACQUIRE ─────────────────────────────────────────────────────────────┐
 │  Crawlee (HTTP-first, Playwright only when needed)                    │
 │  Brand media kits / dealer portals          ← the cheap, legal path   │
 │  Admin + vendor upload portal                                         │
 │  Own photography                                                      │
 └────────────────────────────┬──────────────────────────────────────────┘
                              ▼   local disk landing zone  (the 1 TB drive)
 ┌─ QUALIFY ─────────────────────────────────────────────────────────────┐
 │  bytes → SHA-256 → pHash → blur → junk-class → SigLIP dupe → VLM      │
 │  reject cheaply, escalate rarely, record every verdict                │
 └────────────────────────────┬──────────────────────────────────────────┘
                              ▼   only survivors earn a PUT
 ┌─ STORE ───────────────────────────────────────────────────────────────┐
 │  s3://buildo-img/masters/<sha256>.<ext>      Standard-IA, immutable   │
 │  s3://buildo-img/variants/<sha256>/w=..,f=.. Standard, 90-day TTL     │
 │  metadata + provenance + QC verdict → your DB                         │
 └────────────────────────────┬──────────────────────────────────────────┘
                              ▼
 ┌─ TRANSFORM ───────────────────────────────────────────────────────────┐
 │  pre-generate 200/400/800 in AVIF+WebP at ingest                      │
 │  1600 zoom: transform on first request, then persist to S3            │
 └────────────────────────────┬──────────────────────────────────────────┘
                              ▼
 ┌─ DELIVER ─────────────────────────────────────────────────────────────┐
 │  CloudFront · Cache-Control: max-age=31536000, immutable              │
 │  99%+ hit ratio · your app servers see zero image traffic             │
 └───────────────────────────────────────────────────────────────────────┘
```

### The identity rule that makes everything else easy

**Key the master by the SHA-256 of its bytes.** Not by product, not by category, not by URL.

```
s3://buildo-img/masters/9f2a…c41.jpg
s3://buildo-img/variants/9f2a…c41/w=400,f=avif
s3://buildo-img/variants/9f2a…c41/w=400,f=webp
```

Four things fall out of this for free:

- **Dedupe is structural.** Your own comment in `collect-images.ts` says it: *"one seller has one
  photo, but twelve sellers of the same bag have twelve."* Content-addressing stores that once.
- **The pipeline is idempotent.** Re-run the scraper as often as you like; identical bytes produce
  an identical key and a no-op PUT.
- **Variants nest under the master**, so deleting an image or invalidating the CDN is one prefix:
  `DELETE /masters/9f2a*` and `CloudFront invalidate /9f2a*`. (This is AWS's own
  [image-optimization pattern](https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/).)
- **The key never has to change**, because it encodes nothing that can change.

**Corollary — do not put category or brand in the S3 key.** Category is a business fact that gets
revised; a key is permanent. The day you re-classify "concrete blocks" out of `bricks_blocks`, a
category-keyed layout forces you to move objects and rewrite URLs. Category belongs in the database,
where you already have it. The "split by category properly" requirement in your checklist is a
**query and an admin-UI concern, not a folder concern.**

Your `product_image` table is the right *shape* — a join table with `(product_id, asset_key)` as PK —
but `assetKeyOf()` derives the key from `host + pathname` with the size suffix stripped. That is a
**URL** identity, not a content identity. It collapses imimg's 125/250/500/1000 variants of one
photograph (good) but cannot tell that the same JPEG served from two different hosts is the same
image. Keep `asset_key` as the provenance/upsert key; add `sha256` as the storage key. Columns to add
are in §7 and §10.

---

## 4. Local disk vs S3 — the actual answer, with the arithmetic

### First, the size — at the corrected catalogue scale

15,000 products, ~7.5 brands per product on average, 5 images per brand-listing. Per-image byte
sizes are unchanged from the earlier model (calibrated from your real files, median 7.4 KB at 250px,
scaled by JPEG's sub-linear byte growth) — only the image *count* changes:

| Scenario | Product-brand SKUs | Images | Masters | Hot variants | Tail (zoom) | **Total** |
|---|---|---|---|---|---|---|
| Low (5 brands/product) | 75,000 | 375,000 | 85.1 GB | 47.6 GB | 38.6 GB | **171.3 GB** |
| **Mid (7.5 brands/product)** | **112,500** | **562,500** | **127.7 GB** | **71.3 GB** | **57.9 GB** | **≈ 257 GB** |
| High (10 brands/product) | 150,000 | 750,000 | 170.2 GB | 95.1 GB | 77.2 GB | **342.6 GB** |

*(Masters = largest available variant, ~240 KB est. Hot variants = 200/400/800px × AVIF+WebP, 133 KB/
image. Tail = 1600px zoom, ~40% materialised, 108 KB/image effective.)*

**At the midpoint, 257 GB is ~27% of a retail 1 TB drive** (931 GiB usable); even the high scenario
is ~37%. The premise that storage volume forces a staging decision still doesn't survive contact with
the numbers — you're using a quarter to a third of the drive, not needing more than it holds.

### Second, the price

| Scenario | Masters (Standard-IA) | Variants (Standard) | **Total/month** |
|---|---|---|---|
| Low — 375,000 images | 85.1 GB × $0.0138 = $1.17 | 86.2 GB × $0.025 = $2.16 | **$3.33 ≈ ₹317** |
| **Mid — 562,500 images** | 127.7 GB × $0.0138 = $1.76 | 129.2 GB × $0.025 = $3.23 | **$4.99 ≈ ₹475** |
| High — 750,000 images | 170.2 GB × $0.0138 = $2.35 | 172.3 GB × $0.025 = $4.31 | **$6.66 ≈ ₹634** |

*Standard-IA carries three conditions worth pricing in: a **128 KB minimum billable object size**
(your ~240 KB masters clear it, your variants would not — which is why variants stay in Standard), a
**30-day minimum duration**, and a **$0.01/GB retrieval charge**. That last one matters for the §7
re-QC pass: re-reading all ~128 GB of masters (mid scenario) costs **~$1.28** in retrieval. Still
negligible, and it's why masters go to IA and not Glacier IR (90-day minimum, 6× the retrieval fee).*

A 1 TB external drive is ₹4,000–5,000. Even at the high-scenario price of $6.66/month, that drive
pays for **five years** of S3 for the entire library — in exchange for a single point of failure
with no versioning, no durability guarantee, and no way for a Vercel function to read it.

### Third — and this is the real reason

Even if S3 cost the same as the disk, staging locally would still be wrong, because **the manual
upload portal needs a writable, network-reachable store on day one.** A local disk on your machine
is not reachable from a Vercel function. So you need object storage the moment you build checklist
item 3 — which means "local now, cloud later" isn't deferring a migration, it's *scheduling* one for
the exact moment you can least afford it.

And migrating later is not free: rewrite every `local_path` in `product_image`, change every render
path, bulk-upload 75,000 objects, invalidate every cached URL, and do it while the site is live.

### What the 1 TB disk is genuinely for

Two real jobs. Both worth doing:

1. **Scraper landing zone.** Download → hash → dedupe → QC → *then* PUT to S3. Filtering locally
   means you never pay a PUT charge for a 43-byte placeholder, and re-running a failed QC pass
   doesn't re-download anything. You already have this instinct in `collect-images.ts`.
2. **Cold mirror.** `aws s3 sync s3://buildo-img/masters ./mirror` weekly. 17 GB, ten minutes.
   This is insurance against you, not against AWS.

### The thing that makes this a non-decision

Put an interface in front of storage on day one:

```ts
// lib/storage/index.ts
export interface ImageStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  exists(key: string): Promise<boolean>;
  presignPut(key: string, contentType: string, ttlSec: number): Promise<string>;
  publicUrl(key: string): string;
}
```

Two implementations: `LocalDiskStore` and `S3Store`, chosen by one env var. Then run **MinIO** in
Docker for local development — it speaks the S3 API, so your "local" implementation *is* the S3
implementation and there is nothing left to port. "Can we move to AWS later?" becomes true by
construction rather than by hope.

**Recommendation: S3 from commit one. Local disk as scratch and mirror. MinIO in dev.**

---

## 5. Compression and format — what to encode, and what it costs

### Formats: AVIF + WebP, JPEG only as a floor

| Format | Support | Size vs JPEG |
|---|---|---|
| **AVIF** | **94.7%** global ([caniuse](https://caniuse.com/avif)) | ~50% smaller |
| **WebP** | ~97% | ~31% smaller |
| **JPEG** | 100% | baseline |
| JPEG XL | **13.6%, disabled by default in Chrome** ([caniuse](https://caniuse.com/jpegxl)) | — |

Serve AVIF with WebP fallback, negotiated from the `Accept` header. **Do not build for JPEG XL** —
it returned to Chromium in Chrome 145 but remains behind a flag with no committed ship date.

*(Compression percentages are practitioner benchmarks, not a peer-reviewed study. Measure on 50 of
your own cement-bag shots before locking budgets — white-background product photography compresses
considerably better than the mixed photo corpora these tests use.)*

One free win worth knowing: **jpegli** (Google, 2024) is API-compatible with libjpeg-turbo, produces
standard JPEGs every decoder can open, and is ~35% smaller at high quality. Drop-in replacement for
your JPEG floor, zero client risk.

### Library: sharp / libvips. This is not close.

libvips' own benchmark, 10,000×10,000 crop-shrink-sharpen:

| Tool | Time | Peak RAM |
|---|---|---|
| **libvips 8.18** | **0.57 s** | **94 MB** |
| ImageMagick 7.1.1 | 4.41 s | 1,501 MB |

**7.7× faster, 16× less memory.** ([libvips wiki](https://github.com/libvips/libvips/wiki/Speed-and-memory-use))
sharp is the Node binding; you're already a Node shop.

**Two production footguns that will bite you at 75,000 images and are trivially avoidable:**

```bash
UV_THREADPOOL_SIZE=<core count>   # defaults to 4; without this sharp silently caps at 4 parallel
MALLOC_ARENA_MAX=2                # without jemalloc, libvips defaults to 1 thread per image on glibc
```

**AVIF encoding is genuinely expensive** — 1–4 s per image and up to ~2.5 GB peak RSS on a 4000px
source, vs ~90 ms for WebP. Use `avif({ quality: 72, effort: 5 })`. Effort 5–6 is the knee; effort 9
costs seconds for unpredictable gains, and sharp issue #3418 documents cases where raising effort
*increases* file size. **Quality is the file-size lever, not effort.**

### Variant ladder

| Role | Width | AVIF (est.) | WebP (est.) | Strategy |
|---|---|---|---|---|
| card plate / cart line | 200 | ~4 KB | ~8 KB | pre-generate |
| PLP tile | 400 | ~11 KB | ~20 KB | pre-generate |
| PDP main | 800 | ~32 KB | ~58 KB | pre-generate |
| zoom | 1600 | ~95 KB | ~175 KB | **on demand, then persist** |

*Byte figures are estimates scaled from your observed 7.4 KB @ 250px. Sanity check against HTTP
Archive 2025: AVIF median across the web is 7 KB, p90 37 KB — flat-background product shots sit at
the low end of that band, so these are conservative.*

### Why hybrid, not full pre-generation

At the corrected scale (**562,500 images at the midpoint** — 15,000 products × ~7.5 brands × 5
images), full pre-generation of 4 widths × 2 formats = **4.5M objects and ~625–2,500 CPU-hours** of
AVIF encoding alone (2.25M encodes at 1–4 s each), most of it for variants nobody requests. The case
for hybrid generation gets *stronger*, not weaker, as the catalogue grows — the long tail gets longer
and Zipf-shaped traffic means an ever-smaller fraction of that 4.5M actually gets requested.

The pattern to copy is AWS's own
[image-optimization sample](https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/):

1. CloudFront Function on viewer-request normalises params (sort, lowercase) and resolves
   `format=auto` from `Accept` → raises cache hit ratio by collapsing equivalent URLs
2. Primary origin = the **transformed-variants** bucket
3. On miss, S3 returns 403 → **CloudFront Origin Failover** fires
4. Secondary origin = Lambda function URL → fetches master, transforms with sharp, **writes the
   result back to S3**, returns it

The write-back is the part that matters. AWS's own productised solution
([Dynamic Image Transformation for CloudFront](https://aws.amazon.com/solutions/implementations/dynamic-image-transformation-for-amazon-cloudfront/),
formerly Serverless Image Handler) relies on the CloudFront cache **only** — so every edge eviction
re-triggers a 1–4 s AVIF encode. For a long-tail catalogue, persist to S3.

Lifecycle: variants get a 90-day expiry rule; masters never expire.

---

## 6. Delivery — and why 1 lakh users is not an image problem

### The mechanism

Images are **immutable and content-addressed**. That single property buys you the whole scaling
story:

```
Cache-Control: public, max-age=31536000, immutable
```

- The full pre-generated set is 9.5 GB; the genuinely hot slice is a fraction of that, because
  catalogue traffic is Zipf-shaped. Either way it fits comfortably in CloudFront edge caches.
- Hit ratio settles at **97–99%**, because a key never changes content, so a cached copy is never
  wrong. (The cost model in §12 assumes the conservative 97%.)
- Repeat visitors inside the browser cache window fetch nothing — `immutable` tells the browser not
  even to revalidate. **The cost model deliberately ignores this** and bills all 25 images on every
  pageview, so §12's figures are an upper bound; real traffic will come in materially below them.
- Origin sees 1–3% of traffic. S3 handles 5,500 GET/s per prefix natively.
- **Your Next.js functions serve no image bytes at all.**

That last line is the answer to "won't break at 1 lakh users." You do not scale images by making the
app faster. You scale them by ensuring images never reach the app. When Build Objects falls over under
load, it will be the SQLite bundle or the search path — never the pictures.

### What "1 lakh at once" actually means

Worth separating, because the two readings are three orders of magnitude apart:

| | Requests/month | Egress | Verdict |
|---|---|---|---|
| **1 lakh DAU** (15 pageviews, 25 images) | 1,125 M | 25 TB | Very achievable |
| **1 lakh concurrent** (page every 20 s) | 324,000 M | 7,242 TB | 5,000 pageviews/s · **25 Gbps** · 10.8 B req/day |

The concurrent reading is larger than most of Indian e-commerce on an ordinary day. If that is the
real target, the conversation is about CDN commercial terms, not architecture. **For images
specifically the design is identical either way** — which is the nice property of pushing everything
to a CDN.

### The delivery-path cost comparison — this is the expensive decision

At 1 lakh DAU (25 TB/month egress, 1,125 M image requests):

| Path | Monthly |
|---|---|
| **Vercel** — Fast Data Transfer $4,945 + Edge Requests $2,453 | **$7,398** |
| **CloudFront** pay-as-you-go, tiered India ladder | $3,661 |
| **CloudFront** flat-rate Premium (1.25 B req / 125 TB) | **$2,250** |

**Serving product images through Vercel's CDN is 3.3× the cost of CloudFront — about $5,150/month,
₹4.9 lakh, of pure waste.** Vercel is excellent at running your Next.js app. It is the most expensive
bandwidth on this list. Put images on `img.buildo.in` → CloudFront → S3, and leave Vercel to do
what it's good at.

*(That Vercel figure is bandwidth and edge requests only. Turning on Vercel Image Optimization would
add roughly $530/month on top, because it **bills per cache MISS** against a 31-day local-image cache
— so transformation charges recur rather than amortise. Your `images: { unoptimized: true }` setting
avoids this entirely today. Keep it.)*

Two costs I have **not** priced into the CloudFront column and you should confirm before committing:
the **WAF Web ACL that flat-rate plans make mandatory** (if AWS bills WAF requests separately, at
1,125 M requests/month that is material against a $2,250 base), and CloudFront→S3 origin fetches on
the 1–3% miss path.

### On CloudFront flat-rate plans — read the fine print

AWS launched flat-rate plans on 18 Nov 2025 (Free / Pro $15 / Business $200 / Premium $1,000),
priced **per distribution**, no commitment. They are excellent value and you should use one. Two
corrections to how they are usually described:

- **"No overage" is true about money only.** AWS's own docs: *"If you continue to substantially
  exceed your plan's usage allowance without upgrading, we may adjust how we deliver your traffic.
  For example, we might serve your traffic from fewer or more distant edge locations."* For an
  India-latency-sensitive image CDN that is a real cost, paid in milliseconds. Your first spike up
  to 3× allowance is forgiven; sustained excess is evaluated over 2–3 months.
- **Premium's "up to 6 B requests / 600 TB" is $10,000/month, not $1,000.** It is a configurable
  ladder: 50 TB/$1,000 → 125 TB/$2,250 → 600 TB/$10,000.

Eligibility gotchas worth checking before you plan around this: accounts using AWS Free Tier are
**not eligible**; a WAF Web ACL is mandatory; real-time access logs, Anycast IPs, staging
distributions and OAI are unsupported.

**Hedge worth knowing:** Cloudflare R2 is $0.015/GB storage with **$0 egress, permanently**. Honest
like-for-like at 1,125 M requests/month: storage $0.51, plus Class B operations at $0.36/M — which is
**~$402/month served directly from R2**, or ~$0.45 behind Cloudflare's cache at a 99% hit ratio. So the
realistic comparison is $2,250 (CloudFront flat) vs a few hundred dollars (R2 + Cloudflare CDN), not
$2,250 vs $0.50. It also makes Cloudflare a mandatory CDN dependency with its own plan tiering.

You asked for AWS and I'm recommending AWS. But if egress ever becomes the dominant line item, R2 is
the exit, and content-addressed keys behind an `ImageStore` interface make that a one-week job rather
than a rewrite. **Design for the option; don't take it yet.**

---

## 7. Quality control — is this photo actually of this product?

Order the gates cheapest-first. Reject early; escalate rarely.

| # | Gate | Method | Cost @ 562,500 images (mid) |
|---|---|---|---|
| 1 | Sanity | decodes, >2 KB, aspect 0.5–2.0, **≥600px short side for `master` role / ≥200px for `thumb-only`** | free |
| 2 | Exact dupe | SHA-256 — it's already your key | free |
| 3 | Near dupe | pHash, Hamming **≤5** (`imagededup`) | free |
| 4 | Blur | Laplacian variance; start at 100, **tune on your own sample** | free |
| 5 | Junk class | you already have this — `kindOf()` catching `GLADMIN` stock art and `PDFImage` datasheets | free |
| 6 | Semantic dupe | SigLIP-2 embeddings, cosine ≥0.95, cross-SKU | ~$14.50 (15 GPU-hrs) |
| 7 | **Relevance** | one VLM call per image, structured JSON out | **~$64.69** |
| 8 | Human | only items the VLM flags low-confidence | reviewer-hours |

*(Gates 1–5 stay free regardless of scale — they're CPU, not API calls. Gates 6–7 scale linearly
with image count; at the low/high ends of the brand-count range they run $9.66/$43 and $19.33/$86
respectively. See §12 for the full range.)*

**Gate 1 has a trap you will hit in week one.** Every one of your existing 2,720 files is a 250px
imimg variant, so a flat "≥600px" rule rejects **100% of the corpus you just migrated**. Give
`product_image` a `role` of `master` or `thumb_only`, apply the 600px floor to masters only, and let
today's thumbnails keep serving card plates while the re-fetch at full resolution runs behind them.
Otherwise phase 0 and phase 3 in §11 are in direct conflict.

### Why gate 7 is a VLM and not Rekognition

**Rekognition `DetectLabels` costs $93.75 for 75,000 images in Mumbai and cannot answer your
question.** It returns a generic vocabulary — "Cement", "Pipe", "Tile". It will not tell you OPC 43
from OPC 53, Fe500 from Fe550D, or UltraTech from Ambuja. `DetectModerationLabels` has **no category
for "wrong product", "watermark", or "off-brand"** — it is an NSFW gate, nothing more.

**And CLIP/SigLIP has the same blind spot.** Embedding models are excellent at "this is a bag of
cement" and useless at grade. For construction materials, **the distinguishing information is
printed text on the bag, the bundle tag, the tin.** So the gate that matters is one that reads.

A VLM does classification and OCR in a single call:

```json
{
  "is_product_photo": true,
  "category_match": true,
  "brand_text_visible": "UltraTech",
  "grade_text_visible": "OPC 53",
  "matches_listing": true,
  "has_watermark": false,
  "is_stock_art": false,
  "confidence": 0.94,
  "reject_reason": null
}
```

**You already have `GEMINI_API_KEY` in `.env.local` and a working Gemini integration in `lib/chat/`.**
Use Gemini Flash — no new vendor, no new SDK. Bedrock Nova Lite is the AWS-native equivalent at
$0.000115/image ($8.63 for the lot); *note its model card says it is not offered in ap-south-1 even
though in-region SKUs appear in the price list — verify in console before designing around it.*

Cost comparison, full catalogue, one pass:

| | Cost @ 562,500 images |
|---|---|
| pHash dedupe | ~$0 |
| SigLIP-2 self-hosted (g6.xlarge, ~15 hr) | $14.50 |
| **VLM relevance check** | **$64.69** |
| Rekognition DetectLabels (proportional, for comparison) | ~$703 |
| Rekognition Labels + Moderation | ~$1,406 |

**About $65 — ₹6,180 — to verify every image in the corrected catalogue.** Still the cheapest quality
lever in the entire product, and still an order of magnitude below Rekognition. Run it on everything,
including images you already trust.

### Store the verdict, don't just act on it

One migration, eleven columns. Run this **once** — the rights columns in §10 are part of the same
block, not a second one:

```sql
-- identity and quality
ALTER TABLE product_image ADD COLUMN sha256        TEXT;      -- the storage key
ALTER TABLE product_image ADD COLUMN phash         TEXT;      -- 64-bit, hex
ALTER TABLE product_image ADD COLUMN role          TEXT NOT NULL DEFAULT 'thumb_only';
                                                              -- master | thumb_only
ALTER TABLE product_image ADD COLUMN qc_verdict    TEXT;      -- pass | review | reject
ALTER TABLE product_image ADD COLUMN qc_json       TEXT;      -- full model output
ALTER TABLE product_image ADD COLUMN qc_model      TEXT;      -- which model, which version
ALTER TABLE product_image ADD COLUMN qc_at         TEXT;
ALTER TABLE product_image ADD COLUMN is_primary    INTEGER NOT NULL DEFAULT 0;

-- rights and provenance — see §10, this is the legal insurance
ALTER TABLE product_image ADD COLUMN provenance    TEXT NOT NULL DEFAULT 'scraped';
                                            -- vendor_upload | own_photography | brand_licensed | scraped
ALTER TABLE product_image ADD COLUMN rights_status TEXT NOT NULL DEFAULT 'unverified';
                                            -- licensed | warranted_by_vendor | unverified | takedown
ALTER TABLE product_image ADD COLUMN takedown_at   TEXT;
```

(`source_url` and `page_url` already exist, so `source_domain` is derivable — no column needed.)

Recording `qc_model` means that when a better model ships in six months, you re-run the pass for
another ₹822 against masters you already hold — no re-crawling. It is not entirely free: reading
17 GB back out of Standard-IA is a $0.17 retrieval charge. **Never throw away a verdict; you cannot
reconstruct it.**

> **Human review:** build it yourself. Amazon A2I, SageMaker Ground Truth and Mechanical Turk all
> **closed to new customers on 30 July 2026**. A minimal internal screen — image, listing metadata,
> the model's stated reason, approve/reject/reassign, keyboard shortcuts — is a few days of work.

---

## 8. Manual upload, and splitting by category

### The flow

```
Browser → POST /api/admin/images/presign   {product_id, filename, content_type}
        ← {url, fields, upload_id}
Browser → PUT directly to S3 inbox/          ← bytes never touch your function
S3 event → SQS → Lambda
           hash · QC gates 1–7 · promote masters/<sha256> · encode variants · DB row
Admin UI ← poll or SSE: "3 accepted, 1 flagged: brand text reads 'Ambuja', listing says 'UltraTech'"
```

**Presigned upload is not a nicety.** Vercel functions cap request bodies at **4.5 MB**
(`FUNCTION_PAYLOAD_TOO_LARGE`). Any real product photo through your API route fails. Direct-to-S3
sidesteps it completely and costs you nothing.

### The admin UI

- **Navigate:** category → brand → product typeahead (wire to your existing `product_fts` — the
  search is already built)
- **Upload:** drag-drop multiple, per-file progress, inline QC verdict with the model's reason
- **Curate:** reorder by drag, set primary, mark `datasheet` vs `photo` (your `kind` column already
  does this), delete
- **Bulk:** CSV of `sku,image_url` for URL ingestion, or a ZIP named `<sku>_1.jpg` — same pipeline,
  same gates, no separate code path
- **Coverage dashboard:** SKUs below target image count, **sorted by search demand** — so effort goes
  where buyers actually look. See the caveat under §11 before you build this; it needs a schema
  change first.

### On "split by category properly"

Do it in the **database and the UI**, not in S3 keys. Category is business metadata that gets
revised; object keys are permanent. Keying by category means a re-classification becomes an object
migration plus a CDN invalidation.

What you need for the category experience is one view:

```sql
CREATE VIEW image_coverage AS
SELECT p.category, p.brand, p.product_id, p.title,
       COUNT(pi.asset_key) FILTER (WHERE pi.kind='photo' AND pi.qc_verdict='pass') AS good_photos,
       MAX(pi.is_primary)                                                          AS has_primary
FROM product p LEFT JOIN product_image pi USING (product_id)
GROUP BY p.product_id;
```

*(`p.title`, not `p.name` — check your column names against `lib/schema.sql`, the `product` table
uses `title`.)*

That one view drives the dashboard, the gap report, and the weekly automation in §11.

---

## 9. The part where I disagree with the brief

You asked me to think like a CEO. A CEO's job here is to push back on the goal, not just optimise
the plan. Four challenges, in descending order of how much money they save.

### 9.1 Do not build a crawler for every brand's official site

You said "scrape only from official pages." That means 100+ manufacturer websites, each with its own
DOM, each breaking independently, forever. It is a permanent maintenance tax with no defensibility —
nobody buys from Build Objects because your scraper is good.

**The 80/20 is 20 emails.** Indian building-material brands — UltraTech, Ambuja, Tata Tiscon, JSW,
Astral, Supreme, Finolex, Asian Paints, Kajaria, Jaquar, Havells, Polycab — all run dealer portals
with downloadable media kits, and most will send a product-asset pack to a platform that drives
demand to their dealers. That gets you **higher resolution, correct current packaging, and a
licence**, for the cost of twenty emails and two weeks of patience.

Build the crawler for the tail. Ask for the head. Right now you are planning to build the expensive
thing for the part that's free.

### 9.2 "4–5 images for every product" is the wrong target

Your own data says 505 of 924 products have exactly one photo. Before you spend three months getting
to five, ask what the fifth image of a cement bag is *for*.

A UltraTech OPC 53 bag looks the same in every photograph ever taken of it. The buyer is comparing
**price, grade, and delivery date** — that is literally your product. Five angles of a sack adds
bytes, not conversion. Tiles, sanitaryware, paint shades and fittings are the opposite: appearance
*is* the purchase decision.

A demand-weighted ladder instead of a flat 5, applied to the corrected base of ~112,500 product-brand
SKUs (15,000 products × ~7.5 brands avg):

| Segment | Assumed share | SKUs | Images/SKU | Total |
|---|---|---|---|---|
| Appearance-driven — tiles, sanitaryware, paint, fittings, lights | 15% | 16,875 | 5 | 84,375 |
| Semi-visual — pipes, wires, plywood, doors, hardware | 25% | 28,125 | 3 | 84,375 |
| Commodity — cement, TMT, sand, aggregate, bricks, blocks | 60% | 67,500 | 2 | 135,000 |
| | | | | **303,750** |

vs. the naive 5-everywhere baseline of **562,500** — **still a 46% reduction**, because it's the same
ratios applied to a larger base. The saving is proportional, not absolute: at the corrected scale it's
worth roughly **260,000 images**, not 34,500.

**46% less acquisition work for the same buyer utility** — and the effort you free up goes into
making the *one or two* images on a commodity SKU actually correct, sharp, and brand-legible. Which
is what your data says is broken.

> **Be honest about where those shares come from: they are an assumption about the catalogue you
> intend to build, not a measurement of the one you have.** Today's 1,087 SKUs are 74% commodity
> (cement, TMT, bricks/blocks) and 26% semi-visual (pipes) — **zero** SKUs sit in the appearance-driven
> tier that carries the 5-image target. Re-derive the split from the real category mix once you know
> what the 15,000 actually are. The *shape* of the argument survives regardless; the 40,500 number
> does not, and if the catalogue stays commodity-heavy the true target is lower still.
>
> **And note the cost tables in §4, §5, §7 and §12 all still price the naive 562,500-image plan** —
> the one I am arguing against. Carried through at 303,750 (46% less, same ratio) the numbers become
> ~139 GB, ~$2.69/month storage, ~$57 one-time build, VLM ~₹3,325. I have left the larger figures
> standing deliberately: they are the conservative upper bound, and they are what you should budget
> against until the category mix is settled.

For commodities the second image shouldn't be another angle. It should be **the datasheet** — you
already model `kind='datasheet'`. Caveat: you have 95 of them covering **28 products**, 2.6% of the
catalogue, and they are `PDFImage` scans harvested from IndiaMART — i.e. exactly the class of scraped
third-party content §10 argues carries the sharpest exposure. Scale datasheets by **asking brands for
the PDF**, which they publish freely and will happily see distributed. Don't scale them by scraping.

### 9.3 Clarify "1 lakh at once" before you buy for it

1 lakh **concurrent** is 5,000 pageviews/sec and 25 Gbps sustained — larger than most Indian
e-commerce on a normal day. 1 lakh **DAU** is a good year-two outcome and costs $2,250/month in CDN.
Designing images for the first when you mean the second doesn't waste much (the CDN design is the
same). Designing your *database* for the wrong one wastes a great deal. Pick a number and write it
down.

### 9.4 The real scaling risk in this repo is not images

`data/buildobjects.prod.db` is 31 MB for 1,087 products, bundled into a 250 MB function. At 15,000
products that's ~430 MB — over the cap — and it is read-only, so vendor uploads have nowhere to write.
Images have a clean answer (CDN). The database does not, and it fails earlier. I'd sequence that
work ahead of chasing image count.

---

## 10. Legal — the section I'd stop the meeting for

I am not a lawyer and this is not legal advice. But the research here is unusually one-sided, and
the architectural consequence is concrete and cheap, so it belongs in the design doc.

**Established:**

- Product photographs are protected artistic works — Copyright Act 1957, s.2(c)(i), explicitly
  *"whether or not any such work possesses artistic quality."* The banality of a white-background
  pack shot is not a defence.
- Under s.17(b), a manufacturer that **commissioned** the shoot owns the copyright by statute.
- **India's fair dealing is a closed list** (s.52). Private/research, criticism/review, reporting
  current events. If your purpose is not on the list, the analysis stops. I read every clause from
  (a) to (zc): **there is no exception for reproducing someone else's photograph to advertise goods
  for sale.** (I originally wrote that the UK has such an exception and India doesn't — that's wrong.
  UK CDPA s.63 covers advertising the sale of *the artistic work itself*, e.g. an auction catalogue.
  Neither jurisdiction helps you here.)
- *Koninklijke Philips v Amazestore* (Del HC, 2019) — defendants reused Philips' advertising
  photograph. Permanent injunction plus ~**₹3.15 crore** in damages.
- *Knit Pro v State of NCT Delhi* (SC, 2022) — **s.63 is cognizable and non-bailable.** A hostile
  brand can push for an FIR, not merely a civil suit.
- **Section 79 safe harbour does not protect you if you did the scraping.** It covers *"third party
  information… hosted by him."* If your crawler selected and resized it, you are the originator, and
  s.79(2)(b)(iii) — "does not select or modify the information" — fails on its face.
- **Every major Indian marketplace runs on seller-supplied imagery.** Amazon.in, Flipkart, IndiaMART
  and Moglix all require seller upload, take a broad sublicensable licence, and push infringement
  liability onto the seller by warranty and indemnity. (Amazon and Flipkart do operate in-house photo
  studios and sell imaging as a *service to sellers* — but the seller still supplies or commissions,
  and still warrants.) Consumer Protection (E-Commerce) Rules 2020, **Rule 5(2)** — which requires an
  undertaking from sellers that *images* are accurate — is drafted on exactly that assumption.
- Your current source is IndiaMART, whose ToU carries an express anti-scraping clause: *"Systematic
  retrieval of IIL Content… (whether through robots, spiders, automatic devices or manual processes)
  without written permission from IIL is prohibited."*

**Good news — the trade mark side is fine.** *Kapil Wadhwa v Samsung* (Del HC DB, 2012) and *Amazon
v Amway* (Del HC DB, 2020) establish that reselling genuine goods and using the brand name is not
infringement. Add the *Kapil Wadhwa* disclaimer — "not an authorised dealer, manufacturer warranty
may not apply." **It is the photograph, not the name, that is exposed.**

**The architectural consequence — build this now, it costs almost nothing:**

The three rights columns are already in §7's migration block — `provenance`, `rights_status`,
`takedown_at`. (`source_domain` is derivable from the `source_url` you already store.) They are worth
calling out separately because of what they buy you:

```sql
-- the query you will one day have 36 hours to run
UPDATE product_image
   SET rights_status = 'takedown', takedown_at = datetime('now')
 WHERE provenance = 'scraped'
   AND product_id IN (SELECT product_id FROM product WHERE brand = ?);
```

One `UPDATE` and one CloudFront invalidation. Without those columns it is a forensic exercise under
time pressure, in the worst week of your year. **This is the cheapest insurance in the entire
document — three columns, added before you have 75,000 rows to backfill.**

Then follow the *IndiaMART v Puma* (Del HC DB, June 2025) roadmap, which is the clearest recent
statement of what earns safe harbour for a B2B platform:

1. **Make vendor upload the primary path**, with a click-through ownership/licence warranty captured
   with timestamp and IP. This converts your exposure from *primary infringement, no defence
   available* to *intermediary liability, safe harbour plus notice-and-takedown.* It is the single
   highest-leverage change in this document.
2. Prominent express undertaking at vendor registration — the Delhi HC specifically ordered this.
3. Named Grievance Officer, published contact, 24-hour acknowledgement / 15-day disposal.
4. Published IPR takedown form (Moglix's is a good template).
5. Repeat-infringer record under Rule 5(5).
6. Treat the scraped set as a **bootstrap with a retirement date**, not a permanent asset.

---

## 11. Sequencing

| Phase | Weeks | Work | Exit criterion |
|---|---|---|---|
| **0 — unblock** | 1–2 | `ImageStore` interface; MinIO in dev; S3 bucket + CloudFront on `img.buildo.in`; migrate the existing 2,720 files as `role='thumb_only'`; run the §7 migration (11 columns, one script) | `public/img` is untracked and empty; images serve from the CDN; git history rewritten or the blobs accepted as dead weight |
| **1 — pipeline** | 3–4 | sharp worker (AVIF+WebP, 3 widths); QC gates 1–5; Lambda transform-and-persist for zoom | one product renders every variant end to end |
| **2 — upload** | 5–6 | Presigned upload; admin UI; category/brand navigation; bulk CSV+ZIP; coverage dashboard | you can add an image without a deploy |
| **3 — quality** | 7–8 | SigLIP-2 embeddings; VLM relevance pass over everything held; review queue; `search_impression` logging | every image carries a `qc_verdict` |
| **4 — acquisition** | 9–16 | 20 brand media-kit requests; Crawlee for the tail; re-fetch existing SKUs at master resolution; the §9.2 ladder | **every SKU in the current 1,087 has a passing primary master**; new SKUs gated on having one before they go live |
| **5 — automation** | ongoing | Weekly EventBridge job (below) | coverage holds without anyone watching |

Two notes on phase 4, because the obvious targets are not achievable and it is better to say so now:

- **"95% of 15,000 SKUs in four weeks" is not a real plan.** You are at 85% of 1,087, the target
  catalogue is 14× larger, brand media-kit requests take weeks of *other people's* time, and the tail
  crawler is being built in the same window. Set the exit criterion against the catalogue you have,
  and make "has a passing primary image" a **gate on publishing a new SKU** rather than a backlog to
  chase. A SKU with no image should not be live.
- Phase 0's `public/img` cleanup empties the working tree but **git history keeps every blob**. At
  21.5 MiB that is fine — do it now and it stays fine. At 500 MB it needs a history rewrite, which is
  a much worse afternoon.

### The weekly job (checklist item 7)

Extend `scripts/schedule/`, trigger from EventBridge or GitHub Actions:

1. **Gap report** — SKUs below their category's target, **ranked by search demand**. Fix what buyers
   actually search for, not what's alphabetically first.

   > **This does not work against `search_log` as it stands.** The table is `(id, q, region_id, hits,
   > at)` — 13,944 rows, 115 distinct queries — storing a *query string and a result count*, with no
   > product linkage and no impression column. There is no join that gets you per-SKU demand.
   > Two ways out, in order of effort: (a) replay each distinct `q` against `product_fts` weekly and
   > attribute impressions to the SKUs it returns — cheap, approximate, no schema change; (b) add a
   > `search_impression(product_id, query_id, position, at)` table and log the actual result set —
   > correct, and useful far beyond images. Budget for (b); ship (a) first.
2. **Targeted re-crawl** — only the gaps. Never a full re-crawl.
3. **Liveness** — HEAD each `source_url`; a 404 on a scraped master is a signal the brand pulled it.
4. **Drift** — masters older than 12 months on high-traffic SKUs get re-fetched; packaging changes.
5. **Auto-promote** — if a newly uploaded image outscores the current primary on QC, swap it.
6. **Re-QC on model upgrade** — when a better VLM ships, re-run against stored masters. ~₹822 plus
   $0.17 of Standard-IA retrieval.
7. **Orphan sweep** — S3 objects with no `product_image` row, and rows with no S3 object.

---

## 12. Total cost of ownership

**One-time build — corrected scale: 15,000 products × ~7.5 brands avg × 5 images (the conservative
5-everywhere plan, not the §9.2 ladder):**

| | Low (375,000) | **Mid (562,500)** | High (750,000) |
|---|---|---|---|
| S3 PUTs @ $0.005/1,000 (7 objects/image) | $13.12 | **$19.69** | $26.25 |
| AVIF+WebP encode, c7g.4xlarge spot ($0.20/hr, 16 cores) | $5.08 (406 CPU-hr) | **$7.62 (609 CPU-hr)** | $10.16 (812 CPU-hr) |
| SigLIP-2 embeddings, g6.xlarge | $9.66 (10 GPU-hr) | **$14.50 (15 GPU-hr)** | $19.33 (20 GPU-hr) |
| VLM relevance pass | $43.12 | **$64.69** | $86.25 |
| **Total** | **$70.99 ≈ ₹6,760** | **$106.49 ≈ ₹10,140** | **$141.98 ≈ ₹13,520** |

*The encode line assumes AVIF at 1.2 s/image (sharp, `effort: 5`). §5 gives the real range as 1–4 s;
at the top of that range the mid-scenario encode cost is ~4× higher, around **$30**. Still lunch
money — which is the point. Encode cost is never the constraint; encode **wall-clock** might be
(600+ CPU-hours is a multi-day job on one box), so batch it across several spot instances, not Lambda.*

**Monthly, steady state.** CDN and traffic costs are driven by *visitors*, not catalogue size, so
these are unchanged by the scale correction — only the S3 storage column moves, from $0.67 to the
mid-scenario **$4.99**:

| Stage | Traffic | CDN | S3 storage | Requests + compute | Total/mo |
|---|---|---|---|---|---|
| Pilot (500 DAU, 20 pv) | 7.5 M req, 0.2 TB | $0 — inside the always-free 1 TB / 10 M req | $4.99 | ~$0.20 | **≈ $5** |
| Year 1 (20k DAU, 15 pv) | 225 M req, 5 TB | $708 pay-as-you-go | $4.99 | ~$4 | **≈ $717** |
| Scale (1 lakh DAU, 15 pv) | 1,125 M req, 25 TB | $2,250 flat-rate Premium @1.25 B (PAYG: $3,661) | $4.99 | ~$18 | **≈ $2,273** |

*(At the high scenario — 750,000 images — swap in $6.66 storage; the totals move by under $2/month
either way. Catalogue scale is noise against traffic cost, which is the whole argument in §6 for why
this isn't the expensive part of the system.)*

The "requests + compute" column is S3 GETs on the 3% CDN-miss path plus Lambda invocations for
on-demand zoom variants. It is small, but it is not zero, and leaving it out of a TCO table is how
cloud bills surprise people. **Not included and worth confirming: the WAF Web ACL that flat-rate plans
require, and CloudFront→origin fetch charges.**

**Plan crossover:** flat-rate beats pay-as-you-go from roughly **90 M requests/month** against the
$200 Business plan, and **~305 M** against the $1,000 Premium plan. At 225 M, Business ($200) is
technically the cheapest option but you'd be running at 1.8× its allowance — inside the documented
3× spike tolerance, outside it as a sustained load, which is why the table shows PAYG. Re-check at
each 5× traffic step rather than picking a plan once.

**Tax:** buying through AWS India Pvt Ltd adds 18% IGST, recoverable as input credit. Buying from AWS
Inc. with a registered GSTIN means AWS doesn't collect it — but as an import of services you
**self-assess IGST under reverse charge**, also recoverable. It is a cash-flow and compliance
difference, not a saving. Talk to your CA before assuming otherwise.

**The headline, at the corrected scale:** the entire image library — 562,500 images, acquisition,
processing, AI verification, storage — costs **about ₹10,140 to build and ₹475/month to store.**
Even at the high end of the brand-count range (750,000 images) that's ₹13,520 and ₹634/month. The
only line item that ever gets large is bandwidth, and that only arrives with traffic you'd be happy
to have.

**What would change these numbers:**

- **Brand coverage comes in above 10/product, or the product count itself grows:** the High scenario
  above (750,000 images) already covers a fair range of that — 343 GB, $6.66/month. Push to genuinely
  10× today's *corrected* midpoint (5.6M images) and you're at ~2.5 TB, ~$50/month, ~6,000 CPU-hours
  of encoding. Still not a number that changes the architecture — batch the encoding on spot instances
  and it's a bandwidth problem, not a storage problem, same as always.
- **Egress becomes dominant:** Cloudflare R2 ($0 egress, but price the Class B operations — see §6)
  or Bunny's Volume *network* tier ($0.005/GB bandwidth, no request fees) instead of CloudFront.
  Content-addressed keys behind `ImageStore` make that a week, not a rewrite.
- **You move off Vercel:** the image architecture is unaffected. That is the point of putting it
  behind its own hostname.

---

## Sources

**AWS pricing** — [S3](https://aws.amazon.com/s3/pricing/) · [CloudFront](https://aws.amazon.com/cloudfront/pricing/) · [CloudFront pay-as-you-go](https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/) · [Flat-rate plans (dev guide)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) · [Launch announcement, 18 Nov 2025](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-flat-rate-pricing-plans/) · [Rekognition](https://aws.amazon.com/rekognition/pricing/) · [India tax](https://aws.amazon.com/tax-help/india/) · Price List API, `pricing.us-east-1.amazonaws.com`, ap-south-1, pub. 2026-08-06

**Image architecture** — [AWS image optimization pattern](https://aws.amazon.com/blogs/networking-and-content-delivery/image-optimization-using-amazon-cloudfront-and-aws-lambda/) · [Dynamic Image Transformation for CloudFront](https://aws.amazon.com/solutions/implementations/dynamic-image-transformation-for-amazon-cloudfront/) · [libvips benchmarks](https://github.com/libvips/libvips/wiki/Speed-and-memory-use) · [sharp performance](https://sharp.pixelplumbing.com/performance/) · [caniuse AVIF](https://caniuse.com/avif) · [caniuse JPEG XL](https://caniuse.com/jpegxl) · [HTTP Archive 2025](https://almanac.httparchive.org/en/2025/page-weight) · [jpegli](https://opensource.googleblog.com/2024/04/introducing-jpegli-new-jpeg-coding-library.html) · [Crawlee](https://crawlee.dev/js/api/basic-crawler/interface/BasicCrawlerOptions)

**Vercel limits** — [Functions](https://vercel.com/docs/functions/limitations) · [Platform limits](https://vercel.com/docs/limits) · [Runtimes](https://vercel.com/docs/functions/runtimes) · [Image Optimization pricing](https://vercel.com/docs/image-optimization/limits-and-pricing) · [Mumbai bom1 pricing](https://vercel.com/docs/pricing/regional-pricing/bom1)

**QC / ML** — [imagededup](https://idealo.github.io/imagededup/methods/hashing/) · [SigLIP 2](https://arxiv.org/html/2502.14786v1) · [Marqo e-commerce embeddings](https://www.marqo.ai/blog/introducing-marqos-ecommerce-embedding-models) · [Rekognition moderation API](https://docs.aws.amazon.com/rekognition/latest/dg/moderation-api.html) · [Nova image tokens](https://docs.aws.amazon.com/nova/latest/userguide/modalities-image.html) · [AWS service availability update, 30 Jun 2026 (A2I/Ground Truth)](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-service-availability/)

**Legal** — [Copyright Act 1957](https://www.indiacode.nic.in/bitstream/123456789/15356/1/the_copyright_act,_1957.pdf) · [s.52 text](https://lawgist.in/copyright-act/52) · [Trade Marks Act s.30](https://lawgist.in/trade-marks-act/30) · [Philips v Amazestore](https://indiankanoon.org/doc/153382379/) · [Knit Pro v NCT Delhi](https://indiankanoon.org/doc/180042115/) · [Kapil Wadhwa v Samsung](https://indiankanoon.org/doc/86466712/) · [Amazon v Amway](https://www.casemine.com/judgement/in/5e3448929fca190905a06ef0) · [IndiaMART v Puma (DB, 2025)](https://indiankanoon.org/doc/85285346/) · [MySpace v Super Cassettes](https://iprmentlaw.com/wp-content/uploads/2018/06/Myspace-v.-Super-Cassettes-Industries-Ltd.-2016-Del-HC.pdf) · [E-Commerce Rules 2020, Rule 5](https://www.consumerprotection.in/rule-5-liabilities-of-marketplace-e-commerce-entities/) · [IndiaMART ToU](https://www.indiamart.com/terms-of-use.html)

---

## Confidence and open items

**Verified:** all AWS and Vercel prices and limits; format support percentages; libvips/sharp
benchmarks; every legal citation; your own database figures.

**Estimated, labelled as such:** master and variant byte sizes (scaled from your observed 7.4 KiB @
250px by area^0.8 — **measure on 50 real files before committing**); AVIF/WebP compression percentages
(practitioner benchmarks; no peer-reviewed 2026 study exists); AVIF encode time (1–4 s range, §12
uses 1.2 s); SigLIP-2 GPU throughput; the §9.2 category split (an assumption about a catalogue that
does not exist yet — see the callout there).

**Traffic model, stated plainly so you can disagree with it:** 15 pageviews/session, 25 images/page,
100% of images fetched on every pageview (i.e. **zero browser-cache credit**), 97% CDN hit ratio,
24 KiB blended bytes per image. The zero-cache assumption makes every delivery figure an **upper
bound** — real traffic will come in materially below it.

**Needs checking before you build:**

1. **Bedrock Nova Lite availability in ap-south-1** — the model card says no, in-region SKUs exist in
   the price list. Verify in console. (Moot if you use Gemini, which you already have.)
2. **CloudFront flat-plan eligibility** — accounts "using AWS Free Tier" are excluded; wording is
   ambiguous for new accounts. Also: WAF Web ACL mandatory, real-time logs and Anycast IPs
   unsupported, plans are **per distribution**.
3. **Whether CloudFront flat-rate allowances are metered identically for India-delivered bytes** —
   the docs state a single global number and never address geography. Worth a support ticket, since
   India pay-as-you-go DTO is 28% above US rates.
4. **Whether WAF request charges are bundled into the flat-rate plan** or billed separately. At
   1,125 M requests/month this is material against a $2,250 base.
5. **Vercel's 15,000-source-file limit is documented for CLI deploys only** — no equivalent Git-deploy
   limit is published. Doesn't change the recommendation; images shouldn't be in the repo regardless.
6. **Whether `search_log` gets replayed or replaced** (§11 step 1). Everything demand-prioritised in
   this document depends on that choice.
