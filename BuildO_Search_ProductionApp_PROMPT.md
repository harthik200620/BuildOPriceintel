# BuildO Price Intelligence — production web application

**A complete, self-contained brief.** Hand this to an engineering team with no other context. Everything needed to build the production system is here: the architecture, the component tree and design tokens as actually built, the search and ranking behaviour, the data contracts, the migration path off local SQLite, and an explicit list of what the local demo simplified.

A working reference implementation exists at `~/Desktop/BuildO-PriceIntel` — Next.js + TypeScript + Tailwind over SQLite, with the collector, the freight model, the benchmark and the daily refresh job. Read it. It is not a mock: it holds real collected prices with provenance on every field, and the three laws below are asserted by its test suite.

---

## 0. What you are building

A search engine for construction-material prices. A user enters a query and a pincode and receives **the delivered price, in a canonical unit, with the GST basis stated and a verification timestamp**. It depends on no design tool, no BOQ and no other product.

The wedge is one sentence from the competitive audit: across fifteen Indian platforms — IndiaMART, Infra.Market, Moglix, JSW One, Tata Aashiyana, BuildersMART, BigBMart, ConstructionKart and the rest — **not one shows a delivered, pincode-resolved, GST-stated, unit-normalised, timestamped price for a single construction SKU.** Each fails differently:

| Failure observed | Requirement it creates |
|---|---|
| IndiaMART: ₹215–₹300/bag for the same commodity on one page, no grade normalisation | One canonical price per (SKU, zone) with a stated method |
| IndiaMART: seven pricing units on one sand page (₹2,500/Tonne beside ₹70/CFT — a 2× gap hidden entirely by unit mismatch) | Canonical unit + conversion table, both units displayed |
| IndiaMART: PDP says "Excluding all taxes"; category pages say nothing | Three stored fields: `base_ex_gst`, `gst_rate`, `price_incl` |
| IndiaMART: TMT listings ₹41.30–₹57/kg, entirely undated | Per-line `priced_as_of`, visible in cart |
| IndiaMART: MOQ field unpopulated on every listing fetched | Reject or flag lines whose quantity is below supplier MOQ |
| Infra.Market (~$804M raised): no price for anything — AAC page ends in "ENQUIRE NOW !" | Our wedge is not "cheaper". It is *the price is on the screen, with its basis and its date* |
| JSW One MSME: "To add to cart and submit requirements Login" | Price before login, before quantity |
| Moglix: best GST disclosure found ("₹422 + ₹77 GST") but no normalised unit | `coverage_per_pack` mandatory so ₹/m² is computable |
| BigBMart: "River Sand ₹2,450" with no unit at all — per tonne / per brass differ ~4.5× | `unit` is `NOT NULL` |
| ConstructionKart (Telangana): checkout reads "Free Shipping for orders over $20" | The default-template energy the brand section forbids |

---

## 1. The three laws

These are not guidelines. Two of the three are asserted by `tests/run.ts` in the reference build; the third is enforced by the type system.

### Law 1 — the query path never calls out

A user-initiated read (autocomplete, search, category, PDP, compare) **never** issues an outbound request to Amazon, Flipkart, Google, Moglix or any external source. Every price on screen is served from our own store, populated asynchronously.

The arithmetic, because it is the whole argument:

- **Latency.** Fan-out is 60 outbound calls. Observed Indian marketplace fetch latency: HTML p50 ≈ 700 ms / p95 ≈ 2,800 ms; JS-rendered p50 ≈ 3,200 ms / p95 ≈ 8,000 ms. At outbound concurrency 10 that is 6 serial batches — **best-case p95 ≈ 16,800 ms against a 200 ms target, 84× over.**
- **Supply.** At the Year-3 north star of 1 lakh concurrent → ~1,500 searches/sec → ~90,000 outbound calls/sec. Total sanctioned headroom across every Indian API combined is ~30 calls/sec. We would need 3,000× the entire sanctioned supply of the market.
- **Cost.** At $1.50/1k records, Year-1 traffic is ~$810,000/month against a $4,655/month platform budget — 174× the whole infrastructure bill.
- **Law.** Amazon's Associates agreement caps caching at 24 h and requires re-fetch before re-display, so live fetch is the only compliant use, and live fetch is impossible. That is deliberate design by Amazon to prevent exactly this product.

The single exception is an explicit user-tapped **"Verify this price now"** on a PDP offer row: 3/user/hour, 20/user/day, 2 per (SKU, source)/hour globally, 12 s timeout, 15-minute result cache, behind a monthly vendor-spend circuit breaker at $6,030.

*Implementation.* The reference build ships `lib/no-network.ts`, which replaces `globalThis.fetch` on the request path with one that throws and records the offending URL. Keep this. It converts a rule everyone agrees with into one nobody can accidentally break.

### Law 2 — every displayed price carries a unit basis and a freshness timestamp

