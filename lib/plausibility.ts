/**
 * Plausibility — the rules that decide whether a listing may become a price.
 *
 * Shared by the collector (collector/normalize.ts refuses at load) and by the
 * price surface (lib/rebuild.ts quarantines anything already stored that fails
 * them, so a rule tightened today applies to yesterday's rows too). Every
 * refusal carries its reason; nothing is silently dropped, and nothing here
 * ever changes a number — it only declines to publish one.
 *
 * Why this exists: a category page is one basis — ₹ per 50 kg bag, per kg,
 * per running metre, per piece — and a listing that is not that product, or
 * not on that basis, becomes a wrong price shown as right the moment it is
 * normalised. Measured on the live store before these rules: cement in
 * Vijayawada opened at ₹47.84 a bag (a solvent-cement glue and a 1 kg pouch of
 * white cement), TMT in Hyderabad at ₹30.45 a kg (an FRP bar), pipes at
 * ₹1 a metre (a coupler priced per piece read as a 3 m length). The relative
 * absurdity gate — [0.1×, 10×] of the category median — passed all of them.
 *
 * Three kinds of rule, in the order they run:
 *   1. OFF_TOPIC   — the title names a different product class.
 *   2. BASIS       — the listing cannot be put on the canonical basis without
 *                    inventing something (a retail pouch as a 50 kg bag, a
 *                    coil of unstated length, a bore outside plumbing).
 *   3. BAND        — the seller's own figure per canonical unit sits outside
 *                    what that product sells for in this market by a margin no
 *                    honest quote crosses. Wide bands: they catch decimal
 *                    shifts and unit errors, not expensive brands.
 */

export interface PlausibilityInput {
  category: string;
  /** The seller's own words. */
  title: string;
  /** Resolved attributes, as far as they are known. */
  cement_type?: string | null;
  pack_size_kg?: number | null;
  nominal_bore_mm?: number | null;
  /** The quoted unit after normalisation ('bag', 'kg', 'coil', 'piece' …). */
  quoted_unit?: string | null;
  /** False for rows stored before the bore parser learned to skip wall
      thickness ("4mm 12 inch SWR" once read as 4 mm) — then only the
      infrastructure end of the bore range is enforced. */
  bore_trusted?: boolean;
  /** The seller's price per canonical unit, in paise, on the seller's own GST basis. */
  base_paise_per_canonical?: number | null;
}

/* ── 1. the title names a different product class ───────────────────────── */

const CEMENT_OFF = /waterproof|water proof|wp\+|putty|grout|adhesive|admixture|compound|bond|primer|sealant|plaster|mortar|tile\s?fix|repair|paint|sand\b|aggregate|solvent|refractor|alumina|castable|fire\s?clay|fireclay|fire\s?proof|fireproof|wall\s?doctor|fast\s?setting|quick\s?set|rapid\s?set|rearm|\bfix\b|micro\s?concrete|epoxy|chemical|resin|hardener|acrylic|polymer|dental|\bart\b|craft|hobby|pouch|sachet|gypsum|\bpop\b|\blime\b|colou?r\s?cement|oxide|texture|coating|floor\s?hardener|joint\s?filler|crack/i;

/* "SS Gold" and "stainless" are NOT here: SS Gold is a TMT brand, and a bar
   sold as stainless at ₹55/kg is a TMT bar loosely described — a real SS304 bar
   at ₹140+/kg is refused by the band instead. "Structural" and "beam" are not
   here either: they turn up in TMT titles as the use, not the product. */
const TMT_OFF = /scrap|wire\s?mesh|binding\s?wire|nail|welding|almirah|furniture|utensil|pipe|tube|sheet|angle|channel|\bfrp\b|fibre|fiber|glass\s?fib|basalt|polymer\s?rebar|\bms\s?rod|mild\s?steel\s?(round\s?)?rod|round\s?rod|round\s?bar|square\s?bar|flat\s?bar|hex\s?bar|bright\s?bar|alloy\s?steel|copper|alumin|brass|threaded\s?rod|anchor|bolt|\bmesh\b|jali|fencing|grill|railing|joist|girder|wire\s?rod|\bwire\b|chain|spring|forged|casting|billet|ingot/i;

