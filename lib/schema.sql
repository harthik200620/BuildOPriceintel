-- BuildO Price Intelligence — local schema
--
-- Two invariants this file exists to enforce:
--   1. All money is integer paise. No column anywhere holds rupees as a float.
--      A cart total that differs from the sum of its lines by a rupee is a
--      dispute on a signed contract.
--   2. unit_canonical is NOT NULL. A unitless price is the failure mode that
--      makes an entire BOQ fiction (IndiaMART ships seven pricing units on one
--      sand page; BigBMart ships "River Sand Rs.2,450" with no unit at all).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

-- ─── geography ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS region (
  region_id     TEXT PRIMARY KEY,          -- 'hyderabad' | 'vijayawada'
  name          TEXT NOT NULL,
  state_code    TEXT NOT NULL,             -- 'TS' | 'AP'
  district      TEXT NOT NULL,
  pincode_from  TEXT NOT NULL,
  pincode_to    TEXT NOT NULL,
  default_pincode TEXT NOT NULL,           -- the pincode price_current materialises against
  centroid_lat  REAL NOT NULL,
  centroid_lon  REAL NOT NULL,
  freight_band  INTEGER NOT NULL,
  sor_status    TEXT NOT NULL,             -- what government rate anchor exists for this state
  sor_note      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pincode (
  pincode     TEXT PRIMARY KEY,
  region_id   TEXT NOT NULL REFERENCES region(region_id),
  locality    TEXT NOT NULL,
  district    TEXT NOT NULL,
  state_code  TEXT NOT NULL,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  source_url  TEXT NOT NULL,
  confidence  TEXT NOT NULL CHECK (confidence IN ('quoted','derived','typical','unknown'))
);
CREATE INDEX IF NOT EXISTS pincode_region ON pincode(region_id);

-- ─── reference tables (data, never constants in code) ─────────────────────────

-- Per-category because the trade's inch->mm mapping is not arithmetic:
-- 1" CPVC = 25 mm nominal bore, but 4" SWR = 110 mm OD. A table with tests,
-- never x25.4.
CREATE TABLE IF NOT EXISTS unit_conversion (
  from_unit TEXT NOT NULL,
  to_unit   TEXT NOT NULL,
  category  TEXT NOT NULL,                 -- '*' = applies to all categories
  factor    REAL NOT NULL,
  note      TEXT,
  source_url TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('quoted','derived','typical','unknown')),
  PRIMARY KEY (from_unit, to_unit, category)
);

-- Effective-dated. The 56th Council's Notification 9/2025-CT(R) moved cement
-- 28% -> 18% overnight on 2025-09-22; a rate hardcoded in TypeScript would have
-- made every quote wrong by ten points.
CREATE TABLE IF NOT EXISTS gst_rate (
  hsn            TEXT NOT NULL,
  category       TEXT NOT NULL,
  rate_bp        INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 4000),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  citation       TEXT NOT NULL,
  label          TEXT NOT NULL CHECK (label IN ('VERIFIED','INFERRED','ASSUMPTION')),
  note           TEXT,
  PRIMARY KEY (hsn, category, effective_from)
);

-- Government Schedule of Rates — the reference line no competitor shows.
CREATE TABLE IF NOT EXISTS sor_rate (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  state_code       TEXT NOT NULL,
  category         TEXT NOT NULL,
  item             TEXT NOT NULL,
  rate_paise       INTEGER NOT NULL,
  unit             TEXT NOT NULL,
  effective_period TEXT NOT NULL,
  source_url       TEXT NOT NULL,
  document         TEXT,
  fetched_at       TEXT NOT NULL,
  note             TEXT
);
CREATE INDEX IF NOT EXISTS sor_lookup ON sor_rate(state_code, category);

