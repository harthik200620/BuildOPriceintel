# Build Objects Price Intelligence — local demo

A search engine for construction-material prices in **Hyderabad** and **Vijayawada**, covering cement, TMT steel, water pipes and bricks & blocks.

Nothing here touches the cloud. One SQLite file, one Next.js process, one scheduled task on this machine.

The wedge, stated as the spec states it (§3.8, gap G27): *not one of fifteen Indian platforms shows a delivered, pincode-resolved, GST-stated, unit-normalised, timestamped price for a single construction SKU.* This does.

---

## Run it

```bash
npm install
```

```bash
npm run db:init
```

```bash
npm run collect -- --mode=seed --passes=1
```

```bash
npm run dev
```

Then open <http://localhost:3000>. Type `cement`, or `8mm tmt`, or `sariya rate`, or `ఇటుక`.

Verify the build:

```bash
npm test
```

```bash
npm run bench
```

| Script | What it does |
|---|---|
| `npm run db:init` | Creates the schema and seeds regions, 213 pincodes with coordinates, the unit-conversion table, effective-dated GST rates and the facet definitions. Idempotent. |
| `npm run collect` | Sweeps every adapter until two consecutive passes surface nothing new, loads transactionally, rebuilds the price surface and the search index, writes snapshots and the collection log. `--category=` and `--region=` scope it. |
| `bash scripts/collect-missing-when-clear.sh` | Waits for IndiaMART's rate limit to clear, then sweeps the thin categories one at a time so each gets the full per-host budget instead of cement consuming it. |
| `npx tsx scripts/rebuild-from-raw.ts --apply` | Re-derives every product and offer from `collector/raw/*.jsonl` under the current normalisation rules. **No network.** Run it after changing entity resolution; omit `--apply` for a dry run. |
| `npx tsx scripts/renormalise-cement.ts --apply` | Re-derives cement canonical prices against the standard 50 kg bag from their stored quotes. |
| `npm run images` | Builds the card photo pool: deduplicates what the collector already holds, reads listing detail pages for their galleries, and **downloads every picture to `public/img`** so viewing a card makes no third-party request. `--apply` to write, `--pages=N` to bound the fetch. |
| `npm run reconcile` | Rewrites every filter count, brand roster and price band from real DB aggregates. `--region=` picks the city the counts describe. |
| `npx tsx scripts/coverage.ts` | Prints every dataset number this README publishes — coverage against the floor, brands resolved per category, picture buckets. The tables below are transcribed from it. |
| `npx tsx scripts/filters-report.ts` | Shows which facets survived reconciliation with real data behind them, and the stated reason for each one that ships disabled. |
| `npx tsx scripts/mine-brands.ts <category>` | Lists capitalised tokens in collected titles that no brand currently resolves, with frequency and an example. Decides nothing — it is the input to a hand edit of the roster. |
| `npx tsx scripts/parse-fixture.ts <fixture.html> [region] [category]` | Parses an archived page from `collector/fixtures/` and runs every row through `normalise()`, with **no network call**. Proves a parser change end to end — including whether the offers actually survive the category guard and the unit map — before a sweep is spent finding out. |
| `npm run snapshot` | Writes `data/snapshots/<date>/<category>.{json,csv}`. |
| `npm run bench` | 1,000 representative queries; p50/p95/p99 for the query layer and the full request. |
| `npm test` | Asserts the three laws, the unit table, the money arithmetic, the GST table, freight determinism and the freshness ladder. |
| `npx tsx scripts/field-coverage.ts` | Measured fill rate for every column the table can offer, per category. The coverage figures in the interface and in `docs/columns-and-filters.html` are transcribed from it. |
| `npm run shots` | Playwright screenshots of nine UI states into `screenshots/`. |

---

## The three laws

**1 — The query path never calls out.** No `/api/*` route issues an outbound request. Live fan-out is 60 calls at an observed p95 of 2.8 s (HTML) to 8.0 s (JS-rendered) against a 200 ms budget: 84× over, and two orders of magnitude is not a tuning problem.

Enforced, not promised. `lib/no-network.ts` replaces `globalThis.fetch` on the request path with one that throws and records the URL. `npm test` proves it fires.

**2 — Every displayed price carries a unit basis and a freshness timestamp.** The `<Money>` component cannot be called without a unit; a card cannot render without `{unit, delivery_scope, gst_treatment, priced_as_of, freshness_state}`. There is deliberately no way to put a bare rupee figure on screen.

**3 — The price search shows is the price the cart would bill.** One function, `resolvePrice()` in `lib/price.ts`, is the only code path that may state a rupee figure. The search card, the detail sheet, the vendor table and the list total all call it, and `tests/run.ts` asserts they agree to the paise.

---

## How it is put together

```
collector/            adapters -> RawOffer -> normalise -> load (transactional)
  sources/            indiamart · exportersindia · platforms · directories · tgpred · assisted
  captures/           typed browser-assisted captures, converted by scripts/write-captures.ts
  fixtures/           archived source pages, so a parser change is testable offline
  normalize.ts        typed attribute extraction, canonical-unit conversion, entity resolution
  ladder.ts           the missing-data ladder
lib/
  schema.sql          19 tables + FTS5 + trigram (offer_price = per-seller money)
  price.ts            resolvePrice — the one pricing contract
  rebuild.ts          the materialised price surface + the absurdity gate
  freight.ts          the deterministic freight model
  rank.ts             nine features, four penalties (no vendor damping — see below)
  search.ts           retrieval, faceting, the zero-result ladder
  query/parse.ts      typed-constraint grammar (units, trade terms, te/hi)
app/                  Next.js routes and the UI
docs/
  how-it-works.html   the pipeline end to end
  columns-and-filters.html  every proposed column, with a measured status
filters/              the four filter trees, counts reconciled from real data
                      <category>.json is the spec; <category>.html is it rendered
                      (rail · dependency flow · implementation table)
```

### The price object

Every figure is integer paise. No float touches a rupee — a cart total that differs from the sum of its lines by a rupee is a dispute on a signed contract.

```
landed = base_ex_gst + gst + freight + handling + loading
normalised = landed per canonical unit   <- the number ranked, filtered and banded on
```

