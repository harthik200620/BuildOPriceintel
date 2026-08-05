/**
 * Every number the estimator is allowed to use, as data with provenance.
 *
 * This file is the estimator's equivalent of `spec_value`: a coefficient with
 * no citation and no confidence label cannot be used, exactly as a field with
 * no provenance cannot render. That is the whole anti-hallucination argument
 * applied to arithmetic — the model never produces a number, it selects a
 * coefficient from here and a deterministic function multiplies.
 *
 * The `confidence` rung matters more here than anywhere else in the app:
 *
 *   CODE      the value is printed in an Indian Standard. Cite clause.
 *   DERIVED   arithmetic on CODE values only. Show the arithmetic.
 *   TRADE     universal Indian site practice, not in any code. Say so.
 *   DRAWING   genuinely unknowable without a structural drawing. Refuse to
 *             present as fact; present as a budgeting band with both ends.
 *
 * A DRAWING-rung coefficient may never be rendered as a single number. Steel
 * per m³ of concrete is the canonical case: quoting "80 kg/m³" for a slab as
 * though it were a fact is the single most common hallucination in this
 * domain, and it is wrong often enough to lose money on a real order.
 */

export type CoeffConfidence = 'CODE' | 'DERIVED' | 'TRADE' | 'DRAWING';

export interface Coefficient {
  id: string;
  label: string;
  value: number;
  unit: string;
  confidence: CoeffConfidence;
  citation: string;
  note?: string;
}

/** Range-valued coefficients. Never collapse to a midpoint silently. */
export interface CoefficientBand {
  id: string;
  label: string;
  low: number;
  high: number;
  unit: string;
  confidence: CoeffConfidence;
  citation: string;
  note?: string;
}

// ─── concrete ────────────────────────────────────────────────────────────────

/**
 * Nominal mix proportions, IS 456:2000 Table 9.
 *
 * IS 456 Cl. 9.1.1 permits nominal mixes only up to M20. M25 as 1:1:2 is
 * universal site practice but is NOT a code nominal mix, and anything above
 * M25 requires a design mix per IS 10262 — a proportion cannot be quoted for
 * it at all. `code_nominal: false` is what makes the bot say that out loud
 * instead of inventing a ratio.
 */
export interface MixGrade {
  grade: string;
  cement: number;
  sand: number;
  aggregate: number;
  code_nominal: boolean;
  citation: string;
  note?: string;
}

export const MIX_GRADES: MixGrade[] = [
  { grade: 'M5',  cement: 1, sand: 5,   aggregate: 10, code_nominal: true,
    citation: 'IS 456:2000, Table 9 (nominal mix proportions)' },
  { grade: 'M7.5', cement: 1, sand: 4,  aggregate: 8,  code_nominal: true,
    citation: 'IS 456:2000, Table 9' },
  { grade: 'M10', cement: 1, sand: 3,   aggregate: 6,  code_nominal: true,
    citation: 'IS 456:2000, Table 9' },
  { grade: 'M15', cement: 1, sand: 2,   aggregate: 4,  code_nominal: true,
    citation: 'IS 456:2000, Table 9' },
  { grade: 'M20', cement: 1, sand: 1.5, aggregate: 3,  code_nominal: true,
    citation: 'IS 456:2000, Table 9 — the highest grade permitted as a nominal mix' },
  { grade: 'M25', cement: 1, sand: 1,   aggregate: 2,  code_nominal: false,
    citation: 'site practice; not a nominal mix in IS 456:2000',
    note: 'IS 456 Cl. 9.1.1 allows nominal mixes to M20 only. 1:1:2 is what the trade uses for M25, but a design mix per IS 10262 is what the code asks for.' },
];

export const MIX_ABOVE_NOMINAL_NOTE =
  'M30 and above must be a design mix under IS 10262:2019 — the proportions come from trial mixes against the actual aggregates, so no fixed ratio exists to quote. I can price the cement once your mix design gives a cement content in kg/m³.';