-- ─── supply ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor (
  vendor_id   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  seller_type TEXT NOT NULL,               -- dealer|stockist|marketplace_seller|brand|platform|kiln
  locality    TEXT,
  city        TEXT,
  region_id   TEXT REFERENCES region(region_id),
  lat         REAL,
  lon         REAL,
  geo_confidence TEXT NOT NULL CHECK (geo_confidence IN ('quoted','derived','typical','unknown')),
  rating         REAL,
  review_count   INTEGER,
  profile_url    TEXT,
  free_delivery_threshold_paise INTEGER,   -- only where the vendor actually publishes one
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS vendor_region ON vendor(region_id, platform);

CREATE TABLE IF NOT EXISTS product (
  product_id     TEXT PRIMARY KEY,
  item_code      TEXT NOT NULL,            -- normalised substitutability key
  category       TEXT NOT NULL,            -- cement|tmt_steel|water_pipes|bricks_blocks
  category_path  TEXT NOT NULL,
  title          TEXT NOT NULL,            -- generated from attributes, never free text
  brand          TEXT,
  model          TEXT,
  attrs          TEXT NOT NULL DEFAULT '{}',  -- JSON typed spec tuple
  unit_canonical TEXT NOT NULL,            -- NOT NULL by design
  unit_trade     TEXT NOT NULL,
  pack_size      REAL,
  pack_unit      TEXT,
  unit_weight_kg REAL,                     -- for freight chargeable weight
  unit_volume_m3 REAL,                     -- for volumetric weight
  hsn            TEXT NOT NULL,
  gst_rate_bp    INTEGER NOT NULL,
  qco_regulated  INTEGER NOT NULL DEFAULT 0,
  qco_citation   TEXT,
  cert_standards TEXT,                     -- JSON array of IS codes
  country_of_origin TEXT,
  volatility_class  TEXT NOT NULL CHECK (volatility_class IN ('V0','V1','V2','V3')),
  image_url      TEXT,
  datasheet_url  TEXT,
  search_blob    TEXT NOT NULL,            -- Latin + Telugu + Devanagari + transliteration
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS product_cat  ON product(category);
CREATE INDEX IF NOT EXISTS product_brand ON product(category, brand);
CREATE UNIQUE INDEX IF NOT EXISTS product_item_code ON product(item_code);

CREATE TABLE IF NOT EXISTS offer (
  offer_id       TEXT PRIMARY KEY,
  product_id     TEXT NOT NULL REFERENCES product(product_id),
  vendor_id      TEXT NOT NULL REFERENCES vendor(vendor_id),
  region_id      TEXT NOT NULL REFERENCES region(region_id),
  platform       TEXT NOT NULL,
  source_id      TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  source_ref     TEXT,
  -- The seller's own words for this listing, verbatim. product.title is
  -- synthesised from resolved attributes and is deliberately uniform; this is
  -- what the seller actually wrote. Without it the vendor table cannot say what
  -- was bought, and entity-resolution errors are invisible from the database.
  listing_title  TEXT,

  -- price as the seller states it, in the unit the seller states it in
  base_paise     INTEGER NOT NULL CHECK (base_paise >= 0),
  base_unit      TEXT NOT NULL,
  base_qty       REAL NOT NULL DEFAULT 1,
  -- the same price expressed per canonical unit, with the conversion recorded
  -- in spec_value as a `derived` row carrying its arithmetic
  base_paise_canonical INTEGER NOT NULL CHECK (base_paise_canonical >= 0),
  -- canonical units inside one trade unit: 1 for a cement bag, 10.66 for a
  -- 12 m 12 mm rod, 3.0 for a 3 m pipe length
  trade_multiple REAL NOT NULL DEFAULT 1,
  gst_treatment  TEXT NOT NULL CHECK (gst_treatment IN ('INCL','EXCL')),
  gst_rate_bp    INTEGER NOT NULL,
  hsn            TEXT NOT NULL,
  mrp_paise      INTEGER,                  -- distinct field; never render base as MRP
  delivery_scope TEXT NOT NULL CHECK (delivery_scope IN ('EX_WORKS','DELIVERED_ZONE','DELIVERED_SITE')),

  moq_qty        REAL,
  moq_unit       TEXT,
  bulk_slabs     TEXT,                     -- JSON [{min_qty,max_qty,paise}]
  stock_state    TEXT NOT NULL,            -- in_stock|out_of_stock|on_request|unknown
  lead_time_days INTEGER,

  cert_state     TEXT NOT NULL CHECK (cert_state IN
                   ('CERTIFIED','BRAND_LICENSED','NOT_DECLARED','NOT_APPLICABLE','EXPIRED')),
  cert_ref       TEXT,
  cert_valid_to  TEXT,

  rating         REAL,
  review_count   INTEGER,
  images         TEXT,                     -- JSON array
  datasheet_url  TEXT,

  fetched_at        TEXT NOT NULL,
  collection_run_id TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source_id, source_ref)
);
CREATE INDEX IF NOT EXISTS offer_product ON offer(product_id, is_active);
CREATE INDEX IF NOT EXISTS offer_region  ON offer(region_id, is_active);
CREATE INDEX IF NOT EXISTS offer_vendor  ON offer(vendor_id);

-- Per (offer, destination region) delivery solve. Deterministic, from freight.ts.
CREATE TABLE IF NOT EXISTS serviceability (
  offer_id       TEXT NOT NULL REFERENCES offer(offer_id),
  region_id      TEXT NOT NULL REFERENCES region(region_id),
  deliverable    INTEGER NOT NULL,
  lead_time_days INTEGER,
  freight_paise  INTEGER NOT NULL,
  handling_paise INTEGER NOT NULL,
  loading_paise  INTEGER NOT NULL,
  vehicle_class  TEXT NOT NULL,            -- tempo|6_tyre|10_tyre|parcel
  distance_km    REAL NOT NULL,
  distance_band  TEXT NOT NULL,
  chargeable_kg  REAL NOT NULL,
  basis          TEXT NOT NULL,            -- 'computed' | 'seeded_fallback' | 'vendor_published'
  breakdown      TEXT NOT NULL,            -- JSON: the arithmetic, shown one tap away
  PRIMARY KEY (offer_id, region_id)
);

-- ─── prices ───────────────────────────────────────────────────────────────────

-- The materialised price surface. normalised_paise is a stored column, not a
-- computed-at-query-time expression — it is what search ranks, filters and
-- bands on, and recomputing it per row per query is the thing that breaks the
-- latency budget.
CREATE TABLE IF NOT EXISTS price_current (
  product_id      TEXT NOT NULL REFERENCES product(product_id),
  region_id       TEXT NOT NULL REFERENCES region(region_id),
  tier            TEXT NOT NULL DEFAULT 'standard',
  best_offer_id   TEXT NOT NULL REFERENCES offer(offer_id),

  base_paise      INTEGER NOT NULL,
  gst_paise       INTEGER NOT NULL,
  freight_paise   INTEGER NOT NULL,
  handling_paise  INTEGER NOT NULL,
  loading_paise   INTEGER NOT NULL,
  landed_paise    INTEGER NOT NULL,        -- base+gst+freight+handling+loading, for one trade unit
  normalised_unit TEXT NOT NULL,
  normalised_paise INTEGER NOT NULL,       -- landed per canonical unit — the ranking number

  floor_paise     INTEGER NOT NULL,        -- lowest comparable normalised in this region
  ceiling_paise   INTEGER NOT NULL,        -- highest comparable
  median_paise    INTEGER NOT NULL,
  offer_count     INTEGER NOT NULL,
  vendor_count    INTEGER NOT NULL,

  delivery_scope  TEXT NOT NULL,           -- part of the comparability key
  gst_treatment   TEXT NOT NULL,           -- part of the comparability key
  priced_as_of    TEXT NOT NULL,
  sla_hours       INTEGER NOT NULL,
  reason_code     TEXT NOT NULL,           -- CP(EC) Rule 4(11): why this zone differs
  PRIMARY KEY (product_id, region_id, tier)
);

-- Product photography, with the same provenance rule as every other field.
--
-- One row per distinct ASSET, not per URL: imimg serves the same photograph at
-- 125/250/500/1000 and the bare original, so `asset_key` is the path with the
-- size suffix stripped and it is what deduplicates. `local_path` is a file this
-- repo owns — images are downloaded during collection so the demo renders with
-- no third-party request at view time, and so a card cannot quietly break when
-- a marketplace changes its hotlink policy.
CREATE TABLE IF NOT EXISTS product_image (
  asset_key    TEXT NOT NULL,             -- size-stripped path; the identity
  product_id   TEXT NOT NULL REFERENCES product(product_id),
  offer_id     TEXT REFERENCES offer(offer_id),   -- whose listing it came from
  source_url   TEXT NOT NULL,             -- the exact remote file fetched
  page_url     TEXT,                      -- the listing page it was found on
  local_path   TEXT,                      -- /img/<sha1>.jpg once downloaded
  width        INTEGER,                   -- the variant actually taken
  kind         TEXT NOT NULL DEFAULT 'photo'
                 CHECK (kind IN ('photo','datasheet','generic')),
  rank         INTEGER NOT NULL DEFAULT 100,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (product_id, asset_key)
);
CREATE INDEX IF NOT EXISTS product_image_lookup ON product_image(product_id, kind, rank);

-- Which listing pages have already been read for their gallery.
--
-- The image collector is resumable because IndiaMART trips a circuit breaker
-- partway through a run. Without this log a second run would re-read the same
-- pages in the same order — the pages are chosen "fewest pictures first", and
-- pictures found are not written back to the ordering input — so it would spend
-- its whole budget re-fetching what it already had.
CREATE TABLE IF NOT EXISTS image_page_log (
  page_url     TEXT PRIMARY KEY,
  read_at      TEXT NOT NULL,
  assets_found INTEGER NOT NULL DEFAULT 0
);

-- The same money, per offer rather than per product.
--
-- price_current answers "what does this product cost here" and stays the source
-- of the floor/ceiling/median summary. This answers "what does this seller
-- charge", which is what a vendor-led results list ranks on. rebuildPrices
-- already computes landedFor() on every offer in order to pick the best one;
-- this only writes that result down, so the query path never solves freight.
CREATE TABLE IF NOT EXISTS offer_price (
  offer_id        TEXT NOT NULL REFERENCES offer(offer_id),
  region_id       TEXT NOT NULL REFERENCES region(region_id),
  tier            TEXT NOT NULL DEFAULT 'standard',
  product_id      TEXT NOT NULL REFERENCES product(product_id),
  vendor_id       TEXT NOT NULL REFERENCES vendor(vendor_id),

  base_paise      INTEGER NOT NULL,
  gst_paise       INTEGER NOT NULL,
  freight_paise   INTEGER NOT NULL,
  handling_paise  INTEGER NOT NULL,
  loading_paise   INTEGER NOT NULL,
  landed_paise    INTEGER NOT NULL,
  normalised_unit TEXT NOT NULL,
  normalised_paise INTEGER NOT NULL,       -- the ranking number for this seller

  delivery_scope  TEXT NOT NULL,
  gst_treatment   TEXT NOT NULL,
  priced_as_of    TEXT NOT NULL,
  sla_hours       INTEGER NOT NULL,
  PRIMARY KEY (offer_id, region_id, tier)
);
CREATE INDEX IF NOT EXISTS offer_price_rank ON offer_price(region_id, normalised_paise);
CREATE INDEX IF NOT EXISTS offer_price_vendor ON offer_price(region_id, vendor_id, normalised_paise);
-- The index the search query actually runs on.
CREATE INDEX IF NOT EXISTS pc_rank ON price_current(region_id, normalised_paise);
CREATE INDEX IF NOT EXISTS pc_fresh ON price_current(region_id, priced_as_of);

CREATE TABLE IF NOT EXISTS price_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id       TEXT NOT NULL,
  region_id        TEXT NOT NULL,
  offer_id         TEXT,
  normalised_unit  TEXT NOT NULL,
  normalised_paise INTEGER NOT NULL,
  landed_paise     INTEGER NOT NULL,
  base_paise       INTEGER NOT NULL,
  observed_at      TEXT NOT NULL,
  collection_run_id TEXT NOT NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('schedule','seed','user_verify','backfill'))
);
CREATE INDEX IF NOT EXISTS ph_series ON price_history(product_id, region_id, observed_at);