Canonical units: cement **one standard 50 kg bag**, TMT `kg`, pipes `running_metre`, bricks `piece`. Conversions are **per category** because the trade's inch-to-mm mapping is not arithmetic: 1″ CPVC is 25 mm nominal bore, but 4″ SWR is 110 mm outside diameter. It is a table with tests, never ×25.4, and `npm test` asserts both.

"50 kg" in that sentence is load-bearing, and it was wrong until this run. `bag` was treated as dimensionless, so a per-bag quote passed through unscaled — and a ₹150 quote for a **1 kg** pack of Birla White became ₹150 *per bag*, the cheapest cement in Hyderabad, top of the results for `cement`. Every route to a cement price now goes through `cementCanonicalPaise()` and lands on the 50 kg basis (LMPC Rule 3(a)): 25 kg packs are rescaled ×2, 1 kg packs ×50, which pushes the novelty packs past 10× the category median where the absurdity gate quarantines them unpublished. `scripts/renormalise-cement.ts` re-derived the 23 affected offers already in the database from their stored quotes rather than re-fetching them; run it without `--apply` to see the arithmetic first.

### The interface — "Patina"

One appearance. There is no theme toggle, no `data-theme` attribute and no `prefers-color-scheme` branch
anywhere in the codebase: a deep teal ground lit from within, silver ink, translucent panes carrying more
light than the water around them, and one luminous aqua accent spent once per view on the unit price. The
bones of the original drafting language survive — hairline rules, the corner survey ticks, tabular figures.

It replaces *Alabaster* — warm ivory, charcoal text, a copper accent — and the light model inverts with it.
On paper a pane is lifted by a shadow; here there is no paper, only depth, so elevation is alpha and a
specular top edge first and shadow second. The ground is a slow **aurora**: two bloom fields drifting against
each other on 72 s and 96 s periods, transform-only on their own compositor layer so the table underneath is
never repainted, with a fine grain over the top. The grain is not decoration — a gradient this deep and this
saturated bands into visible rings at 8 bits, and the grain is what dissolves them. Both stop under
`prefers-reduced-motion`, the blooms holding a fixed composed position rather than looping at 0.01 ms.

Product photographs are all white-background studio shots, which on this ground would be 1,796 lit rectangles
punched through a dark page. They are damped at rest and released to true colour the moment attention lands
on a card; the detail sheet's gallery renders its own `<img>` and is never damped at all, because that is
where the purchase decision is made.

Type is **Geist** for UI text and the hero price, **Geist Mono** for every figure that sits in a column, and
**Fraunces** for the display voice — headings and section titles. `next/font` downloads them at build time
and serves them from this origin, so there is no runtime request to a font CDN and "nothing here touches the
cloud" still holds.

**The hero price is the one number not set in the mono, and the reason is function.** A monospace earns its
constant advance in a *column*, where every row has to align on the decimal. The hero sits alone in a card
and nothing aligns to it — so it paid the cost of that advance and got none of the benefit: the period took a
full digit width and `₹286 . 20` read as three groups rather than one number. It is Geist at weight 560,
still `tabular-nums` so the figure does not jump as you type. Geist and Geist Mono are one superfamily and
share their skeletons, so the price on the card and the same price in the table read as one number written
twice. In the detail sheet the two sit side by side — the hero proportional and tight, the floor/ceiling/
median row monospaced and aligned — and the difference reads as what it is: a statement next to a
measurement.

Weight is doing real work here and it is nearly free. `.hero-figure` is 560 and `.fig` is 450, both up from
400, because a figure on a dark ground carries less apparent weight than the same figure on paper, and
because the hero's clipped gradient needs stroke area to show in at all. **On a monospace the advance is
constant across the weight axis**, so bumping `.fig` moved no column budget — confirmed by the probe
reporting 0 wrapped, 0 spilled, 0 grown and an unchanged clip count across the change.

**The faces were measured before they were chosen**, against next's own bundled capsize metrics — 1,753
families, offline, no build required. The number that decided it: Geist Mono's average advance is **0.6000 em,
identical to the JetBrains Mono it replaces**, so every fixed-width money column kept its budget exactly and
the riskiest part of a font swap in this codebase was a no-op. Measured before and after on the live app: **0
prices wrapped, 0 spilled past a cell, 0 fixed-width boxes grew, and no column header lost a character.** The
honest cost is that Geist is 8.7% wider than Inter Tight, so long vendor names and product titles ellipse
sooner — 24 already-truncating strings became 29. That cannot be tracked away; recovering 8.7% would need
about −0.046 em, well past the point where letterforms collide at the 10–12 px where 72% of this app's type
lives.

Fraunces carries an **optical-size axis (9–144)**, which is why it and not a static serif: `.display` spans
15→24 px, and an `opsz` axis draws each size properly instead of scaling one cut and correcting it by hand
with negative tracking — so `.display` dropped its hand-tuned letter-spacing entirely. `SOFT` and `WONK` stay
at 0, the restrained end.

Three corrections went with the swap, each of which was a live defect rather than a migration cost:

- **The unit-price column rendered in two typefaces.** `accent` was passed on freshness, switching between the
  display serif and the figure face at 13 px inside one 126 px right-aligned column — roughly a 37% difference
  in advance width between adjacent rows, in the column that exists to be read down its decimal. It also never
  passed `stale`, so a dead price rendered unstruck there while the card struck it. `<Money>` now never picks
  its face from data, and a test asserts it.
- **`font-feature-settings: "cv05" 1, "ss01" 1` sat on `body`.** Those are Inter-specific character variants,
  and the property inherits — so they were also landing on the figure and display faces, selecting whatever
  those foundries happened to put at those tags.
- **`.fig` asked for `tabular-nums` but not `lining-nums`.** Tabular fixes the advance; it does not force
  lining figures, and a face defaulting to old-style would set `₹1,035.50` with descending 3/5/7/9 inside a
  44 px `items-center` row.

`₹` is **U+20B9, which Google serves from `latin-ext`, not `latin`**. The subset is now named explicitly on
all three faces, so a face lacking it fails at build time rather than silently rendering the leading glyph of
every price from a system fallback at an unrelated advance width.

Two rules in `app/globals.css` are engineering rather than taste, and both are load-bearing:

**Blur is rationed, and the test is "does anything move behind it?"** `backdrop-filter` costs GPU on every
repaint. Blurring every panel put keystroke→paint at 225 ms against a 200 ms budget. Blur now belongs only to
surfaces content actually travels under — the top bar, the search dropdown, the detail sheet and its scrim,
the compare tray. The filter rail and the vendor table have nothing passing beneath them, where a blur was
invisible and cost real milliseconds; they use `.glass-card`, the same look with no filter. Anything repeated
per result is `.glass-card` by definition, because there are 24 of them and they re-render on every keystroke.
The aurora does not reopen this: it drifts on a 72–96 s period, slow enough that blurring it is
indistinguishable from blurring a still gradient — the rule is about content passing underneath, not about
the ground breathing.

Measured after the fact, the effects turned out not to be the cost at all: forcing a full repaint of the
results grid takes ~28 ms whether card shadows, corner ticks, the ambient wash, the lift transition and every
`backdrop-filter` are on or off. The rationing stands anyway — it is the right default, and it is why the
page has headroom rather than needing it.

**Every colour pair is measured, not eyeballed — and now it is a test rather than a comment.** This used to
be a block of prose in `globals.css` listing ratios that nothing enforced. When the theme was repainted the
first candidate palette failed **16 of 120 pairings**, and a comment would have shipped saying otherwise.

`lib/contrast.ts` implements WCAG 2.1 luminance plus sRGB alpha compositing for stacked translucent layers,
quantising 8-bit **per layer** as a browser does — compositing in float and rounding once at the end reads
about 0.5 % high, which on a value sitting at 4.50 decides pass or fail. `tests/run.ts` **parses the `:root`
block out of the live stylesheet** rather than keeping its own copy of the hexes, so a future colour edit that
breaks contrast fails the suite instead of shipping.

Every ink is measured against four grounds — the flat floor, bare canvas, and each bloom at its peak — times
five pane alphas. Worst case throughout is `.glass-strong` over the silver bloom, surface `#2A424A`:

| | worst of 20 surfaces | |
|---|---:|---|
| `--ink` #E8F0F2 | 9.20:1 | |
| `--ink-2` #B0C4CA | 5.87:1 | |
| `--ink-3` #9BAEB3 | 4.60:1 | started at `#8EA3A9`, **failed at 4.03** |
| `--stale` #ABADAD | 4.71:1 | started at `#7B8F96`, **failed at 3.14** |
| `--fresh` #5AD888 | 5.87:1 | moved to ~142° so it reads as green, not dim accent |
| `--ageing` #E0B155 | 5.36:1 | |
| `--accent` #5CE1E6 | 6.76:1 | |
| `--accent-ink` #3FD0D8 | 5.68:1 | the hero gradient's dimmest stop, and it is text |

`--ink-3` carries the 10–11 px labels, so 4.5:1 genuinely applies to it — the 3:1 large-text allowance starts
at 18.66 px bold. The old copper `#A8431B` measures **1.76:1** here: it fails not only AA text but the 3:1
non-text bar on every surface, which is why the accent could not simply be carried over. These ratios are a
property of the stack, not of the hex, which is exactly why the test composites rather than compares.

### Pictures

Each card carries up to five photographs and rotates them while the cursor is on it. Getting to five was the
hard part: the collector had been keeping exactly **one image per listing**, and imimg serves the same
photograph at 125/250/500/1000 and bare — so five URLs are routinely one picture. `product_image` is keyed on
`asset_key`, the path with the size suffix stripped, which is what makes deduplication mean anything.

Three sources, in increasing order of cost: what was already stored; each listing's **detail page gallery**
(`dir.indiamart.com` is rate-limited, `www.indiamart.com/proddetail` is not); and sibling offers of the same
product — free, and where most of the count actually comes from, because one seller photographs a bag once
but twelve sellers of the same bag give twelve angles.

| | at the start | now |
|---|---:|---:|
| cards with 5 pictures | 52.6% | **42.5%** |
| cards that can rotate (≥2) | 65.7% | **60.8%** |
| cards with exactly one | 15.5% | **24.1%** |
| cards with none | 18.8% | **15.1%** |

Read those against a denominator that nearly doubled: the scoped sweeps added 337 water-pipe and 438 brick
offers, most arriving with a single thumbnail and no gallery. The pool did not shrink — it went from 615
assets to **1,951** — but the number of cards it has to cover went from 799 to 1,755, so the *rate* at which
cards reach five fell while the count of cards with no picture at all more than halved. The one-picture
bucket is where the new brick supply landed, and it is the bucket that a detail-page pass moves.

Reading detail pages is budget-limited rather than blocked: IndiaMART's circuit breaker trips at almost
exactly 98 pages per window, twice running. **197 of 1,390 candidate pages have been read** — the unread
count rose rather than fell, because each new offer brings a new gallery with it.
`scripts/images-when-clear.sh` waits for two separate conditions — no category sweep in progress *and*
IndiaMART actually answering — then reads the next batch. `image_page_log` records what has been read, so
each run continues rather than re-walking the same pages, which is what the first version of this script
would have done.

The zero bucket only moves so far: those are products whose listings never published a photograph, and the
collector will not invent one.

**Every picture is downloaded to `public/img`.** Viewing a card makes no third-party request, the demo works
offline, and a card cannot break when a marketplace changes its hotlink policy. 1,796 files, 19 MB on disk.
Thirty source URLs returned nothing on the last pass; those assets are dropped rather than left as rows
pointing at a picture that will not load.

Four product decisions, each of them a way this feature usually goes wrong:

- **Rotation answers attention.** Twenty-four cards animating at once is a fairground, so it starts on hover
  or keyboard focus and returns to the first frame when attention leaves — the resting grid is stable rather
  than however far each card happened to get. The trigger is the *whole card*, not the plate; the card's
  content layer is `pointer-events-none` so the click overlay can work, and a listener on the image would
  never have fired.
- **Frames 2–5 are not in the DOM until first hover.** At 24 cards that is 24 images on load instead of 120.
- **One picture does not rotate and shows no progress bar.** A carousel of one misrepresents how much there
  is to see.
- **Datasheet scans stay out.** Detail pages carry scanned spec sheets; they are useful and they belong in
  the sheet's datasheet block, not where a buyer expects to see the goods. `npm test` asserts none leak in.