export const COEFFICIENTS: Record<string, Coefficient> = {
  dry_volume_factor: {
    id: 'dry_volume_factor',
    label: 'Wet-to-dry volume factor for concrete',
    value: 1.54,
    unit: 'ratio',
    confidence: 'TRADE',
    citation: 'universal Indian estimating practice; range 1.52–1.57',
    note: 'Dry ingredients occupy ~54% more volume than the set concrete, because voids in the sand and aggregate close up. Not printed in IS 456 — this is a trade constant.',
  },
  mortar_dry_factor: {
    id: 'mortar_dry_factor',
    label: 'Wet-to-dry volume factor for cement mortar',
    value: 1.33,
    unit: 'ratio',
    confidence: 'TRADE',
    citation: 'universal Indian estimating practice; range 1.27–1.35',
  },
  cement_density: {
    id: 'cement_density',
    label: 'Bulk density of cement',
    value: 1440,
    unit: 'kg/m³',
    confidence: 'TRADE',
    citation: 'standard loose bulk density used for bag-volume conversion',
    note: 'Gives 0.0347 m³ per 50 kg bag, which is the figure every Indian BOQ uses.',
  },
  cement_bag_kg: {
    id: 'cement_bag_kg',
    label: 'Standard cement bag mass',
    value: 50,
    unit: 'kg',
    confidence: 'CODE',
    citation: 'Legal Metrology (Packaged Commodities) Rules, Rule 3(a) — cement is a scheduled commodity packed at 50 kg',
  },
  steel_density: {
    id: 'steel_density',
    label: 'Density of steel',
    value: 7850,
    unit: 'kg/m³',
    confidence: 'CODE',
    citation: 'IS 1786:2008 — basis of the nominal mass table',
  },
  cft_per_m3: {
    id: 'cft_per_m3',
    label: 'Cubic feet per cubic metre',
    value: 35.3147,
    unit: 'cft/m³',
    confidence: 'CODE',
    citation: 'exact unit definition (1 ft = 0.3048 m)',
  },
  mortar_joint_mm: {
    id: 'mortar_joint_mm',
    label: 'Nominal mortar joint thickness',
    value: 10,
    unit: 'mm',
    confidence: 'CODE',
    citation: 'IS 2212:1991 — brickwork joints 10 mm nominal',
  },
};

/**
 * Wastage. Every one of these is a decision the buyer gets to make, so the
 * estimator exposes them rather than baking them in, and the bot states which
 * one it applied. A silent 5% is how an estimate becomes unauditable.
 */
export const WASTAGE: Record<string, Coefficient> = {
  concrete: {
    id: 'wastage_concrete', label: 'Concrete wastage allowance', value: 0.03, unit: 'fraction',
    confidence: 'TRADE', citation: 'typical site allowance, 2–5%',
  },
  brick: {
    id: 'wastage_brick', label: 'Brick breakage allowance', value: 0.05, unit: 'fraction',
    confidence: 'TRADE', citation: 'typical site allowance for clay brick, 3–10%',
    note: 'Clay brick breaks more than AAC or concrete block; 5% is the common tender figure.',
  },
  steel: {
    id: 'wastage_steel', label: 'Steel cutting wastage', value: 0.03, unit: 'fraction',
    confidence: 'TRADE', citation: 'typical bar-bending schedule allowance, 2–5%',
  },
  pipe: {
    id: 'wastage_pipe', label: 'Pipe cutting wastage', value: 0.05, unit: 'fraction',
    confidence: 'TRADE', citation: 'typical plumbing allowance, 5–10% including offcuts',
  },
  mortar: {
    id: 'wastage_mortar', label: 'Mortar wastage allowance', value: 0.15, unit: 'fraction',
    confidence: 'TRADE', citation: 'typical allowance for droppings and over-mixing, 10–20%',
  },
};

// ─── masonry ─────────────────────────────────────────────────────────────────

/**
 * Brick and block sizes, and the mortar-inclusive module each one occupies.
 *
 * `nominal` is size + one joint on the two bedded faces, which is what governs
 * how many units fit in a wall — not the brick's own dimensions. The 230-series
 * traditional brick and the 190-series modular brick give materially different
 * counts (≈409 vs 500 per m³) and the trade uses both in Telangana and Andhra,
 * so the estimator asks rather than assuming.
 */
export interface MasonryUnit {
  id: string;
  label: string;
  l_mm: number;
  w_mm: number;
  h_mm: number;
  joint_mm: number;
  citation: string;
  note?: string;
}