Enforced in the type system, not in review. The `Money` component cannot be called without a unit; a product card cannot be constructed without `{unit_canonical, delivery_scope, gst_treatment, gst_rate_bp, hsn, priced_as_of, freshness_state}`. There is deliberately no code path that puts a bare rupee figure on screen.

### Law 3 — the price search shows is the price the cart bills

One function is the only thing in the system that may state a rupee figure:

```
resolve_price(sku_id, zone_id, qty, tier, as_of) -> SignedQuote
```

The search results page, the category price table, the product page, the compare tray, the saved list and the cart all call it. No service computes a rupee any other way and no client is permitted to arithmetic its own total from components. A design tool, an ERP integration or a partner API becomes one more caller, not a second implementation.

---

## 2. Price truth — the decision that wins the category

### The canonical price object

All money is **integer paise**. No float touches a rupee anywhere. A cart total that differs from the sum of its lines by a rupee is a dispute on a signed contract.

| Field | Rule |
|---|---|
| `base_ex_gst_paise` | The supplier's price excluding GST. B2B listings populate this |
| `mrp_incl_all_taxes_paise` | **A distinct field.** Never render `base_ex_gst` as MRP (LMPC Rule 6(1)(e)) |
| `hsn`, `gst_rate_bp` | From the effective-dated rate table, never a constant in code |
| `gst_paise` | `round_half_up(base × rate)` |
| `freight_paise` | From the freight model; `per_trip` amortised across the line and disclosed as amortised |
| `handling_paise`, `loading_paise` | Separately itemised — never folded into base (basket-sneaking risk) |
| `landed_incl_all_paise` | `base + gst + freight + handling + loading`. **The number ranked and billed on** |
| `normalised_unit`, `normalised_paise` | Landed price per canonical unit. Computed, never stored from a source |
| `delivery_scope` | `EX_WORKS` \| `DELIVERED_ZONE` \| `DELIVERED_SITE` — part of the comparability key |

### Display order — the seller's price first, then the total

Every surface shows **two figures, always together, in this order**: the seller's quoted price, then the delivered total. Neither is ever hidden and neither is ever the only figure on screen.

Two reasons. **The market speaks in the seller's price** — every dealer in India quotes ex-works, ex-GST, so leading with the delivered total makes us look 25% more expensive than a dealer quoting the identical pipe, punished for being honest. And **a total with no visible components is just a different opaque number.** The point is not to replace the market's figure with ours; it is to show the market's figure and finish the sentence.

This is not drip pricing. Drip pricing reveals cost elements *later in the journey*. Here every component is on the same screen, at the same time, before any add-to-cart — satisfying CP(E-Commerce) Rule 6(5) and the CCPA Dark Patterns Guidelines 2023 simultaneously.

### Basis parity, enforced in code

```
comparable(a, b) <=> a.normalised_unit == b.normalised_unit
                   & a.delivery_scope  == b.delivery_scope
                   & a.gst_treatment   == b.gst_treatment
                   & |a.priced_as_of - b.priced_as_of| <= max(sla(a), sla(b))
```

If the predicate is false the API returns **`422 NOT_COMPARABLE`** and the UI renders the offers in separate groups with an explanatory divider. It never places them in one sorted list. Sorting incomparable prices is the single most common failure in this market and it is a correctness bug, not a UX preference.

### The worked example — the error being removed

Astral CPVC SDR-11, 25 mm nominal, 3 m, qty 40, delivered to Vijayawada:

| Component | ₹ |
|---|---:|
| `base_ex_gst` | 402.00 |
| GST @ 18% (HSN 3917) | 72.36 |
| Freight to zone, per unit | 18.00 |
| Handling | 6.00 |
| Loading / unloading | 4.00 |
| **`landed_incl_all` per length** | **502.36** |
| **`normalised` — per running metre** | **167.45** |

A competitor comparing the ex-GST ₹402 against our delivered ₹502.36 shows a **25.0% understatement**. On a 412-line house that is lakhs.

### Units — a table, never arithmetic

Fifteen canonical units; every SKU maps to exactly one and `unit_canonical` is `NOT NULL`. Conversions are **per category** because the trade's inch-to-mm mapping is not arithmetic:

- **1″ CPVC = 25 mm nominal bore**, but **4″ SWR = 110 mm outside diameter**. Naive ×25.4 gets both wrong.
- Sand: 1 unit = 1 brass = 100 CFT = 2.83 m³ ≈ 4.53 t. The unitless ₹2,450 listing could mean ₹2,450/t or ₹2,450/brass — a 4.5× difference.
- Cement: ₹/bag ↔ ₹/t at 20 bags/t. Tiles: ₹/box ↔ ₹/m² needs `pieces_per_box` and `piece_area_m2`. Wire: 90 m/coil. Paint: `coverage_m2_per_litre` and coats.
- TMT: per-rod ↔ ₹/kg needs IS 1786 nominal mass (8 mm = 0.395 kg/m, 12 mm = 0.888, 25 mm = 3.854).