The detail sheet gets the same pool as a **picker** rather than a rotation — you have already stopped there,
and taking control from someone who is reading is worse than useless. Each thumbnail names the listing it
came from.

The cost is real and measured: pictures add **~22 ms** to keystroke→paint (206 ms vs 184 ms p50 with them
blocked). They were being stored at 500 px and displayed at 92, so decoding was four times the work for
pixels nobody could see; at 250 px — exactly 2× the plate — p50 came back from 254 ms to **198 ms** and the
folder shrank from 20.3 MB to 7.2 MB.

### The missing-data ladder

Applied in this order, never skipping to invention:

1. `quoted` — the value the source published
2. `derived` — computed from other captured fields, with the arithmetic kept and shown
3. `typical` — a representative brand- or category-level value, badged **TYPICAL** with a tooltip saying it is representative, not quoted
4. `unknown` — "Not published by seller", with a link to the page that failed to say it

Every field carries `value`, `unit`, `source_url`, `fetched_at` and `confidence`. **A field with no provenance cannot render.**

### Freight

Deterministic, never random. Distance band (vendor locality → your pincode, via a shipped 213-row coordinate table) × chargeable weight (max of actual and volumetric) × vehicle class (parcel / tempo / LCV / 6-tyre / 10-tyre) × category minimum, with free-delivery thresholds where a vendor publishes one, amortised across the seller's MOQ.

Where a vendor's locality cannot be geocoded, the distance falls back to a value derived from a hash of the vendor id — **identical on every page load and every refresh**, because a delivery cost that changes when you reload destroys the product's credibility. Every figure renders with an `ESTIMATED` badge and a one-tap breakdown containing the arithmetic.

### Certification

Certification **labels**; it does not hide. Most of the Indian construction market is legal, everyday material carrying no BIS mark — a broad filter would delete half of it and substitute our judgement for the buyer's. It is ranking feature f6 at weight 0.07, and the facet defaults to **off**.

The exception is legal rather than editorial: where a Quality Control Order makes a valid BIS licence a condition of lawful sale (cement, IS 1786 rebar), an **expired** licence is a hard filter no weight tuning can bypass.

This build adds one honest state the spec does not name. Almost no listing publishes a licence number, so `BRAND_LICENSED` records *"the manufacturer holds a licence for this IS code, but this listing does not quote it"*. That is a different claim from `CERTIFIED` and is not treated as one — and it is a different claim from `NOT_DECLARED` too. The hard filter fires only on positive evidence of expiry, never on a listing that is merely silent.

---

## The filter trees, reconciled

The four trees in `filters/` were authored before any data existed, so their brand rosters, price bands and
counts were illustrative. `npm run reconcile` rewrites all three of those from real aggregates and flips
`counts_are_illustrative` to false. Brand values become the brands actually collected, ordered by result
count. Price bands are quartiles of the real in-zone distribution rather than round numbers — ₹0–500 /
₹500–1000 on a catalogue whose middle half of bags falls between ₹350 and ₹420 gives you one useful band
and three empty ones.

Counts are **offers, not products**, because the results list is one card per vendor: a tree reconciled
against products while the rail counts sellers is the same defect pointing the other way.

| Category | Offers | Facets with data | Shipped disabled |
|---|---:|---:|---:|
| Cement | 627 | 11 | 2 |
| TMT steel | 32 | 11 | 2 |
| Water pipes | 243 | 14 | 3 |
| Bricks & blocks | 450 | 12 | 4 |

All four validate clean against the category-filters checker. `filters/<category>.html` is each tree
rendered — the rail as a customer sees it, the dependency flow, and the implementation table.

**Reconciling the document was not the same as reconciling the product, and for most of this build it
wasn't doing both.** The query layer reads `facet_definition`; the JSON trees are the source that table is
seeded *from*, but only `npm run db:init` ever seeded it. So `npm run reconcile` rewrote four documents and
left the running rail on whatever was seeded last — visibly: the published cement tree said
`Under ₹350 / ₹350–₹380 / ₹380–₹420 / Over ₹420` while the interface rendered
`Under ₹320 / ₹320–₹380 / ₹380–₹440`. Disclosed parameters that are not the applied ones is exactly what
CP(E-Commerce) Rule 5(3)(f) prohibits, so the seeding moved to `lib/facets.ts` and reconciliation now ends by
calling it. The two are written in one command and cannot drift.

**A facet with nothing behind it ships disabled with a stated reason, never deleted**, so the gap is visible
rather than silently absent. This run made two corrections to how that judgement is reached:

- **`price_freshness` was being disabled in all four categories, wrongly.** Freshness is derived at query
  time from `priced_as_of` and `sla_hours` rather than stored, and the reconciler had no case for it — so it
  read as null on every row and turned off a facet that `lib/search.ts` would have filtered on perfectly
  well. A facet switched off by a gap in the reconciler rather than a gap in the data is worse than no
  reconciliation at all, because it looks like a finding. It now mirrors `facetValueOf` exactly.
- **"Nobody publishes this" and "everybody publishes it as prose" are different facts** and were getting the
  same sentence. Cement `application` is the second kind: 124 of 627 listings carry it, as *"Construction"*,
  *"For Construction"*, *"Used For Constrution"* — free text that matches none of the five authored values.
  That is a normalisation gap, not a collection gap; the data is there and an extractor would reach it. The
  reason string now says which kind it is, and the facet still ships disabled rather than mapped by guess.

The genuinely empty ones are: bulk pricing slabs (0 of 1,755 offers publish a quantity break), TMT corrosion
resistance, pipe pressure/GI class and joint type, and brick compressive strength, fly-ash percentage and
clay finish. Those are collection gaps and are labelled as such.

---

## Results as a table, with sortable columns

A `.seg` toggle above the results switches between the card grid and a sortable table. Cards stay best for
browsing and photographs; the table is for comparing many sellers on numbers.

**Fourteen default columns** — photo, seller, platform, product, brand, a category-adaptive spec pair, unit
price, landed, unit, GST, MOQ, rating, BIS and verified — plus about twenty more behind a column picker. A
spec column only appears once its category is in play, so a pipe bore column is never offered on a cement
result set where it would be empty on every row.