-- ─── provenance ───────────────────────────────────────────────────────────────

-- One row per field per product/offer. A field with no provenance cannot render:
-- the UI reads value/unit/source_url/fetched_at/confidence together or not at all.
-- offer_id = '' means the fact is product-level rather than offer-level.
CREATE TABLE IF NOT EXISTS spec_value (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL REFERENCES product(product_id),
  offer_id    TEXT NOT NULL DEFAULT '',
  field       TEXT NOT NULL,
  label       TEXT NOT NULL,
  value       TEXT NOT NULL,
  unit        TEXT,
  source_url  TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  confidence  TEXT NOT NULL CHECK (confidence IN ('quoted','derived','typical','unknown')),
  derivation  TEXT,                        -- the arithmetic, when confidence='derived'
  UNIQUE (product_id, offer_id, field)
);
CREATE INDEX IF NOT EXISTS sv_product ON spec_value(product_id);

-- ─── facets ───────────────────────────────────────────────────────────────────

-- Loaded from filters/<category>.json. Counts are rewritten from real DB
-- aggregates by scripts/reconcile-filters.ts — a filter with no data behind it
-- is a defect, so it ships disabled with a reason rather than lying.
CREATE TABLE IF NOT EXISTS facet_definition (
  category        TEXT NOT NULL,
  facet_id        TEXT NOT NULL,
  facet_key       TEXT NOT NULL,
  label           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('single','multi','range','boolean')),
  control         TEXT NOT NULL,
  cluster         TEXT NOT NULL,
  visibility      TEXT NOT NULL CHECK (visibility IN ('primary','more','conditional')),
  sort_order      INTEGER NOT NULL,
  depends_on_facet TEXT,
  depends_on_value TEXT,
  default_open    INTEGER NOT NULL DEFAULT 1,
  default_state   TEXT,
  why             TEXT,
  note            TEXT,
  needs_verification TEXT,
  values_json     TEXT NOT NULL,
  PRIMARY KEY (category, facet_id)
);