Ship the conversion table with tests. The reference build's `tests/run.ts` asserts the 4″-SWR case explicitly, because it is the one a plausible-looking refactor will silently break.

---

## 3. Ranking

A **published linear function over nine features with four penalties**, reranked by an ONNX learning-to-rank model over the top 200. The base ranker stays explainable because CP(E-Commerce) **Rule 5(3)(f)** requires the main parameters to be stated in plain language, and a black box cannot do that honestly.

| # | Feature | Weight | Definition |
|---|---|---:|---|
| f1 | Semantic + lexical relevance | 0.28 | Score-normalised hybrid: `0.4·norm(BM25) + 0.6·norm(cosine)` from one hybrid query |
| f2 | Attribute match | 0.16 | Fraction of query-extracted typed attributes matched exactly; exact tuple = 1.0 |
| f3 | Landed-price percentile in zone | 0.14 | `1 − percentile(normalised_landed_paise)` among comparable offers |
| f4 | In-zone availability & serviceability | 0.10 | 1.0 deliverable and in stock; 0.5 lead time > 7 d; 0.0 not deliverable |
| f5 | Trust | 0.10 | `0.5·shrunk_rating + 0.3·seller_reliability + 0.2·log1p(reviews)/log1p(500)`, prior n₀ = 20 |
| f6 | Certification | 0.07 | `CERTIFIED` 1.0 · `NOT_APPLICABLE` 0.7 · `NOT_DECLARED` 0.3 · `EXPIRED` 0.0 |
| f7 | Delivery ETA | 0.06 | `exp(−lead_time_days / 7)` |
| f8 | Sales velocity | 0.05 | Bayesian-smoothed 28-day orders, α = 50 |
| f9 | Price freshness | 0.04 | `1 − clip(age / sla, 0, 1)` |

**Penalties:** stale price −0.25 · out of stock in zone −0.60 · MOQ above line quantity −0.35 · missing licence in a QCO-regulated category is a **hard filter**.

**Diversity damping:** 3rd and subsequent results from one seller ×0.85, 5th onward ×0.70; no seller holds more than 4 of the first 10. Applied post-scoring in a reorder pass so it stays explainable.

**Tie-breaks, in order:** lower normalised landed price → fresher price → higher certification tier → higher trust → stable hash of `offer_id`, so pagination is deterministic and A/B buckets do not drift.

**Cold start.** With no order history f8 is a constant and therefore inert. Redistribute its weight to f1 (+0.03) and f3 (+0.02) until a category accumulates ≥200 orders, then activate f8 for that category only. The reference build ships exactly this as `COLD_START_WEIGHTS`. Relevance labels for launch come from 1,200 human-judged query-document pairs across 40 head queries, three judges, majority vote, κ reported.

**Sorts.** Default *Recommended*. One-tap: Lowest landed price (f3 only, comparability-grouped) · Best value (`0.5·f3 + 0.3·f5 + 0.2·f6`) · Highest rated (f5, min 10 reviews) · Fastest delivery (f7) · Most bought (f8, min 30 orders). Every sort keeps the hard filters and states what it sorted on, next to the control.

**Every result carries a "why this is here" chip** naming its top two contributing features in plain language.

**Evaluation.** Offline: 400 queries × top-20 judgments graded 0–3; primary NDCG@10; guardrails *basis-error rate* (target 0) and *stale-exposure rate* (target < 2%). Any weight change must pass NDCG@10 non-inferiority (Δ ≥ −0.005) plus both guardrails. Online: team-draft interleaving for direction, full A/B for anything touching price features, with add-to-cart and cart-to-order as primary and **return/complaint rate as the counter-metric that catches a ranking which sells the wrong thing.**

**Rejected, with the reason:** Reciprocal Rank Fusion (k=60) for the hybrid — OpenSearch's own benchmark shows RRF averaging **3.86% lower NDCG@10** than score-normalised hybrid across six BEIR datasets. RRF stays as the automatic fallback when normalisation statistics are unavailable (cold index, new zone).

### Certification is a label, not a gate

**Do not hide uncertified goods.** Most of the Indian construction market is legal, everyday material carrying no BIS mark: local bricks, laterite blocks, river sand, aggregate, wooden props, fabricated items. BuildO's own source product list contains 994 items under a `LOCAL PRODUCTS` heading. A broad certification filter would delete half the market and substitute our judgement for the customer's. The facet defaults to **off**.

The exception is legal, not editorial. Where a **Quality Control Order** makes BIS certification a condition of lawful sale, a product without a valid licence is not a cheaper option — it is a product that cannot legally be sold. Confirmed: cement (Cement (Quality Control) Order 2003, S.O. 191(E) — *named in a secondary source; read the gazette*), and IS 1786 deformed bars (mandatory confirmed; the instrument number was **not** identified). `sku.qco_regulated` is a **versioned data table with one citation per row**, re-checked quarterly, never a constant in code.