**Sorting is server-side, and that is the whole design.** A header click changes `col`/`dir` on the query and
refetches. Sorting the 24 rows the browser holds would reorder the *window* rather than the result, so page 2
would disagree with page 1 and the header would disagree with the sort dropdown. `COLUMN_SORTS` in
`lib/rank.ts` defines each column's comparator and — required, not optional — its disclosure sentence.

Three details that took a second pass:

- **The disclosed order must be the applied one.** When a column drives the sort, the line under the controls
  reads *"Sorted on Unit price · lowest first"*, not *"Recommended"*. It also words direction by column type:
  `A–Z` for a name, `lowest first` for a price, `most recent first` for a timestamp.
- **Nulls sort last in both directions.** "Unknown" is not a value at either end of a range — sorting rating
  descending should surface the best-rated sellers, not the 49% who publish none. The old `VendorTable` used
  `MAX_SAFE_INTEGER` for a missing MOQ, `99` for a missing ETA and a negated rating so that "ascending"
  silently meant descending: three columns, three meanings of one arrow.
- **Every column states its coverage.** A column populated on 9% of rows prints `9%` in its header and in the
  picker. Without it, a patchy column reads as a broken feature rather than as an honest measurement of what
  sellers actually publish.

The sort columns are **not** carried on every candidate row. Adding them to the base query cost ~2 ms of p95
and pushed cement past its own 20 ms line, to buy something the overwhelming majority of queries never use —
nobody sorts by seller name while typing. They are fetched on the first column sort and cached against the
same `PRAGMA data_version` stamp as the base rows.

### Clicking a card opens that seller's offer

A card is one seller's listing, but the sheet was keyed by product — so opening two different sellers' cards
produced an identical sheet, and the seller you clicked appeared only as a highlighted row far down the
vendor table. It now leads with their offer: their price with the full landed breakdown, their MOQ, their
certification state, their listing title verbatim, and where they stand — *"#3 of 11 sellers by delivered
price"*.

**That change introduced a Law 3 violation, and finding it is why the parity test now exists.** The first
version matched the clicked offer by *vendor*. But a vendor's row in the rolled-up table is their **cheapest**
listing, so for any seller who posts the same product twice the sheet showed a different price from the card
that opened it — caught live at ₹321.60 on the card against ₹315.70 in the sheet. `/api/sku` now takes the
offer id and resolves that exact listing *before* the roll-up, and `npm test` asserts card price equals sheet
price for every seller with more than one listing.

Three other things in the sheet were fetched and never rendered, and now are: the resolved attribute tuple,
the datasheet scans, and the count of sellers. One thing was removed — a "tell me when this drops below ₹X"
checkbox that set local state and nothing else. A control that looks like it works and does not is worse than
an absent one.

**Which columns are possible at all** is a separate question with a measured answer:
[`docs/columns-and-filters.html`](docs/columns-and-filters.html) audits ~200 proposed columns and filters
against the catalogue — 28 live, 17 mined out of the raw archive, 12 waiting on time-series data, and ~140
that no source publishes.

---

## Measured latency

From `npm run bench`, 1,000 queries across four categories and both cities on this machine, against a
catalogue of 920 products and 1,797 offers:

| Stage | p50 | p95 | p99 | Target |
|---|---:|---:|---:|---|
| Query layer — parse, retrieve, filter, facet, rank | 7.19 ms | **16.94 ms** | 19.37 ms | p95 ≤ 20 ms |
| `resolvePrice()` | 0.34 ms | **0.47 ms** | 0.79 ms | p95 ≤ 10 ms |
| Full request — `GET /api/search` over HTTP | 22.51 ms | **35.69 ms** | 54.66 ms | p95 ≤ 120 ms |

The end-to-end budget, decomposed honestly:

```
  debounce                     80.00 ms   fixed, and counted INSIDE the budget
  request (p95)                35.69 ms   measured over HTTP
  remaining for render+paint   84.31 ms   measured live by the dev-mode HUD
  --------------------------------------
  total budget                200.00 ms
```

### The ExportersIndia supply broke the budget, and the budget won

Adding ~180 offers took the query layer to **21.56 ms p95 against a 20 ms target — a real failure**, with
cement at 22.66 ms. Nothing had regressed; every stage was simply in proportion to a catalogue that had
grown from 306 products to 912. The target was not moved.

The fix came from noticing what the stage actually was. `fetch` — reading the candidate set out of SQLite —
was 7.17 ms of it, and **that set only changes when the price surface is rebuilt.** Search never writes. So
it is now read once per `(region, category)` and reused, keyed on `PRAGMA data_version`, which SQLite bumps
whenever another connection commits — so a collection run in a separate process invalidates the cache
without needing to signal the web process. A wall-clock TTL would have served a stale catalogue for its
duration; an in-process counter would never have seen the collector at all. `rebuildPrices` also clears it
directly, so correctness does not depend on the collector being a separate process.

Sharing rows across requests is sound here because the only thing ever written to a row is `attrOf`'s
memoised attributes — idempotent, and now paid once for the life of the catalogue instead of once per
request.

**Query layer 21.56 → 14.94 ms p95, cement 22.66 → 15.78 ms** — the best numbers in the build, on the
largest catalogue in the build. A cache is only worth having if it is invisible, so `npm test` runs the same
query cold, warm and after a flush and asserts all three return identical offers, prices and facet counts.

### One stage missed the target, and what was changed

Growing the cement catalogue from 40 products to 163 broke the query-layer budget: p95 went to **23.37 ms**
against a 20 ms target, and the stage breakdown put **16.84 ms** of it in faceting alone — 26.39 ms p95 on
cement specifically. The target was not relaxed; the stage was fixed.

Faceting was O(facets × values × rows) with two things buried in the innermost loop: each facet label's
`range` / `Under` / `Over` patterns were re-parsed for every row, and `selectionMatches` called
`JSON.parse(values_json)` **per row**, which at 13 facets × 163 rows was roughly 25,000 parses per query.
Three changes, none of which touch what a match *means*:

- labels compile once per request, not once per row;
- `facetValueOf` runs once per (facet, row) rather than once per (facet, value, row);
- the per-facet `others.every()` rescan became one pass recording which selection-bearing facets each row
  fails — a row belongs in facet *f*'s base exactly when it fails nothing, or fails only *f*.