/** Always a fitting or a non-pipe, whatever else the title says. */
const PIPE_OFF = /conduit|electric|cable|casing|column\s?pipe|duct|machine|scrap|adhesive|solvent|cement\b|coupler|coupling|adapter|adaptor|\bm\.?t\.?a\b|\bf\.?t\.?a\b|elbow|\btee\b|reducer|\bplug\b|end\s?cap|\bcap\b|union|\bbend\b|valve|clamp|bush(ing)?|nipple|flange|connector|ball\s?cock|\btap\b|faucet|shower|fitting|\bclip|hanger|saddle|strainer|trap\b|gully|cowl|jointer|gasket|o.?ring|primer|lubricant|thread\s?seal|teflon|ptfe|sleeve|cutter|tool|wrench|glue|connection\s?pipe|water\s?connection|\bconnection\b|hose|garden|sprinkler|drip\s?(irrigation|lateral|line|tape|kit)|lateral|emitter|lay\s?flat|suction|braided|flexible|stand\s?up|\bml\b|bottle|cosmetic|dwc|sewer/i;
/** A non-pipe, unless the title itself says pipe (or piping): a socket-ended
    SWR pipe is a pipe; a socket on its own is a fitting. */
const PIPE_OFF_UNLESS_PIPE = /socket|\btube\b|filter|screen|mesh|geyser|heater|pump|motor|tank\b|drum|barrel|\bbin\b|tray|sheet|panel|door|window|profile|packing|bubble|foam|insulat|welding|paint|brush|roller/i;

const BRICK_OFF = /sand\b|aggregate|machine|mould|adhesive|mortar|plaster|putty|cover\s?block|spacer|paver|paving|interlock(ing)?\s?(paver|tile|road|floor|paving)|road\s?brick|kerb|curb|tile|refractor|fire\s?brick|fireclay|fire\s?clay|acid\s?(proof|resist)|insulation\s?brick|insulating\s?brick|hot\s?face|cold\s?face|thin\s?brick|cladding|veneer|wall\s?panel|precast\s?(slab|wall|panel|compound)|hollow\s?core|fencing\s?(pole|post)|boundary\s?wall|glass\s?block|quartz|crystal|display\s?block|thermocol|\beps\b|gypsum|drain|manhole|\bpot\b|planter|statue|idol|figurine|toy|lego|chalk|eraser|silica|magnesia|chrome|zircon|carbon|graphite|kiln\s?furniture|crucible|dolomite|bauxite|castable|hanger\s?brick|holding\s?brick|ceramic\s?brick|cement\s?bag|\bopc\b|\bppc\b/i;

export function offTopicReason(category: string, title: string): string | null {
  const t = title ?? '';
  const hit = (re: RegExp) => t.match(re)?.[0] ?? null;
  let m: string | null = null;
  switch (category) {
    case 'cement': m = hit(CEMENT_OFF); break;
    case 'tmt_steel': m = hit(TMT_OFF); break;
    case 'water_pipes':
      m = hit(PIPE_OFF) ?? (/pip(e|ing)/i.test(t) ? null : hit(PIPE_OFF_UNLESS_PIPE));
      break;
    case 'bricks_blocks': m = hit(BRICK_OFF); break;
  }
  return m ? `listed under ${category} but the title names a different product class ("${m.trim()}")` : null;
}

/* ── 2. it cannot be put on the canonical basis honestly ────────────────── */

/** Under this a "bag" is a retail pouch, and ₹ per pouch × 50/pack is not what a bag of cement costs. */
export const CEMENT_MIN_PACK_KG = 20;
/** Plumbing bore. Below is tubing, above is infrastructure — neither is this catalogue. */
export const PIPE_BORE_MM: [number, number] = [15, 315];