**One state the demo added and production should keep.** Almost no listing publishes a licence number. `BRAND_LICENSED` records the honest middle: *the manufacturer holds a licence for this IS code, but this listing does not quote it*. It is a different claim from `CERTIFIED` and from `NOT_DECLARED`, and the hard filter fires only on positive evidence of expiry — never on a listing that is merely silent. Without this distinction the QCO gate deletes essentially all real supply.

---

## 4. Search quality for India

**Transliteration and code-switching.** Four indexes per SKU: Latin, Devanagari, Telugu, and a **phonetic key** generated with an Indic-aware scheme (Metaphone-family adapted for retroflex/aspirated distinctions), so `पाइप`, `paip`, `pipu`, `paipu` all reach `pipe`. `sariya` → TMT bar; `ఇటుక` / `itaka` / `eeta` → brick; `chuna` → lime; `kadapa stone` → Kadappa limestone slab. A **bilingual synonym table maintained as data with tests**, never as model behaviour.

**Unit-bearing queries.** A grammar-based parser runs before retrieval and emits **typed constraints, never a text match**:

| Query | Parsed |
|---|---|
| `1 inch cpvc pipe` | `nominal_bore_mm=25`, `material=CPVC`, `l2=pipes` |
| `cement 50kg price` | `pack_size_kg=50`, `l3=cement`, `intent=price` |
| `4 inch pvc pipe rate` | `nominal_bore_mm=110` (**OD, from the table — not ×25.4**), `intent=price` |
| `fe500 8mm rod 12m` | `grade=Fe500`, `dia_mm=8`, `length_m=12` |
| `aac block 600x200x100` | `size_mm=600×200×100` |

`intent=price` promotes the price table to the top of the results page.

**Typos and brand aliases.** SymSpell-class edit-distance-2 correction over the catalogue vocabulary with frequency weighting, plus a curated alias table (`ultratec` / `ultra tech`; `jaquar` / `jaguar`; `astral` / `astrel`). **Corrections are shown, never applied silently:** *"showing results for **ultratech** — search instead for ultratec"*.

**Zero results are never a dead end.** The ladder: relax the least-selective typed constraint → widen to the parent category with a note → offer the nearest category's price table → offer "request this item", which writes to a demand log that feeds catalogue expansion. Zero-result rate is an SLO (< 1.5%) with a weekly review of the top 50 zero-result queries.

**Autocomplete with in-zone price previews.** Per-pod in-memory FST over `(prefix → suggestion)`, rebuilt nightly from the query log plus the catalogue, with a live price preview on the right of each suggestion (`cpvc pipe 25mm — from ₹167/m`) read from the hot store in the same request. Suggestions are zone-scoped. ≥70% of prefixes serve from the CDN edge on a 60 s TTL.

**Rejected:** an LLM query-understanding call on every search. Latency alone kills it (200–600 ms is three times the entire budget), and an LLM that parses `4 inch` into a bore in millimetres is *inventing a dimension*. The LLM's legitimate job here is **offline**: mining the query log to propose new synonyms, aliases and unit mappings for human approval into the tables.

---

## 5. Freshness

A **demand-and-volatility-weighted priority scheduler**, not a nightly sweep.

| Class | Contents | SLA | Why |
|---|---|---|---|
| **V0 commodity** | Cement, sand, aggregate, bricks/blocks, steel/TMT, RMC | **24 h** | Cement moved +₹15–20/bag in one month; TMT ±5–11% MoM, **+34.5% trough-to-peak in six months** |
| **V1 volatile** | Pipes, wires & cables, paints, tiles, sanitaryware | **7 d** | Commodity-linked inputs; Havells revised three category list prices in 2026 alone |
| **V2 stable** | Fittings, hardware, switches, lights, fans, tools | **30 d** | List-price driven, 1–3 revisions/yr |
| **V3 inert** | Furniture, décor, soft furnishings | **90 d** | Catalogue pricing |

```
priority = 0.30·volatility_weight        (V0 1.00, V1 0.55, V2 0.25, V3 0.10)
         + 0.25·demand_score             (log1p(views_7d + 8·carts_7d + 30·orders_7d), min-max scaled)
         + 0.25·staleness_ratio          (age_hours / sla_hours, clipped at 3.0)
         + 0.15·in_open_cart_or_list
         + 0.05·price_shock_neighbourhood
```

The `in_open_cart_or_list` term is what makes refresh feel personal: **a SKU sitting in somebody's cart is re-checked before a SKU nobody is looking at.** It costs nothing to compute and it is the difference between a price that is fresh on average and one that is fresh where it matters.

**The degradation ladder — the user always knows.**