export const MASONRY_UNITS: MasonryUnit[] = [
  { id: 'clay_230', label: 'Traditional red clay brick 230×110×75 mm',
    l_mm: 230, w_mm: 110, h_mm: 75, joint_mm: 10,
    citation: 'the size actually supplied across Telangana and Andhra Pradesh',
    note: 'This is the default in this catalogue — the kilns around Hyderabad and Vijayawada supply it.' },
  { id: 'clay_modular_190', label: 'Modular clay brick 190×90×90 mm',
    l_mm: 190, w_mm: 90, h_mm: 90, joint_mm: 10,
    citation: 'IS 1077:1992 — modular brick, 200×100×100 mm with joint',
    note: 'The code size. Gives exactly 500 bricks per m³.' },
  { id: 'flyash_230', label: 'Fly ash brick 230×110×75 mm',
    l_mm: 230, w_mm: 110, h_mm: 75, joint_mm: 10,
    citation: 'IS 12894:2002 — fly ash lime brick, commonly supplied at clay-brick module' },
  { id: 'aac_600x200x100', label: 'AAC block 600×200×100 mm',
    l_mm: 600, w_mm: 200, h_mm: 100, joint_mm: 10,
    citation: 'IS 2185 Part 3 — autoclaved aerated concrete block',
    note: 'Thin-bed adhesive is 3 mm, not 10 mm, if the block is laid with AAC adhesive rather than cement mortar.' },
  { id: 'aac_600x200x150', label: 'AAC block 600×200×150 mm',
    l_mm: 600, w_mm: 200, h_mm: 150, joint_mm: 10, citation: 'IS 2185 Part 3' },
  { id: 'aac_600x200x200', label: 'AAC block 600×200×200 mm',
    l_mm: 600, w_mm: 200, h_mm: 200, joint_mm: 10, citation: 'IS 2185 Part 3' },
  { id: 'concrete_400x200x100', label: 'Concrete solid block 400×200×100 mm',
    l_mm: 400, w_mm: 200, h_mm: 100, joint_mm: 10, citation: 'IS 2185 Part 1' },
  { id: 'concrete_400x200x200', label: 'Concrete hollow block 400×200×200 mm',
    l_mm: 400, w_mm: 200, h_mm: 200, joint_mm: 10, citation: 'IS 2185 Part 1' },
];

/** Wall thicknesses the trade names, with the dimension they mean. */
export const WALL_THICKNESS: Array<{ id: string; label: string; mm: number; note: string }> = [
  { id: 'half',   label: '4½ inch / half-brick partition', mm: 115,
    note: 'Brick laid on its side. Non-load-bearing — partitions only.' },
  { id: 'full',   label: '9 inch / one-brick wall', mm: 230,
    note: 'The standard load-bearing external wall.' },
  { id: 'oneandhalf', label: '13½ inch / one-and-a-half brick', mm: 345,
    note: 'Heavy load-bearing, or where a 9-inch wall spans too far.' },
  { id: 'aac_100', label: '100 mm AAC partition', mm: 100, note: 'Non-load-bearing.' },
  { id: 'aac_150', label: '150 mm AAC', mm: 150, note: 'Infill wall in a framed structure.' },
  { id: 'aac_200', label: '200 mm AAC external', mm: 200, note: 'External infill wall.' },
];

/**
 * Cement mortar proportions. Ratio is cement : sand by volume.
 * Each carries the application it is specified for, so the bot does not
 * propose a 1:6 mix where the work needs 1:4.
 */
export interface MortarMix {
  id: string;
  label: string;
  cement: number;
  sand: number;
  used_for: string;
  citation: string;
}

export const MORTAR_MIXES: MortarMix[] = [
  { id: 'cm_1_3', label: 'CM 1:3', cement: 1, sand: 3,
    used_for: 'structural repair, tile bedding, sunk-slab screed',
    citation: 'IS 2250:1981 — mortar mix designations' },
  { id: 'cm_1_4', label: 'CM 1:4', cement: 1, sand: 4,
    used_for: 'external plaster, load-bearing brickwork, first coat of two-coat plaster',
    citation: 'IS 2250:1981' },
  { id: 'cm_1_5', label: 'CM 1:5', cement: 1, sand: 5,
    used_for: 'general brickwork, internal plaster where a harder finish is wanted',
    citation: 'IS 2250:1981' },
  { id: 'cm_1_6', label: 'CM 1:6', cement: 1, sand: 6,
    used_for: 'internal plaster and non-load-bearing brickwork — the most common site mix',
    citation: 'IS 2250:1981' },
];