-- ─── collection bookkeeping ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS collection_run (
  run_id            TEXT PRIMARY KEY,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  mode              TEXT NOT NULL CHECK (mode IN ('seed','scheduled','manual')),
  status            TEXT NOT NULL CHECK (status IN ('running','ok','partial','failed')),
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  sources_ok        INTEGER NOT NULL DEFAULT 0,
  sources_blocked   INTEGER NOT NULL DEFAULT 0,
  offers_captured   INTEGER NOT NULL DEFAULT 0,
  offers_new        INTEGER NOT NULL DEFAULT 0,
  offers_vanished   INTEGER NOT NULL DEFAULT 0,
  vendors_new       INTEGER NOT NULL DEFAULT 0,
  -- how many fields landed on each rung of the missing-data ladder
  ladder_quoted     INTEGER NOT NULL DEFAULT 0,
  ladder_derived    INTEGER NOT NULL DEFAULT 0,
  ladder_typical    INTEGER NOT NULL DEFAULT 0,
  ladder_unknown    INTEGER NOT NULL DEFAULT 0,
  notes             TEXT
);

-- No silent caps. Every block, rate-limit, truncated pagination and login wall
-- gets a row here with an honest estimate of the volume missed.
CREATE TABLE IF NOT EXISTS source_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL REFERENCES collection_run(run_id),
  source_id     TEXT NOT NULL,
  source_class  TEXT NOT NULL CHECK (source_class IN
                  ('marketplace','b2b_directory','platform','brand','government','dealer','tracker')),
  category      TEXT,
  region_id     TEXT,
  url           TEXT NOT NULL,
  fetch_mode    TEXT NOT NULL CHECK (fetch_mode IN ('http','browser','assisted')),
  http_status   INTEGER,
  outcome       TEXT NOT NULL CHECK (outcome IN
                  ('ok','blocked','rate_limited','login_wall','parse_fail','empty','skipped','captcha')),
  offers_captured      INTEGER NOT NULL DEFAULT 0,
  pages_fetched        INTEGER NOT NULL DEFAULT 0,
  pagination_exhausted INTEGER,
  estimated_missed     INTEGER,
  note          TEXT,
  fetched_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sl_run ON source_log(run_id, outcome);

CREATE TABLE IF NOT EXISTS search_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  q         TEXT NOT NULL,
  region_id TEXT,
  hits      INTEGER NOT NULL,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sq ON search_log(q);

-- ─── search index ─────────────────────────────────────────────────────────────

-- Standalone rather than external-content: the catalogue is small enough that
-- the duplicated text costs nothing, and it removes the sync-trigger failure mode.
CREATE VIRTUAL TABLE IF NOT EXISTS product_fts USING fts5(
  product_id UNINDEXED,
  title,
  brand,
  blob,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Typo tolerance. 'ultratec' matches 'UltraTech'; 'astrel' matches 'Astral'.
CREATE VIRTUAL TABLE IF NOT EXISTS product_trgm USING fts5(
  product_id UNINDEXED,
  blob,
  tokenize = 'trigram'
);