| State | Condition | UI |
|---|---|---|
| `FRESH` | `age < 0.5 × SLA` | Price, grey timestamp: "verified 4 h ago" |
| `AGEING` | `0.5 × SLA ≤ age < SLA` | Price, amber dot: "verified 3 d ago · refreshes within 4 d" |
| `STALE` | `SLA ≤ age < 3 × SLA` | Price **struck to secondary weight**, one-tap Verify now, −0.25 rank penalty, **excluded from the headline "from ₹"** |
| `EXPIRED` | `age ≥ 3 × SLA` | **No price.** "Price not current — verify" only. Cannot be carted |

There is no state in which a stale price is presented as current.

**Price shocks.** Above the class threshold (V0 3%, V1 5%, V2/V3 10%), emit `PriceShockDetected`. Cart lines hold a `quote_id`, not a number, with `hold_until` of 24 h (V0) / 7 d (V1) / 30 d (V2–V3) and a 0.4%-of-GMV absorption budget. At expiry the cart shows a **reviewable diff** — *"cement ×180 bags: ₹408 → ₹431 (+5.6%), +₹4,140. Accept / choose alternatives / hold 24 h more."* **Never silently repriced** — silent repricing is basket sneaking. A **placed order never reprices**; escalation runs through the contract's own clause against a published index, and the engine supplies the index value and the evidence, not a new number.

**Three guards against our own pipeline corrupting a price.** An **absurdity gate** quarantining anything outside [0.1×, 10×] of the trailing 30-day median (shipped in the demo — it is what caught a waterproofing compound mis-filed as a ₹182/bag cement); a **60-SKU canary set** checked every 15 minutes; and **parser-version pinning** requiring a 1,000-body archived replay before a parser touches live data. Degradation is always to an older price honestly labelled, never to a wrong price shown as right.

---

## 6. Data contracts

```http
GET /api/v1/search?q=pipe&pincode=520010&page=1&sort=recommended&facets=...
200 {
  "query": { "raw":"pipe", "parsed": {...}, "corrected_from": null, "zone_id":"z_ap_krishna_01" },
  "intent_chips": [ { "label":"Plumbing pipe", "category_path":"plumbing.pipes", "count":412 } ],
  "results": [ {
    "sku_id":"…", "title":"Astral Aquarius CPVC SDR-11 25 mm × 3 m",
    "price": { "landed_paise":50236,
               "normalised": { "unit":"running_metre", "paise":16745 },
               "delivery_scope":"DELIVERED_SITE", "gst_treatment":"INCL", "gst_rate_bp":1800,
               "priced_as_of":"2026-07-29T06:12:44Z", "freshness_state":"FRESH" },
    "cert": { "required":"IS 15778", "state":"CERTIFIED" },
    "why": ["closest match to 25 mm CPVC","lowest delivered price in your area"],
    "rank_debug_token":"rdt_…"
  } ],
  "facets": {...}, "comparability_groups": [...],
  "disclosure": { "sort":"recommended", "explainer_url":"/how-ranking-works" }
}

GET  /api/v1/sku/{sku_id}?pincode=520010&qty=40
POST /api/v1/price/resolve       { sku_id, pincode, qty, tier, as_of? } -> SignedQuote
POST /api/v1/price/resolve-bulk  { lines:[{sku_id,qty,tier}], pincode, list_id? }
                                 -> { quotes:[SignedQuote], blocked:[{sku_id,reason}], ledger_batch_id }
POST /api/v1/price/verify        { offer_id } -> 202 {job_id} | 200 {cached:true, …}
GET  /api/v1/price/history       ?sku_id&zone_id&from&to&granularity=day
POST /api/v1/price/alert         { sku_id, pincode, threshold_paise, direction, channel }
GET  /api/v1/serviceability      ?sku_id&pincode -> {deliverable, lead_time_days, moq, reason_code}
GET  /api/v1/quote/{quote_id}/proof -> {merkle_root, path[], published_at, root_url}
```

**Errors.** `409 QUOTE_BLOCKED` (uncertified in a QCO category, with the cited reason and a compliant alternative) · `422 NOT_COMPARABLE` (asked to sort across incompatible bases) · `425 PRICE_EXPIRED` · `429 VERIFY_RATE_LIMITED`. Every error carries a `message` **written for the customer, not the developer.**

**`SignedQuote` is a public API.** Versioned by `schema_version`, additive changes only; a breaking change requires a migration plan and a dual-write window, because signed quotes must remain verifiable for 7 years.

---

## 7. The UI, as built

### Design tokens — *Drafted Ground*

The brief: *"identity set down the way a site engineer sets down a boundary: with a thin, certain line, measured twice, drawn once."* Space is the first material. **Colour is a covenant: warm paper white as the ground, deep ink as the voice, and one terracotta accent — the colour of brick leaving the kiln — reserved for the single most meaningful gesture. The accent is never spent twice; its scarcity is its authority.**