// ─── plaster ─────────────────────────────────────────────────────────────────

export const PLASTER_THICKNESS: Array<{ id: string; label: string; mm: number; citation: string }> = [
  { id: 'internal_12', label: 'Internal plaster, 12 mm', mm: 12,
    citation: 'IS 1661:1972 — 12 mm single coat on brick, internal' },
  { id: 'external_15', label: 'External plaster, 15 mm', mm: 15,
    citation: 'IS 1661:1972 — 15 mm on external face' },
  { id: 'external_20', label: 'External rough-face plaster, 20 mm', mm: 20,
    citation: 'IS 1661:1972 — 20 mm where the background is rough or two-coat' },
  { id: 'ceiling_6', label: 'Ceiling plaster, 6 mm', mm: 6,
    citation: 'IS 1661:1972 — 6 mm on a smooth concrete soffit' },
];

// ─── reinforcement: the DRAWING rung ─────────────────────────────────────────

/**
 * Steel per cubic metre of concrete, BY ELEMENT, AS A BAND.
 *
 * This is the one quantity in the whole domain that cannot be computed from a
 * spec. It comes from a bar bending schedule, which comes from a structural
 * drawing, which comes from the loads. The spread between a lightly and a
 * heavily reinforced column is 3×, so a single figure is not a rounding error
 * — it is a different order.
 *
 * These bands are the widely used tender-stage budgeting ranges. They exist
 * here so the bot can give a buyer a purchasing envelope while telling them,
 * every single time, that the drawing governs. Rendering the midpoint alone is
 * forbidden by `assertBandRendered` in estimator.ts.
 */
export const STEEL_BANDS: CoefficientBand[] = [
  { id: 'steel_footing', label: 'Footings and raft', low: 40, high: 80, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs',
    note: 'Isolated footings sit low in this band, rafts high.' },
  { id: 'steel_column', label: 'Columns', low: 80, high: 250, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs',
    note: 'The widest band of any element — a ground-floor column in a G+4 carries far more steel than a top-floor one.' },
  { id: 'steel_beam', label: 'Beams', low: 80, high: 160, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs',
    note: 'Span and load drive this; a cantilever sits above the band.' },
  { id: 'steel_slab', label: 'Slabs', low: 50, high: 90, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs',
    note: 'A one-way slab sits low, a two-way slab with heavy live load high.' },
  { id: 'steel_lintel', label: 'Lintels and sunshades', low: 50, high: 100, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs' },
  { id: 'steel_staircase', label: 'Staircase', low: 80, high: 150, unit: 'kg/m³',
    confidence: 'DRAWING',
    citation: 'tender-stage budgeting range; the bar bending schedule governs' },
];

export const STEEL_DRAWING_CAVEAT =
  'Steel quantity comes from the bar bending schedule on your structural drawing, not from the concrete volume. The range below is a purchasing envelope for budgeting — do not order against the midpoint without the drawing.';

// ─── lookup helpers ──────────────────────────────────────────────────────────

export function findMix(grade: string): MixGrade | null {
  const g = grade.trim().toUpperCase().replace(/\s+/g, '');
  return MIX_GRADES.find((m) => m.grade.toUpperCase() === g) ?? null;
}

export function findMasonryUnit(id: string): MasonryUnit | null {
  return MASONRY_UNITS.find((u) => u.id === id) ?? null;
}

export function findMortar(id: string): MortarMix | null {
  const k = id.trim().toLowerCase().replace(/[:\s]/g, '_').replace(/^cm_?/, 'cm_');
  return MORTAR_MIXES.find((m) => m.id === k || m.label.toLowerCase().replace(/[:\s]/g, '_') === k) ?? null;
}

export function findSteelBand(element: string): CoefficientBand | null {
  const e = element.trim().toLowerCase();
  return STEEL_BANDS.find((b) => b.id === `steel_${e}` || b.label.toLowerCase().startsWith(e)) ?? null;
}