Faceting **16.84 → 3.33 ms** p95, query layer **23.37 → 9.06 ms**, cement **26.39 → 9.40 ms**.

**Then the vendor-led results list broke it again**, and the fix is worth recording because it is the same
mistake one level down. Ranking sellers rather than products meant faceting over ~800 offer rows instead of
306 product rows, and p95 went to **26.04 ms**. Two causes, both work repeated in an inner loop:

- `attrOf()` ran `JSON.parse` on each row's attributes *per facet* — 13 facets × 627 cement rows ≈ 8,000
  parses a query. Parsed attributes are now memoised on the row, which is safe because better-sqlite3 hands
  back fresh objects every query so the cache cannot outlive its request. Faceting **13.22 → 4.30 ms**.
- The row query carried the vendor join, the `price_current` join and every display-only column for ~800
  rows so that 24 could be rendered. Those moved to a second statement fetched for the page alone.
  Fetch **5.73 → 3.55 ms**.

Query layer **26.04 → 15.57 ms**, with p99 (17.13 ms) also inside the p95 target.

`valueMatches()` remains the readable definition of the comparison, and `npm test` decides every
(row, facet, value) triple in all four categories both ways and asserts they agree — an optimisation that
silently changed a count would be a worse defect than the latency it fixed.

End-to-end, measured properly for the first time — 12 queries driven through a **production build**, timing
each keystroke to the frame that paints the changed results:

```
  p50 172 ms · spread 137–273 ms · budget 200 ms (the 80 ms debounce is inside these numbers)
```

Most queries land inside the budget and the heaviest ones reach ~270 ms. That tail is request plus React
render on the largest result sets, not the glass — the repaint profiling above puts the entire visual layer
at ~28 ms regardless of which effects are enabled. It is stated here rather than rounded down.

**Both quality guardrails are green.** Zero-result rate is **0.00%** against an SLO of < 1.5%, and basis-error rate is 0.00% by construction. Zero-result was 16.30% and red for most of this build — a data-coverage number rather than a retrieval one, because the benchmark set deliberately includes water-pipe queries and water pipes had no collected supply. Excluding them would have flattered the number, so they stayed in and the figure stayed red until the supply existed.

The reason this lands is architectural rather than clever: `better-sqlite3` runs in-process, so there is no network hop between the query and the data at all. The AWS design in the spec budgets 55 ms for the OpenSearch retrieval hop alone; here the equivalent work is a function call at 6.62 ms p95.

`sqlite-vec` was **not** added. The measurement came first: lexical FTS5 plus a trigram index already answers the golden query set — `ultratec` reaches UltraTech, `ఇటుక` and `itaka` and `eeta` all reach brick — at 6.62 ms p95 for retrieval. A vector index would have added a dependency and a build step to a stage that is not the bottleneck. If semantic matching is needed later the hook is `lib/search.ts:retrieve()`, which already score-normalises and fuses two retrievers.

---

## The assistant

A grounded buying assistant on **Gemini 2.5 Flash**, in `lib/chat/`. The full design is in
[`docs/ASSISTANT.md`](docs/ASSISTANT.md); the short version is that **the model is structurally
incapable of producing a fact**.

```
message → scope gate (pre-model) → tool loop → fact ledger
        → grounding check → one silent repair → answer, or an honest refusal
```

Eight tools are the only route to a fact, and each deposits every number, entity and source it
returns into a per-turn **fact ledger**. The validator then holds the model's draft against that
ledger: a price, a brand or a count that no tool returned this turn gets the draft rejected, the
model is handed its own violation list, and a draft that fails twice degrades to an honest refusal
that still shows the cards. The scope gate runs *before* any token is spent, so an off-topic or
injection prompt costs nothing.

`lib/no-network.ts` still throws on outbound calls from the query path. The model host is one named
allowlist entry with its justification written next to it.

### "Which is the best brick?" — and why it is not ranked

`rank_by_quality` scores on declared grade (40%), certification (25%), brand (15%) and how many
sellers carry it (20%). That works for cement and TMT steel. For **bricks it silently did not**:
there is no brick grade field anywhere in the schema, and 94% of them sit at `NOT_APPLICABLE`
because an unbranded kiln brick is not something BIS licenses. Three of the four terms were
constant, the score reduced to seller breadth, and the tool returned **the cheapest unbranded brick
in the catalogue as "#1 best quality"**.

Every figure in that answer was real, which is why the fact ledger passed it. **A ledger proves a
number came from the data; it cannot prove that arithmetic over the data means what its label
says.** `rankableOn()` is that second check — measured, not hardcoded, so a future collection run
that brings brick grades in turns ranking back on by itself. It also caught the same collapse in
water pipes, which are 100% `NOT_DECLARED`.

What replaces the ranking is `lib/chat/masonry.ts`, built on the same contract as
`coefficients.ts`: every entry carries a confidence rung and a citation, and an entry with neither
cannot be used. `CODE` is what IS 1077, IS 2185 and IS 12894 establish. `TRADE` is site practice —
including the hot-dry climate note, because **no Indian standard selects masonry by city**, and
dressing that up as a code requirement to make the answer land better would be the same failure in
a nicer suit.

So the answer is by *duty* — what the wall has to do — with the governing standard beside each type
and the live delivered price under it, and the plain statement that no seller declared a grade and
none carries a BIS licence.

### Cost

| | |
|---|---|
| **Repeat questions** | An answer cache keyed on the normalised question, the pincode, and SQLite's `PRAGMA data_version`. The collector is a separate process, so its writes bump that counter and the whole cache turns over the instant a price changes — no TTL, and no window where a stale price can be served. |
| **Follow-ups** | Never cached and never read from cache. *"And in Vijayawada?"* means nothing without the turn before it, and keyed on the message alone it would confidently return someone else's answer. |
| **The repair pass** | Was sending the full tool declarations alongside `toolMode: 'NONE'` — ~1,400 tokens the model was forbidden from calling. Dropped. |
| **The stable prefix** | System prompt plus tool schemas is ~1,800–2,200 tokens, byte-identical every call, which clears the 1,024-token floor for implicit context caching on 2.5 Flash. `cachedContentTokenCount` is now read and surfaced in the trace — it was the one usage counter being dropped, which left the saving a hope rather than a measurement. |