On this product it is spent on **the normalised unit price**, and nowhere else.

```css
/* light — paper */                    /* dark — studio */
--paper:      #faf8f4;                 #14120f
--paper-2:    #f3efe8;                 #1c1915
--paper-3:    #ebe5db;                 #262119
--ink:        #191713;                 #f0ebe2
--ink-2:      #4a453d;                 #b3ab9d
--ink-3:      #8b8377;                 #7c7466
--rule:       #ded7cb;                 #322d26
--accent:     #b4441f;                 #d9613a
--accent-bg:  #f6ece7;                 #2a1b14
--fresh:      #3f7d4e;   --ageing: #b07d1c;   --stale: #8b8377;

--font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
--font-ui:      "Inter", "Segoe UI Variable Text", system-ui, sans-serif;
--font-figure:  "SF Mono", "Cascadia Mono", ui-monospace, Menlo, monospace;

--radius-draft: 2px;   /* ONE radius. Drafting precision, not softness. */
```

Rules: hairlines at 1px of even weight; architectural margins; blueprint grid and corner ticks used **sparingly** (the sheet, the tray, the empty states); every figure tabular-nums so columns of prices align to the decimal; motion 150–200 ms and purposeful; `prefers-reduced-motion` honoured.

### Component tree

```
app/layout.tsx                    theme set before first paint, no studio-mode flash
app/page.tsx                      shell + all state; 80 ms debounce; no spinner under 150 ms
  TopBar                          wordmark · SearchField · region segmented + pincode · theme
    SearchField                   Cmd/Ctrl+K focus; dropdown:
                                    - correction ("showing results for ultratech")
                                    - matched vocabulary glossed (ఇటుక -> brick)
                                    - typed constraints read back ("nominal bore = 110 mm")
                                    - category intent chips with counts
                                    - matched products, thumbnail + live unit price
                                    - recent searches · trending here
  FilterRail                      sticky 280px, collapsible
                                    - conditional facets render only when the parent is chosen
                                    - values DISABLE rather than vanish at zero
                                    - counts in a fixed-width column: no layout shift
                                    - "More filters" fold, capped at six
                                    - needs_verification renders an amber regulatory flag
  ResultsGrid
    ProductCard                   ONLY the main features:
                                    thumbnail · brand · title (2 lines) · 2-3 spec chips
                                    NORMALISED UNIT PRICE as the hero, largest type, accent
                                    landed line · best vendor +N more · ETA
                                    cert badge · freshness dot (exact time on hover)
                                    "why this is here" chip
                                    compare + save on hover, keyboard reachable
  DetailSheet                     side sheet desktop / full page mobile — now show everything
    price summary                 floor · current · ceiling · median, then the bill breakdown
    VendorTable                   EVERY vendor, none truncated; virtualised; 12 sortable columns;
                                  inline platform/stock/cert filters above 12 rows;
                                  per-row delivery breakdown and source link
    spec table                    provenance marker on EVERY row + source link
    PriceHistory                  line + range band, price-drop alert toggle
    BreakdownModal                the freight arithmetic, step by step
    certification block           always present, never blank
    substitutes · sources
  CompareTray                     docks at >=2; refuses to sort across bases and says why
  LatencyHUD                      dev only; live per-stage breakdown
  States                          skeletons matching final layout exactly · empty · zero-result
                                  · degraded · no-data-yet · error · offline
```

### Accessibility

Full keyboard navigation; visible focus rings on every interactive element; WCAG AA contrast in both themes; **every number labelled with its unit for screen readers** (`aria-label="₹167.45 per running metre"`); `aria-sort` on sortable columns; combobox semantics on the search field; wide tables scroll inside their own container so the page body never scrolls horizontally.

---

## 8. Production architecture

Region **ap-south-1**, 3 AZ.

| Concern | Choice | Rejected, and why |
|---|---|---|
| Search | **Amazon OpenSearch Service** — BM25 + HNSW kNN in one hybrid query, score-normalisation processor, LTR plugin | Meilisearch: has hybrid search but no score normalisation, no learning-to-rank, no script scoring, so it cannot express the published function or hold 40+ facet aggregations inside 85 ms |
| Hot price store | **DynamoDB** `PK SKU#{id}` / `SK Z#{zone}#T#{tier}`, GSI-1 `Z#{zone}#C#{cat}`, fronted by ElastiCache Valkey | Reading Aurora directly: the price surface must survive a cache flush without a thundering herd |
| System of record | **Aurora PostgreSQL** — `sku`, `offer`, `price_observation` (range-partitioned monthly, 90 d hot), `price_ledger` | — |
| History | Postgres 90 d hot → S3 Parquet+zstd (`dt=/source=`) warm → Glacier IR cold; `price_daily_ohlc` retained forever | Amazon Timestream — disqualified on availability, not price: LiveAnalytics closed to new customers 2025-06-20 |
| Read ingress | **ALB directly**; API Gateway retained only for partner/webhook ingress | $2,869 vs $8,130/month at 9B requests for the same job |
| Bot defence | WAF Bot Control (targeted) **scoped to** `/api/search`, `/api/price/*`, `/verify` (~3% of requests) | Unscoped: $90,000/month at Year-3 volume versus $2,700 scoped |