export function basisReason(x: PlausibilityInput): string | null {
  if (x.category === 'cement' && x.pack_size_kg != null && x.pack_size_kg < CEMENT_MIN_PACK_KG) {
    return `a ${x.pack_size_kg} kg pack is a retail pouch, not a bag — not comparable per 50 kg`;
  }
  if (x.category === 'water_pipes') {
    if (x.quoted_unit === 'coil' && !/\d+(?:\.\d+)?\s*(?:m|mtr|mtrs|meter|metre|metres|meters)\b/i.test(x.title ?? '')) {
      return 'quoted per coil with no coil length stated — cannot convert to ₹/metre without inventing one';
    }
    const tooSmall = x.bore_trusted !== false && x.nominal_bore_mm != null && x.nominal_bore_mm < PIPE_BORE_MM[0];
    if (tooSmall || (x.nominal_bore_mm != null && x.nominal_bore_mm > PIPE_BORE_MM[1])) {
      return `${x.nominal_bore_mm} mm bore is outside the ${PIPE_BORE_MM[0]}–${PIPE_BORE_MM[1]} mm plumbing range this catalogue covers`;
    }
  }
  return null;
}

/* ── 3. the figure is outside what the product sells for ────────────────── */

/**
 * Per canonical unit, in paise, on the seller's own basis (either GST
 * treatment). Deliberately wide: the floor is under the cheapest honest quote
 * this market has produced and the ceiling over the dearest premium line —
 * a decimal shift or a per-bag figure typed as per-kg lands far outside.
 *
 *   cement   ₹200 – ₹800 per 50 kg bag (grey); white to ₹2,500
 *            TS SoR basic rate and dealer quotes run ₹300–450 incl. GST;
 *            ₹200 admits bulk ex-GST teasers; premium OPC 53 tops ~₹550.
 *   tmt      ₹35 – ₹110 per kg — secondary mills ~₹42–48 ex-GST, primary
 *            premium ~₹65–75; a stainless bar is refused above by title.
 *   pipes    ₹4 – ₹3,000 per running metre — 15 mm uPVC ~₹15/m; 315 mm
 *            HDPE PE100 PN10 ~₹2,000–2,500/m.
 *   bricks   ₹2 – ₹400 per piece — clay ₹4–10; a 600×200×250 AAC block
 *            ~₹120–150; large solid concrete blocks under ₹100.
 */
export const PRICE_BAND: Record<string, { lo: number; hi: number; unit: string }> = {
  cement:        { lo: 200_00, hi: 800_00,  unit: 'bag' },
  cement_white:  { lo: 200_00, hi: 2500_00, unit: 'bag' },
  tmt_steel:     { lo: 35_00,  hi: 110_00,  unit: 'kg' },
  water_pipes:   { lo: 4_00,   hi: 3000_00, unit: 'running_metre' },
  bricks_blocks: { lo: 2_00,   hi: 400_00,  unit: 'piece' },
};

export function bandFor(category: string, cement_type?: string | null) {
  if (category === 'cement' && cement_type === 'White cement') return PRICE_BAND.cement_white;
  return PRICE_BAND[category] ?? null;
}

export function bandReason(x: PlausibilityInput): string | null {
  const b = bandFor(x.category, x.cement_type);
  const v = x.base_paise_per_canonical;
  if (!b || v == null) return null;
  const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  if (v < b.lo) return `${rs(v)} per ${b.unit} is below the plausible band (${rs(b.lo)}–${rs(b.hi)}) — a placeholder or a unit error, not a price`;
  if (v > b.hi) return `${rs(v)} per ${b.unit} is above the plausible band (${rs(b.lo)}–${rs(b.hi)}) — a decimal shift or a per-pack figure typed as per-unit, not a price`;
  return null;
}

/** All three, in order. Null means the listing may become a price. */
export function implausibleReason(x: PlausibilityInput): string | null {
  return offTopicReason(x.category, x.title) ?? basisReason(x) ?? bandReason(x);
}