Anyone editing `prompt.ts` should know the corollary: implicit caching keys on an **exact** prefix
match, so interpolating anything per-turn into `SYSTEM_PROMPT` switches it off silently, and that
counter is the only thing that would say so.

`/api/chat` is rate limited with a per-client token bucket (8 burst, refilling at 0.5/s) — a turn
can cost four model round-trips and the route has no auth in front of it.

```bash
npm test          # 175 core + 186 chat + 19 engine, all offline, no key needed
npm run test:live # 14 real conversations. Spends tokens. A report, not a gate.
```

Set `GEMINI_API_KEY` in `.env.local`. Without it the gates, the estimators and every refusal still
work — only turns that genuinely need the model fail, and they say so.

---

## What is honest about the data

This is the part worth reading.

**Collection ran against real sources and recorded every refusal.** `data/logs/collection-<date>.md` lists every source hit, what it returned, and an estimate of the volume behind each block. Nothing was capped silently and no offer was ever invented.

**IndiaMART blocked this machine mid-build, then cleared, and cement is now deep.** It is where the long-tail dealers for both cities actually list. It rate-limited every network path for hours during the build; the limit later lifted and the sweep ran. Cement now carries **627 offers across 131 named Hyderabad vendors and 49 brands**, with localities, MOQs and spec tables, plus 74 offers / 12 vendors in Vijayawada.

**The block is not gone, it is a budget.** IndiaMART throttles on volume, and the collector walks categories in a fixed order — cement's 13 seed slugs, each with a crawl frontier and pagination, spend the whole per-host allowance before TMT, pipes and bricks are reached. On the last full sweep those three took a 429 on every slug. That is an ordering defect in the collector, not a property of the source, and `scripts/collect-missing-when-clear.sh` is the fix: it waits for the limit to clear, then sweeps **one category at a time** so each gets the full budget.

**Where the dataset stands against the floor** (≥25 offers per category per city, ≥6 brands, ≥4 platforms).
Counted per city off `offer_price` — the supply a search in that city can actually reach, not where the
seller's office is:

| Category | Offers (Hyd / Vij) | Vendors (Hyd / Vij) | Brands (Hyd / Vij) | Platforms | Floor |
|---|---|---|---:|---:|---|
| Cement | 637 / 95 | 141 / 31 | 49 / 33 | 3 | offers ✓ brands ✓ · platforms short |
| Bricks & blocks | 484 / 85 | 205 / 53 | 18 / 11 | 3 | offers ✓ brands ✓ · platforms short |
| Water pipes | 248 / 104 | 146 / 70 | 27 / 13 | 2 | offers ✓ brands ✓ · platforms short |
| TMT steel | 32 / 32 | 1 / 1 | 9 / 9 | 1 | offers ✓ brands ✓ · vendors and platforms short |

Totals: **1,755 offers · 912 products · 629 vendors · 105 brands.** The offer and brand floors are now met
in **both cities on all four categories**. The **platform floor is still met nowhere** — three at best,
against four — and TMT steel still has a single seller.

**Bricks was the thin category and is not any more.** It sat at 15 offers from a single seller for most of
the build, and the reason turned out to be embarrassing rather than structural: **nine of the twelve
IndiaMART seed slugs were 404s.** `aac-block`, `aac-blocks`, `red-bricks`, `clay-bricks`, `concrete-block`,
`building-bricks`, `solid-concrete-blocks`, `cement-bricks` and `clc-blocks` do not exist on that host; the
real slugs are `red-brick` singular, `concrete-blocks` plural, `fly-ash-bricks`, `interlocking-bricks`,
`hollow-blocks` and plain `bricks`. The category read as *blocked* because 48 rate-limited sources masked
the fact that the requests which did get through were asking for pages that were never there. The crawl
frontier could not rescue it either — a brick directory page links to almost no sibling brick categories,
unlike cement.

**Then Vijayawada stayed at 15 offers from one seller, and the cause was a different bug in a different
source.** Every IndiaMART Vijayawada brick seed returned 429, on the sweep and again on a scoped retry, and
that was true — but it was masking something worse. **ExportersIndia had returned zero offers for every
category in both cities for the entire build**, and it was not blocked: `vijayawada/bricks.htm` answers with
503 KB declaring **108 records**. The shared directory parser failed it twice over. Its container selector
`[class*="product"|"listing"|"card"]` matches nothing on that markup — the card is `div.clsProDet`. And its
price regex required a literal `₹`, which does not appear in the rendered text at all, because **the rupee
sign on that site is an `<img>`**; `.text()` yields `Price: 24 - 28/ Piece`. Widening the regex to accept
`Rs` would still have found nothing — the price lives in a `data-tooltip` attribute.

That source now has its own adapter with real pagination, driven by the record count the page publishes
about itself. **Vijayawada bricks: 15 → 85 offers, 1 → 53 vendors.** Cement Vijayawada 74 → 95, pipes 80 →
104, and the platform count moved for the first time in the build.

**It stayed invisible because a parse failure was reported as an empty result.** `outcome: 'empty'` was used
for a genuine 404, for a bot-wall stub, *and* for a 200-OK 500 KB page that parsed to nothing — and
`run.ts`'s headline counted only `ok` and the blocked family, so those rows were attempted and then vanished
from the arithmetic. A run reading *"34 attempted · 2 ok · 24 blocked"* left eight rows unaccounted for, and
those eight were where the bug lived. Every outcome is now counted and the total is asserted to sum:

```
sources 390 attempted — rate_limited 180 · blocked 120 · ok 44 · skipped 24 · parse_fail 16 · empty 6
```

`parse_fail` is now a distinct label meaning *the source answered and our parser matched nothing*. It
immediately caught a second one: **TradeIndia has never returned a single offer either.** Its URL template
hardcodes a numeric city id — `{city}/{slug}-city-183463.html` — that never varies by category or city, so
all eight combinations fetch the same ~21 KB soft-404, byte-identical for `vijayawada/bricks` and
`hyderabad/cement`. It is left in the sweep so the attempt stays on the record, now labelled as our defect
rather than as an empty market. Fixing it needs its own URL discovery and parser, and is not done.