**Latency budget — search results, 200 ms p95 at the edge:** CloudFront + TLS 5 · WAF 3 · edge→ALB 8 · ALB→pod 2 · authN 4 · query understanding 12 · cache probe 3 · **hybrid retrieval + facets 55** · LTR rerank top-200 18 · hot-price BatchGet (60 keys) 12 · landed-price computation 6 · serialise + brotli 6 · return 10 · **jitter/GC headroom 56**. That 28% headroom is what makes the SLO survivable.

Autocomplete 50 ms (the *miss* path; ≥70% serve from edge cache at ~12 ms). Category 300 ms. PDP 250 ms. Compare 150 ms, rendered as an independent fragment so a slow compare never blocks PDP paint.

**Integrity.** Every quote reaching a cart or contract is appended to a hash-chained, Ed25519-signed `price_ledger` with a daily Merkle root published to WORM S3. `UPDATE` and `DELETE` are **revoked from the application role** — append-only is a database grant, not a convention. Hourly full-chain verification; a failure **halts quoting platform-wide** while reads continue.

**Two SLOs page on truth rather than speed:** price freshness ≥97% of impressions inside SLA, and **basis-error rate = 0**, with any occurrence paging.

---

## 9. Migrating off the local build

The demo was written so this is mechanical rather than a rewrite. Every seam is already in the right place.

| Local | Production | Work |
|---|---|---|
| `lib/db.ts` — one `better-sqlite3` handle | Aurora pool + DynamoDB client | Replace the module. Everything downstream uses `prep()`; keep that signature |
| `product_fts` + `product_trgm` (FTS5) | OpenSearch hybrid index | Replace `lib/search.ts:retrieve()`. It already returns `Map<product_id, normalisedScore>` and score-normalises two retrievers — swap in BM25 + kNN behind the same interface |
| `price_current` table | DynamoDB `BatchGetItem` ≤100 keys | Replace the read in `BASE_SQL`. The materialised `normalised_paise` column already matches the hot-store attribute |
| `lib/rank.ts` | Same function + ONNX reranker over top 200 | Keep the linear function as the retrievable, explainable base. Add the reranker as a second pass |
| `lib/price.ts:resolvePrice()` | `resolve_price` service + `SignedQuote` + ledger append | Add `quote_id`, `hold_until`, Ed25519 signature, `ledger_seq`. The basis object is already the right shape |
| `collector/run.ts` — two passes, until dry | Priority-scheduled crawl queue (§5) on BullMQ/SQS | Replace the loop with the priority score. The adapter interface and `RawOffer` contract carry over unchanged |
| Windows Task Scheduler | EventBridge + Fargate workers | Same entry point |
| `spec_value` provenance rows | Same table in Aurora | No change — this design is already production-shaped |
| Deterministic freight model | Same model, real carrier rate cards + PostGIS zones | Replace the rate constants with contracted rates; keep the seeded fallback for unresolved vendors |

**Do not change on the way:** integer paise everywhere · `unit_canonical NOT NULL` · per-category unit conversions · the provenance quintuple on every field · the four-state freshness ladder · the absurdity gate · basis parity returning `422` rather than sorting.

---

## 10. What the demo deliberately simplified — every item

Read this list before estimating.

1. **No signed quote ledger.** `resolvePrice()` returns a plain object. Production needs `quote_id` (ULID), `hold_until`, the Ed25519 signature, `ledger_seq`, the hash chain, the daily Merkle root to WORM S3, and `REVOKE UPDATE, DELETE` on the application role.
2. **No cart, no order, no `hold_until` absorption.** The demo has a client-side "my list" that re-prices through the same contract. Production needs cart lines holding `quote_id`, the 0.4%-of-GMV absorption budget, and the reviewable-diff flow at hold expiry.
3. **No verify-now path.** No `/api/price/verify`, no token buckets, no 15-minute result cache, no monthly vendor-spend circuit breaker at $6,030.
4. **No LTR reranker.** The linear function only. `f8` (sales velocity) is inert with weight redistributed, because there is no order history.
5. **No price-shock event bus.** No `PriceShockDetected`, no alert fan-out, no open-cart diff. `price_alert` exists as a table and a UI toggle; nothing fires it.
6. **Two regions, not a zone model.** `region` is Hyderabad and Vijayawada. Production needs the 14-zone AP+TS model (~180 all-India) defined by depot set, freight band and tax jurisdiction, with versioned `pincode_zone` — because districts get redrawn (AP went 13→26 and TS 10→33 in 2022) and a schema keyed on a government notification is a schema keyed on a press release.
7. **Entity resolution is a deterministic attribute tuple, not the precision-first scorer.** Production needs the blocking + typed-attribute gates + similarity scorer, auto-accept ≥0.93, human review 0.72–0.93, target precision 0.995 / recall 0.88, two-key confirmation in safety-critical categories, and the `match_candidate` review queue (~180 items/day at Year 1). The demo's rule — merge only on a complete identifying tuple, otherwise mint a separate product — is the right *default*, and it is why ~70% of the demo catalogue is `UNRESOLVED`: real listings routinely omit the grade.
8. **No canary set and no parser-version pinning.** The absurdity gate ships; the other two guards of the F2/F4 triad do not.
9. **The government anchor is a document reference, not a rate.** TG PRED circulars are scanned images (1.5 MB of JPEG, 23 characters of extractable text). Production needs an OCR step, or the machine-readable WPI cement/steel sub-indices from `eaindustry.nic.in` as the escalation index. AP publishes no current SoR at all (assumption A-07).
10. **Marketplace collection is browser-assisted, not scripted.** Amazon returns 503 to a script, BigBMart and BuildersMART serve browser challenges, Justdial returns a 30-byte body, Moglix and Infra.Market serve a JS wall. Production buys the marketplace tail (Bright Data Flipkart dataset at $0.0025/record, with the *Meta v. Bright Data* precedent) and builds the first-party dealer spine — **do not** operate collection yourself: it is ~1.5 FTE of permanent maintenance plus personal ToS and IT Act s.43 exposure.
11. **No DPDP machinery.** No consent notices, no purpose-limitation tags on pincode and intent, no k-anonymity floor on analytics, no rights endpoints, no 3-year-inactivity erasure job. Substantive obligations go live 2027-05-13 and the erasure trigger is 2 crore registered users — which is precisely the Year-3 north star, so build it now rather than in 2029.
12. **No sponsored placement**, and therefore none of its Rule 5(4) disclosure machinery.
13. **No `country_of_origin` data.** The facet exists and is indexed; no source published a value. LMPC Rule 6(10A) makes it a searchable and sortable facet by 2027-07-01, so it is a schema decision already taken.
14. **Bulk slabs are a schema field with no data.** `offer.bulk_slabs` is modelled and rendered; no collected source published slab pricing. Real supplier feeds will.
15. **Freight rates are representative, not contracted.** The model's structure is production-shaped — distance band × chargeable weight × vehicle class × category minimum, amortised across MOQ — but the ₹/km figures are typical Indian road-freight rates for the corridor, badged `ESTIMATED` throughout. Replace with contracted carrier rate cards.
16. **No image pipeline.** Thumbnails are hot-linked from source CDNs. Production needs ingestion, resizing, and the render-asset library.
17. **Reviews, seller reliability and velocity are read-only or absent.** `f5` uses source ratings shrunk toward the category mean; `seller_reliability` is a constant 0.5.

---

## 11. Assumptions still blocking, carried forward

From the specification's register, unchanged and still open:

- **A-07** — Andhra Pradesh has no current published Schedule of Rates (newest verifiable 2018-19). **Confirmed during this build.** AP's price anchor must be dealer-quote-driven, and AP launches behind Telangana.
- **A-11** — HSN 9405 (lighting) GST rate is genuinely contested, 18% vs 5%. **No lighting SKU may be priced until the gazette Schedule I/II entries for 8539 and 9405 are read.**
- **A-19** — the full list of QCO-regulated categories is not enumerated. Cement is confirmed (S.O. 191(E), 2003); IS 1786 rebar is confirmed mandatory **without the instrument identified**; wires, cables and other steel products have QCOs, several notified during 2026. **Enumerate with one citation per row before listing any SKU in a candidate category**, and re-check quarterly.
- **A-01** — Flipkart Affiliate registration may be closed to new applicants. It is the only sanctioned Indian marketplace ₹-price feed found.

---

## 12. Definition of done

1. Typing `cement` returns ranked real offers from both cities in under 200 ms p95, keystroke to painted.
2. Every card shows a unit price, a landed price and a freshness stamp — and cannot render without all three.
3. Clicking any card reveals the complete collected detail with provenance on every field.
4. Every filter in the rail filters real data; every count is measured, and a facet with nothing behind it ships visibly disabled with a reason rather than silently absent.
5. The benchmark passes its stated targets and prints the honest decomposition, including the debounce.
6. The daily job is registered, has run successfully, and a failed run leaves previous data intact and visibly degraded.
7. `resolve_price` parity holds: search row, detail sheet and list total agree to the paise.
8. No `/api/*` route can reach the network, proven by a test.
9. Basis-error rate is zero: no result page ever mixes incomparable bases.