**Water pipes was empty for most of this build. It is not any more.** Every route had failed differently —
IndiaMART throttled before the sweep reached it, BigBMart carries no plumbing, Moglix and BuildersMART serve
a JS wall, and Amazon returned 266 listings that were almost entirely **fittings** rather than pipe. Fittings
are a sibling category with their own attribute vocabulary, so loading them would have been a category error
dressed up as coverage.

The fix was ordering, not access. `scripts/collect-missing-when-clear.sh` waited for the rate limit to lift
and then swept **one category at a time**, so pipes got a full per-host budget instead of whatever cement had
left. Result: **243 offers / 141 vendors in Hyderabad, 80 / 46 in Vijayawada**, and the filter tree went from
0 data-backed facets to **14**.

That closes the one red guardrail in the build. **Zero-result rate: 16.30% → 0.00%** — every benchmark query
now finds something, because the queries that used to find nothing were all pipe queries.

**Pipe brands needed the same roster work as cement, and the ceiling is lower.** No pipe listing carries a
seller brand field — **0 of 451** — so the title is the only evidence there is, and 278 of 389 distinct titles
name no brand at all ("Cpvc Pipe", "1 Inch CPVC Pipe"). Sixteen manufacturers that were being filed as
Unbranded are now resolved — Austro, Lenox, Lexon, Sumolex, Sowbhagya, Varsha, Polycab, Champion, Suki,
Fitwell, Fitwin, Joton, Kaizen, Worldflow, Tomson, BRP — every one verified present in a collected title.
30 brands now resolve across 30% of pipe offers, against a ceiling of roughly 28% that the titles allow;
the rest are genuinely unbranded and are labelled that way.

`Hindware` was deliberately **not** added. It appears only inside "Truflo by Hindware", and since brand
matching is longest-first, adding it would have relabelled Truflo's own pipes as Hindware's.

**The brick roster had the opposite defect: it was asserting brands nobody claimed.** `Karimnagar` and
`Karnataka` were roster entries, so "Clay Rectangular Karimnagar Red Bricks" resolved to brand *Karimnagar* —
and once the sweep landed, a **district** was the single largest brand in the category, ahead of every real
manufacturer. A place of firing is not a maker. Both are gone and those listings now carry no brand, which is
what the source supports. The qualified kiln names stay, because "Karimnagar ABN Bricks" **is** a seller's
product name and the trade genuinely identifies kilns by their initials. Five real manufacturers found in the
collected titles were added in their place — Wienerberger, Porotherm, Nucon, Ecotherm, NCL — each checked
against the listing that produced it. `scripts/mine-brands.ts` is what surfaced them, and it deliberately
decides nothing: it lists unresolved capitalised tokens with an example each, and a human separates
*Wienerberger* from *Alumina*, *Soil* and *Hyderabad*.

Brick brands resolve across only **8% of offers**, against 94% for cement and 100% for TMT. That is the
honest ceiling, not a gap to close: most brick in this market is sold unbranded by the kiln, and the
remaining 92% are labelled *Unbranded* rather than given a plausible name.

**The Telangana government circulars are scanned images.** TG PRED publishes a clean monthly cement and steel series running 2014 → 2026, and the May-2026 issue resolves and downloads correctly — but it is 1.5 MB of JPEG streams yielding 23 characters of extractable text. The document is cited as the reference line with its month and URL; the rupee figures inside were not machine-extracted and none was invented from them. Reading them needs OCR.

**Andhra Pradesh publishes no current Schedule of Rates.** Newest verifiable edition is 2018-19. Vijayawada therefore has no in-state government anchor, and the Telangana series is shown to it as an explicitly cross-border cross-check. This is spec assumption A-07, surfaced rather than smoothed over.

---

## The daily refresh

Registered as a Windows scheduled task, `Build Objects PriceIntel Daily Refresh`, running at 06:30 daily. Setup, the cron equivalent, and what a *failed* run does are in [`scripts/schedule/README.md`](scripts/schedule/README.md).

The honest limitation is there too: the unattended job can refresh only what answers a scripted client. Browser-assisted captures are loaded from `collector/raw/assisted-*.jsonl` and logged with their capture date, so a stale one appears in the diff log as needing an operator rather than quietly ageing into the background.

---

## Deployed

Live at **https://buildobjects-priceintel.vercel.app**, from `main` of
[harthik200620/BuildOPriceintel](https://github.com/harthik200620/BuildOPriceintel).
A push to `main` builds and promotes to production on its own.

The store ships *with* the deployment — there is no database server, and the
query path has no network hop in production either. Two details make that work:

- **The snapshot is what deploys, not the working store.** `data/buildobjects.db`
  keeps `journal_mode = WAL`, so the file on its own is behind whatever the
  collector last wrote, and the pair is ~130 MB — past the 100 MB per-file
  upload limit. `npm run db:snapshot` reads through the WAL and `VACUUM INTO`s
  a single self-contained 24.5 MB file, `data/buildobjects.prod.db`. That one is
  committed, and it is the one a deployment opens.

- **It is opened read-only.** A serverless function filesystem is read-only, so
  `lib/db.ts` sets `readonly` and skips `journal_mode`/`synchronous` whenever
  `VERCEL` or `BUILDOBJECTS_READONLY=1` is set — either pragma would fail before the
  first query ran. `temp_store = MEMORY` stays, so a sort that spills does not
  try to open a temp file next to the database. The only write on the query
  path is `logSearch`, which already swallows its own errors, so `trending`
  simply stops growing in production.

So a refresh is three steps, and skipping the first ships yesterday's prices:

```bash
npm run collect && npm run db:snapshot
git commit -am "Refresh catalogue" && git push
```

To reproduce the read-only path locally before pushing:

```bash
BUILDOBJECTS_READONLY=1 npm run dev
```

---

## Deliberately simplified

Listed in full, with the production path, in [`BuildObjects_Search_ProductionApp_PROMPT.md`](BuildObjects_Search_ProductionApp_PROMPT.md). The short version: no signed quote ledger, no learning-to-rank reranker, no price-shock event bus, no verify-now vendor spend breaker, no zone model beyond two cities, and entity resolution is a deterministic attribute tuple rather than the precision-first scorer with a human review queue.
