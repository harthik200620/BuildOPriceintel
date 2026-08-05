/**
 * The quantity engine. Deterministic arithmetic, no model in the loop.
 *
 * The bot is never permitted to do arithmetic. It selects an estimator and
 * fills its arguments; this file multiplies. Everything it returns carries the
 * working — `steps` is the derivation in the order it was performed, and
 * `coefficients` is every constant that entered it with its citation. A number
 * that appears in a reply and not in `facts` is a hallucination by definition,
 * and validator.ts enforces exactly that.
 *
 * Two rules this file exists to enforce:
 *
 *   1. Nothing rounds until the last step. Rounding cement bags at 8.06 → 8 per
 *      cubic metre and then multiplying by 40 m³ loses two and a half bags.
 *      Every intermediate stays a float; only the purchasable quantity rounds,
 *      and it rounds UP, because you cannot buy 0.4 of a bag.
 *
 *   2. A quantity that depends on a structural drawing is returned as a band
 *      with both ends and a caveat, never as a midpoint. See STEEL_BANDS.
 */

import {
  COEFFICIENTS, WASTAGE, MIX_GRADES, MASONRY_UNITS, MORTAR_MIXES, WALL_THICKNESS,
  PLASTER_THICKNESS, STEEL_BANDS, STEEL_DRAWING_CAVEAT, MIX_ABOVE_NOMINAL_NOTE,
  findMix, findMasonryUnit, findMortar, findSteelBand,
  type Coefficient, type CoefficientBand,
} from './coefficients';
import { TMT_KG_PER_M } from '../units';

export interface MaterialLine {
  material: string;
  /** Exact, unrounded. Kept so a downstream sum does not compound rounding. */
  exact_qty: number;
  /** What to actually buy. Rounded up to a purchasable increment. */
  buy_qty: number;
  unit: string;
  /** Handed to search_products so the bot can price this line. */
  category: string | null;
  search_hint: string | null;
  note?: string;
  /** Set when the quantity is a band rather than a point. */
  band?: { low: number; high: number };
}

export interface EstimateStep {
  label: string;
  expression: string;
  result: string;
}

export interface EstimateResult {
  ok: true;
  kind: string;
  headline: string;
  lines: MaterialLine[];
  steps: EstimateStep[];
  coefficients: Array<Coefficient | CoefficientBand>;
  caveats: string[];
  /** Every numeric atom this result asserts. The validator's whitelist. */
  facts: number[];
  assumptions: Array<{ slot: string; value: string; because: string }>;
}

export interface EstimateFailure {
  ok: false;
  reason: string;
  /** What the bot must ask for before it can retry. */
  missing: Array<{ slot: string; question: string; options?: string[] }>;
}

export type Estimate = EstimateResult | EstimateFailure;

const M3_PER_CFT = 1 / COEFFICIENTS.cft_per_m3.value;
/** 50 kg ÷ 1440 kg/m³ = 0.03472 m³ per bag. */
const BAG_M3 = COEFFICIENTS.cement_bag_kg.value / COEFFICIENTS.cement_density.value;

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ceilTo = (n: number, step = 1) => Math.ceil(n / step - 1e-9) * step;

/** Collect every number a result asserts, so the validator can whitelist it. */
function collectFacts(lines: MaterialLine[], steps: EstimateStep[], extra: number[] = []): number[] {
  const out = new Set<number>(extra);
  for (const l of lines) {
    out.add(r2(l.exact_qty));
    out.add(l.buy_qty);
    if (l.band) { out.add(r2(l.band.low)); out.add(r2(l.band.high)); }
  }
  for (const s of steps) {
    for (const m of s.result.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
    for (const m of s.expression.matchAll(/-?\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  }
  return [...out].filter((n) => Number.isFinite(n));
}

// ─── volume parsing ──────────────────────────────────────────────────────────

export interface Dimensions {
  length_m?: number;
  width_m?: number;
  thickness_m?: number;
  volume_m3?: number;
  area_m2?: number;
  /**
   * True when the text carried no unit at all — "10 x 12".
   *
   * Read as metres it is 120 m²; read as feet, which is what a site in
   * Hyderabad or Vijayawada means nine times in ten, it is 11.15 m². An
   * estimator that silently picks either is wrong by 10× half the time, so
   * this forces the question instead.
   */
  unit_assumed?: boolean;
}

const FT_M = 0.3048;
const IN_M = 0.0254;

/**
 * Turn "20ft x 15ft x 5in" or "6m x 4.5m" into metres.
 *
 * Site conversation in Telangana and Andhra mixes feet for plan dimensions with
 * inches for thickness inside a single sentence, so a parser that assumes one
 * unit throughout gets a slab 12× too thick. Each dimension keeps its own unit.
 */
export function parseDimensions(text: string): Dimensions | null {
  const t = text.toLowerCase().replace(/[×✕]/g, 'x').replace(/\s+/g, ' ');

  // An explicit volume wins over dimensions.
  const vol = t.match(/(\d+(?:\.\d+)?)\s*(?:cubic\s*met(?:er|re)s?|cu\.?\s*m|m3|m\^?3|cum)\b/);
  if (vol) return { volume_m3: Number(vol[1]) };
  const volCft = t.match(/(\d+(?:\.\d+)?)\s*(?:cft|cubic\s*(?:feet|foot)|cu\.?\s*ft)\b/);
  if (volCft) return { volume_m3: Number(volCft[1]) * M3_PER_CFT };

  const num = String.raw`(\d+(?:\.\d+)?)`;
  const unit = String.raw`\s*(mm|cm|m(?:tr|eter|etre)?s?|ft|foot|feet|'|"|in(?:ch(?:es)?)?)?`;
  const re = new RegExp(`${num}${unit}`, 'g');

  const parts: Array<{ v: number; u: string | undefined }> = [];
  // Split on 'x' so "20ft x 15ft" yields two tokens, not four numbers.
  for (const seg of t.split(/\s*x\s*/)) {
    const m = new RegExp(`^${num}${unit}`).exec(seg.trim());
    if (m) parts.push({ v: Number(m[1]), u: m[2] });
  }
  if (parts.length < 2) return null;

  const toM = (v: number, u: string | undefined, fallback: string): number => {
    const uu = (u || fallback).toLowerCase();
    if (uu === 'mm') return v / 1000;
    if (uu === 'cm') return v / 100;
    if (uu === 'ft' || uu === 'foot' || uu === 'feet' || uu === "'") return v * FT_M;
    if (uu === '"' || uu.startsWith('in')) return v * IN_M;
    return v; // metres
  };

  // A trailing unitless number inherits the previous unit; a thickness given
  // bare after two foot dimensions is almost always inches, but guessing that
  // is exactly the kind of assumption that must surface, so it inherits and
  // the caller reports it.
  const anyUnit = parts.some((p) => p.u);
  let lastU = parts.find((p) => p.u)?.u ?? 'm';
  const m: number[] = [];
  for (const p of parts) { if (p.u) lastU = p.u; m.push(toM(p.v, p.u, lastU)); }

  const unit_assumed = !anyUnit;
  if (m.length === 2) return { length_m: m[0], width_m: m[1], area_m2: m[0] * m[1], unit_assumed };
  return {
    length_m: m[0], width_m: m[1], thickness_m: m[2],
    area_m2: m[0] * m[1], volume_m3: m[0] * m[1] * m[2], unit_assumed,
  };
}

/** The question a unitless "10 x 12" has to trigger before anything is computed. */
function unitAmbiguityMissing(text: string): EstimateFailure['missing'][number] {
  return {
    slot: 'units',
    question: `"${text.trim()}" has no unit on it. Feet or metres? In feet that is one room; in metres it is a warehouse, and I will not pick for you.`,
    options: ['feet', 'metres'],
  };
}

// ─── concrete ────────────────────────────────────────────────────────────────

export interface ConcreteArgs {
  grade: string;
  volume_m3?: number;
  dimensions_text?: string;
  wastage_pct?: number;
}

export function estimateConcrete(a: ConcreteArgs): Estimate {
  const missing: EstimateFailure['missing'] = [];
  const assumptions: EstimateResult['assumptions'] = [];

  if (!a.grade) {
    missing.push({
      slot: 'grade',
      question: 'Which concrete grade? The mix ratio and therefore the cement changes with it.',
      options: MIX_GRADES.filter((m) => m.code_nominal).map((m) => m.grade),
    });
  }

  let volume = a.volume_m3;
  if (volume == null && a.dimensions_text) {
    const d = parseDimensions(a.dimensions_text);
    if (d?.unit_assumed) return { ok: false, reason: 'AMBIGUOUS_UNITS', missing: [unitAmbiguityMissing(a.dimensions_text)] };
    if (d?.volume_m3) volume = d.volume_m3;
    else if (d && !d.thickness_m) {
      missing.push({ slot: 'thickness', question: 'I have the plan size but not the thickness — how thick is the slab or member, in inches or mm?' });
    }
  }
  if (volume == null && !missing.some((m) => m.slot === 'thickness')) {
    missing.push({ slot: 'volume', question: 'How much concrete? Either the volume in m³ or the length × width × thickness.' });
  }
  if (missing.length) return { ok: false, reason: 'INCOMPLETE_SPEC', missing };

  const mix = findMix(a.grade);
  if (!mix) {
    const isHigh = /^m(3[0-9]|[4-9][0-9])/i.test(a.grade.trim());
    return {
      ok: false,
      reason: isHigh ? 'DESIGN_MIX_REQUIRED' : 'UNKNOWN_GRADE',
      missing: [{
        slot: 'grade',
        question: isHigh
          ? MIX_ABOVE_NOMINAL_NOTE
          : `I do not have a mix ratio for "${a.grade}". Which of these?`,
        options: MIX_GRADES.map((m) => m.grade),
      }],
    };
  }

  const V = volume!;
  const w = a.wastage_pct != null ? a.wastage_pct / 100 : WASTAGE.concrete.value;
  if (a.wastage_pct == null) {
    assumptions.push({ slot: 'wastage', value: `${r2(w * 100)}%`, because: WASTAGE.concrete.citation });
  }

  const dryF = COEFFICIENTS.dry_volume_factor.value;
  const sum = mix.cement + mix.sand + mix.aggregate;
  const dry = V * dryF * (1 + w);

  const cementM3 = (dry * mix.cement) / sum;
  const cementKg = cementM3 * COEFFICIENTS.cement_density.value;
  const bags = cementKg / COEFFICIENTS.cement_bag_kg.value;
  const sandM3 = (dry * mix.sand) / sum;
  const aggM3 = (dry * mix.aggregate) / sum;

  const steps: EstimateStep[] = [
    { label: 'Wet volume', expression: `${r3(V)} m³`, result: `${r3(V)} m³` },
    { label: 'Dry volume', expression: `${r3(V)} × ${dryF} (dry factor) × ${r2(1 + w)} (wastage)`, result: `${r3(dry)} m³` },
    { label: `Cement share of ${mix.cement}:${mix.sand}:${mix.aggregate}`, expression: `${r3(dry)} × ${mix.cement}/${sum}`, result: `${r3(cementM3)} m³` },
    { label: 'Cement mass', expression: `${r3(cementM3)} × ${COEFFICIENTS.cement_density.value} kg/m³`, result: `${r2(cementKg)} kg` },
    { label: 'Cement bags', expression: `${r2(cementKg)} ÷ ${COEFFICIENTS.cement_bag_kg.value} kg`, result: `${r2(bags)} bags` },
    { label: 'Sand', expression: `${r3(dry)} × ${mix.sand}/${sum}`, result: `${r3(sandM3)} m³ = ${r2(sandM3 * COEFFICIENTS.cft_per_m3.value)} cft` },
    { label: 'Aggregate', expression: `${r3(dry)} × ${mix.aggregate}/${sum}`, result: `${r3(aggM3)} m³ = ${r2(aggM3 * COEFFICIENTS.cft_per_m3.value)} cft` },
  ];

  const lines: MaterialLine[] = [
    { material: `Cement (OPC 43 or 53 grade suits ${mix.grade})`, exact_qty: bags, buy_qty: ceilTo(bags), unit: 'bag', category: 'cement', search_hint: 'OPC cement 50 kg bag' },
    { material: 'River / M-sand (fine aggregate)', exact_qty: sandM3 * COEFFICIENTS.cft_per_m3.value, buy_qty: ceilTo(sandM3 * COEFFICIENTS.cft_per_m3.value), unit: 'cft', category: null, search_hint: null, note: 'Not in this catalogue yet — quantity only.' },
    { material: '20 mm coarse aggregate', exact_qty: aggM3 * COEFFICIENTS.cft_per_m3.value, buy_qty: ceilTo(aggM3 * COEFFICIENTS.cft_per_m3.value), unit: 'cft', category: null, search_hint: null, note: 'Not in this catalogue yet — quantity only.' },
  ];

  const caveats: string[] = [];
  if (!mix.code_nominal) caveats.push(mix.note!);
  caveats.push('Reinforcement is not included — steel comes from the bar bending schedule, not the concrete volume. Ask me and I will give you the budgeting band.');

  return {
    ok: true, kind: 'concrete',
    headline: `${mix.grade} concrete, ${r2(V)} m³`,
    lines, steps,
    coefficients: [COEFFICIENTS.dry_volume_factor, COEFFICIENTS.cement_density, COEFFICIENTS.cement_bag_kg, COEFFICIENTS.cft_per_m3, WASTAGE.concrete],
    caveats, assumptions,
    facts: collectFacts(lines, steps, [V, r2(V), dryF, sum, mix.cement, mix.sand, mix.aggregate, r2(w * 100)]),
  };
}

// ─── masonry ─────────────────────────────────────────────────────────────────

export interface MasonryArgs {
  unit_id?: string;
  wall_thickness_mm?: number;
  area_m2?: number;
  dimensions_text?: string;
  mortar_id?: string;
  wastage_pct?: number;
  openings_pct?: number;
}

export function estimateMasonry(a: MasonryArgs): Estimate {
  const missing: EstimateFailure['missing'] = [];
  const assumptions: EstimateResult['assumptions'] = [];

  let area = a.area_m2;
  if (area == null && a.dimensions_text) {
    const d = parseDimensions(a.dimensions_text);
    if (d?.unit_assumed) return { ok: false, reason: 'AMBIGUOUS_UNITS', missing: [unitAmbiguityMissing(a.dimensions_text)] };
    if (d?.area_m2) area = d.area_m2;
  }
  if (area == null) {
    missing.push({ slot: 'area', question: 'How much wall? Give me the area, or the length × height — feet is fine.' });
  }
  if (!a.unit_id) {
    missing.push({
      slot: 'unit_id',
      question: 'Which brick or block? The count per m² changes by more than 10× between a clay brick and a 200 mm AAC block, so I will not guess.',
      options: MASONRY_UNITS.map((u) => u.label),
    });
  }
  if (missing.length) return { ok: false, reason: 'INCOMPLETE_SPEC', missing };

  const u = findMasonryUnit(a.unit_id!);
  if (!u) {
    return { ok: false, reason: 'UNKNOWN_UNIT', missing: [{ slot: 'unit_id', question: 'I do not stock that size. Which of these?', options: MASONRY_UNITS.map((x) => x.label) }] };
  }

  // Wall thickness defaults to the unit's own bedded width — laying a 230 mm
  // brick as a 9-inch wall is the common case, and an AAC block only ever
  // builds a wall its own thickness.
  let tmm = a.wall_thickness_mm;
  if (tmm == null) {
    tmm = u.id.startsWith('aac') || u.id.startsWith('concrete') ? u.h_mm : u.l_mm;
    assumptions.push({
      slot: 'wall_thickness_mm', value: `${tmm} mm`,
      because: u.id.startsWith('aac') || u.id.startsWith('concrete')
        ? 'a block wall is one block thick'
        : 'a 230 mm brick laid as a full-brick (9 inch) wall — say "4½ inch" if it is a partition',
    });
  }

  const j = u.joint_mm;
  const modL = (u.l_mm + j) / 1000, modW = (u.w_mm + j) / 1000, modH = (u.h_mm + j) / 1000;
  const perM3 = 1 / (modL * modW * modH);
  const wallM3 = area! * (tmm / 1000);

  const openings = a.openings_pct != null ? a.openings_pct / 100 : 0;
  if (a.openings_pct == null) {
    assumptions.push({ slot: 'openings', value: '0%', because: 'no deduction for doors and windows — tell me the opening area and I will subtract it' });
  }
  const netM3 = wallM3 * (1 - openings);

  const w = a.wastage_pct != null ? a.wastage_pct / 100 : WASTAGE.brick.value;
  if (a.wastage_pct == null) assumptions.push({ slot: 'wastage', value: `${r2(w * 100)}%`, because: WASTAGE.brick.citation });

  const countExact = netM3 * perM3 * (1 + w);

  // Mortar = wall volume minus the solid units in it.
  const solidM3 = netM3 * perM3 * (u.l_mm * u.w_mm * u.h_mm) / 1e9;
  const mortarWet = Math.max(0, netM3 - solidM3);
  const mortarDry = mortarWet * COEFFICIENTS.mortar_dry_factor.value * (1 + WASTAGE.mortar.value);

  const mortar = findMortar(a.mortar_id ?? 'cm_1_6') ?? MORTAR_MIXES.find((m) => m.id === 'cm_1_6')!;
  if (!a.mortar_id) assumptions.push({ slot: 'mortar', value: mortar.label, because: `the default site mix for ${mortar.used_for}` });
  const msum = mortar.cement + mortar.sand;
  const mCementM3 = (mortarDry * mortar.cement) / msum;
  const mBags = (mCementM3 * COEFFICIENTS.cement_density.value) / COEFFICIENTS.cement_bag_kg.value;
  const mSandM3 = (mortarDry * mortar.sand) / msum;

  const steps: EstimateStep[] = [
    { label: 'Wall area', expression: `${r2(area!)} m²`, result: `${r2(area!)} m²` },
    { label: 'Wall volume', expression: `${r2(area!)} m² × ${tmm} mm thick${openings ? ` × ${r2(1 - openings)} (openings)` : ''}`, result: `${r3(netM3)} m³` },
    { label: 'Units per m³', expression: `1 ÷ (${(u.l_mm + j) / 1000} × ${(u.w_mm + j) / 1000} × ${(u.h_mm + j) / 1000}) — size + ${j} mm joint`, result: `${r2(perM3)} per m³` },
    { label: 'Count', expression: `${r3(netM3)} × ${r2(perM3)} × ${r2(1 + w)} (wastage)`, result: `${r2(countExact)} units` },
    { label: 'Mortar, wet', expression: `${r3(netM3)} m³ wall − ${r3(solidM3)} m³ of units`, result: `${r3(mortarWet)} m³` },
    { label: 'Mortar, dry', expression: `${r3(mortarWet)} × ${COEFFICIENTS.mortar_dry_factor.value} × ${r2(1 + WASTAGE.mortar.value)}`, result: `${r3(mortarDry)} m³` },
    { label: `Mortar cement (${mortar.label})`, expression: `${r3(mortarDry)} × ${mortar.cement}/${msum} × ${COEFFICIENTS.cement_density.value} ÷ ${COEFFICIENTS.cement_bag_kg.value}`, result: `${r2(mBags)} bags` },
  ];

  const lines: MaterialLine[] = [
    { material: u.label, exact_qty: countExact, buy_qty: ceilTo(countExact), unit: 'piece', category: 'bricks_blocks', search_hint: u.label },
    { material: `Cement for ${mortar.label} mortar`, exact_qty: mBags, buy_qty: ceilTo(mBags), unit: 'bag', category: 'cement', search_hint: 'OPC cement 50 kg bag' },
    { material: 'Sand for mortar', exact_qty: mSandM3 * COEFFICIENTS.cft_per_m3.value, buy_qty: ceilTo(mSandM3 * COEFFICIENTS.cft_per_m3.value), unit: 'cft', category: null, search_hint: null, note: 'Not in this catalogue yet — quantity only.' },
  ];

  const caveats: string[] = [];
  if (u.note) caveats.push(u.note);
  if (u.id.startsWith('aac') && (a.mortar_id ?? '').startsWith('cm')) {
    caveats.push('AAC laid with thin-bed adhesive uses a 3 mm joint, not 10 mm — that cuts the mortar to about a quarter and changes the block count slightly. Tell me which you are using.');
  }

  return {
    ok: true, kind: 'masonry',
    headline: `${u.label} — ${r2(area!)} m² of ${tmm} mm wall`,
    lines, steps,
    coefficients: [COEFFICIENTS.mortar_joint_mm, COEFFICIENTS.mortar_dry_factor, COEFFICIENTS.cement_density, COEFFICIENTS.cement_bag_kg, WASTAGE.brick, WASTAGE.mortar],
    caveats, assumptions,
    facts: collectFacts(lines, steps, [r2(area!), tmm, u.l_mm, u.w_mm, u.h_mm, j, r2(perM3), r2(w * 100)]),
  };
}

// ─── plaster ─────────────────────────────────────────────────────────────────

export interface PlasterArgs {
  area_m2?: number;
  dimensions_text?: string;
  thickness_mm?: number;
  mortar_id?: string;
  faces?: 1 | 2;
}

export function estimatePlaster(a: PlasterArgs): Estimate {
  const assumptions: EstimateResult['assumptions'] = [];
  let area = a.area_m2;
  if (area == null && a.dimensions_text) {
    const d = parseDimensions(a.dimensions_text);
    if (d?.unit_assumed) return { ok: false, reason: 'AMBIGUOUS_UNITS', missing: [unitAmbiguityMissing(a.dimensions_text)] };
    area = d?.area_m2;
  }
  if (area == null) {
    return { ok: false, reason: 'INCOMPLETE_SPEC', missing: [{ slot: 'area', question: 'How much plaster area? Length × height is fine, and say whether it is one face or both.' }] };
  }

  const faces = a.faces ?? 1;
  if (a.faces == null) assumptions.push({ slot: 'faces', value: 'one face', because: 'say "both sides" and I will double it' });

  const t = a.thickness_mm ?? 12;
  if (a.thickness_mm == null) {
    assumptions.push({ slot: 'thickness', value: '12 mm', because: PLASTER_THICKNESS[0].citation });
  }

  const mortar = findMortar(a.mortar_id ?? 'cm_1_6') ?? MORTAR_MIXES.find((m) => m.id === 'cm_1_6')!;
  if (!a.mortar_id) assumptions.push({ slot: 'mortar', value: mortar.label, because: `the default for ${mortar.used_for}` });

  const A = area * faces;
  const wet = A * (t / 1000);
  const dry = wet * COEFFICIENTS.mortar_dry_factor.value * (1 + WASTAGE.mortar.value);
  const sum = mortar.cement + mortar.sand;
  const cM3 = (dry * mortar.cement) / sum;
  const bags = (cM3 * COEFFICIENTS.cement_density.value) / COEFFICIENTS.cement_bag_kg.value;
  const sM3 = (dry * mortar.sand) / sum;

  const steps: EstimateStep[] = [
    { label: 'Plaster area', expression: `${r2(area)} m² × ${faces} face${faces > 1 ? 's' : ''}`, result: `${r2(A)} m²` },
    { label: 'Wet volume', expression: `${r2(A)} × ${t} mm`, result: `${r3(wet)} m³` },
    { label: 'Dry volume', expression: `${r3(wet)} × ${COEFFICIENTS.mortar_dry_factor.value} × ${r2(1 + WASTAGE.mortar.value)}`, result: `${r3(dry)} m³` },
    { label: `Cement (${mortar.label})`, expression: `${r3(dry)} × ${mortar.cement}/${sum} × ${COEFFICIENTS.cement_density.value} ÷ ${COEFFICIENTS.cement_bag_kg.value}`, result: `${r2(bags)} bags` },
    { label: 'Sand', expression: `${r3(dry)} × ${mortar.sand}/${sum}`, result: `${r2(sM3 * COEFFICIENTS.cft_per_m3.value)} cft` },
  ];

  const lines: MaterialLine[] = [
    { material: `Cement for ${mortar.label} plaster`, exact_qty: bags, buy_qty: ceilTo(bags), unit: 'bag', category: 'cement', search_hint: 'OPC cement 50 kg bag' },
    { material: 'Plastering sand', exact_qty: sM3 * COEFFICIENTS.cft_per_m3.value, buy_qty: ceilTo(sM3 * COEFFICIENTS.cft_per_m3.value), unit: 'cft', category: null, search_hint: null, note: 'Not in this catalogue yet — quantity only.' },
  ];

  return {
    ok: true, kind: 'plaster',
    headline: `${t} mm ${mortar.label} plaster, ${r2(A)} m²`,
    lines, steps,
    coefficients: [COEFFICIENTS.mortar_dry_factor, COEFFICIENTS.cement_density, COEFFICIENTS.cement_bag_kg, WASTAGE.mortar],
    caveats: ['Plaster sand should be finer than concrete sand — the same pile rarely suits both.'],
    assumptions,
    facts: collectFacts(lines, steps, [r2(area), r2(A), t, faces]),
  };
}

// ─── reinforcement ───────────────────────────────────────────────────────────

export interface SteelArgs {
  element?: string;
  volume_m3?: number;
  dimensions_text?: string;
  /** If the user has a bar schedule, they give kg/m³ and the band is skipped. */
  known_kg_per_m3?: number;
  diameter_mm?: number;
  rod_length_m?: number;
}

export function estimateSteel(a: SteelArgs): Estimate {
  const assumptions: EstimateResult['assumptions'] = [];
  let V = a.volume_m3;
  if (V == null && a.dimensions_text) {
    const d = parseDimensions(a.dimensions_text);
    if (d?.unit_assumed) return { ok: false, reason: 'AMBIGUOUS_UNITS', missing: [unitAmbiguityMissing(a.dimensions_text)] };
    V = d?.volume_m3;
  }

  if (V == null) {
    return { ok: false, reason: 'INCOMPLETE_SPEC', missing: [{ slot: 'volume', question: 'What concrete volume is the steel going into? Give me m³, or length × width × thickness.' }] };
  }
  if (!a.element && a.known_kg_per_m3 == null) {
    return {
      ok: false, reason: 'INCOMPLETE_SPEC',
      missing: [{
        slot: 'element',
        question: 'Which element? Steel per m³ runs from about 40 kg in a footing to 250 kg in a column, so the element decides the answer.',
        options: STEEL_BANDS.map((b) => b.label),
      }],
    };
  }

  const w = WASTAGE.steel.value;
  const steps: EstimateStep[] = [{ label: 'Concrete volume', expression: `${r3(V)} m³`, result: `${r3(V)} m³` }];
  const lines: MaterialLine[] = [];
  const caveats: string[] = [];
  const coefficients: Array<Coefficient | CoefficientBand> = [WASTAGE.steel];
  let factExtra: number[] = [r3(V)];

  if (a.known_kg_per_m3 != null) {
    const kg = V * a.known_kg_per_m3 * (1 + w);
    steps.push({ label: 'Steel from your bar schedule', expression: `${r3(V)} × ${a.known_kg_per_m3} kg/m³ × ${r2(1 + w)} (cutting wastage)`, result: `${r2(kg)} kg` });
    lines.push({ material: 'TMT reinforcement bar', exact_qty: kg, buy_qty: ceilTo(kg, 10), unit: 'kg', category: 'tmt_steel', search_hint: `TMT bar Fe 500${a.diameter_mm ? ` ${a.diameter_mm} mm` : ''}` });
    factExtra.push(a.known_kg_per_m3, r2(kg));
  } else {
    const band = findSteelBand(a.element!);
    if (!band) {
      return { ok: false, reason: 'UNKNOWN_ELEMENT', missing: [{ slot: 'element', question: 'Which element?', options: STEEL_BANDS.map((b) => b.label) }] };
    }
    coefficients.push(band);
    const lo = V * band.low * (1 + w);
    const hi = V * band.high * (1 + w);
    steps.push({ label: `${band.label} — budgeting band`, expression: `${r3(V)} × ${band.low}–${band.high} kg/m³ × ${r2(1 + w)}`, result: `${r2(lo)}–${r2(hi)} kg` });
    lines.push({
      material: 'TMT reinforcement bar', exact_qty: lo, buy_qty: ceilTo(lo, 10), unit: 'kg',
      category: 'tmt_steel', search_hint: `TMT bar Fe 500${a.diameter_mm ? ` ${a.diameter_mm} mm` : ''}`,
      band: { low: lo, high: hi },
      note: 'Band, not a figure. Order against your bar bending schedule.',
    });
    caveats.push(STEEL_DRAWING_CAVEAT);
    if (band.note) caveats.push(band.note);
    factExtra.push(band.low, band.high, r2(lo), r2(hi));
  }

  // Rod count, only if they named a diameter — otherwise it is unanswerable.
  if (a.diameter_mm) {
    const kgPerM = TMT_KG_PER_M[a.diameter_mm];
    if (!kgPerM) {
      caveats.push(`I do not have a nominal mass for ${a.diameter_mm} mm bar — IS 1786 sizes I hold are ${Object.keys(TMT_KG_PER_M).join(', ')} mm.`);
    } else {
      const L = a.rod_length_m ?? 12;
      if (!a.rod_length_m) assumptions.push({ slot: 'rod_length', value: '12 m', because: 'the standard mill length; ask for 9 m if your site cannot take 12 m' });
      const perRod = kgPerM * L;
      const kgLine = lines[0];
      const rods = kgLine.exact_qty / perRod;
      // A rod count derived from a band is still a band. Collapsing it to the
      // low end reads as a firm number and under-orders by up to 80%.
      const rodBand = kgLine.band
        ? { low: kgLine.band.low / perRod, high: kgLine.band.high / perRod }
        : undefined;
      steps.push({
        label: `Rods at ${a.diameter_mm} mm × ${L} m`,
        expression: rodBand
          ? `${r2(kgLine.band!.low)}–${r2(kgLine.band!.high)} kg ÷ (${kgPerM} kg/m × ${L} m = ${r2(perRod)} kg/rod)`
          : `${r2(kgLine.exact_qty)} kg ÷ (${kgPerM} kg/m × ${L} m = ${r2(perRod)} kg/rod)`,
        result: rodBand ? `${Math.ceil(rodBand.low)}–${Math.ceil(rodBand.high)} rods` : `${Math.ceil(rods)} rods`,
      });
      lines.push({
        material: `${a.diameter_mm} mm TMT rod, ${L} m`,
        exact_qty: rods, buy_qty: Math.ceil(rods), unit: 'rod',
        category: 'tmt_steel', search_hint: `TMT bar ${a.diameter_mm} mm`,
        band: rodBand,
        note: rodBand
          ? 'A band, because the mass above is a band. Your bar schedule collapses it to a number.'
          : 'Derived from the mass above — not an independent quantity.',
      });
      factExtra.push(kgPerM, L, r2(perRod), Math.ceil(rods));
      if (rodBand) factExtra.push(Math.ceil(rodBand.low), Math.ceil(rodBand.high));
    }
  }

  return {
    ok: true, kind: 'steel',
    headline: a.known_kg_per_m3 != null ? `Reinforcement for ${r2(V)} m³, from your schedule` : `Reinforcement band for ${r2(V)} m³ of ${a.element}`,
    lines, steps, coefficients, caveats, assumptions,
    facts: collectFacts(lines, steps, factExtra),
  };
}

// ─── plumbing ────────────────────────────────────────────────────────────────

export interface PipeArgs {
  run_length_m?: number;
  bore_mm?: number;
  system?: string;
  stock_length_m?: number;
  wastage_pct?: number;
}

export function estimatePipe(a: PipeArgs): Estimate {
  const missing: EstimateFailure['missing'] = [];
  const assumptions: EstimateResult['assumptions'] = [];

  if (a.run_length_m == null) missing.push({ slot: 'run_length', question: 'How many running metres of pipe? Measure the run, not the room.' });
  if (a.bore_mm == null) {
    missing.push({
      slot: 'bore',
      question: 'What bore? Inches map to millimetres by table, not by multiplication — a 4 inch SWR is 110 mm OD, not 101.6 mm.',
      options: ['15 mm (½")', '20 mm (¾")', '25 mm (1")', '32 mm (1¼")', '40 mm (1½")', '63 mm (2")', '110 mm (4")'],
    });
  }
  if (missing.length) return { ok: false, reason: 'INCOMPLETE_SPEC', missing };

  const stock = a.stock_length_m ?? 3;
  if (a.stock_length_m == null) assumptions.push({ slot: 'stock_length', value: '3 m', because: 'the standard supplied length for CPVC, UPVC and SWR; GI comes in 6 m' });

  const w = a.wastage_pct != null ? a.wastage_pct / 100 : WASTAGE.pipe.value;
  if (a.wastage_pct == null) assumptions.push({ slot: 'wastage', value: `${r2(w * 100)}%`, because: WASTAGE.pipe.citation });

  const totalM = a.run_length_m! * (1 + w);
  const lengths = totalM / stock;

  const steps: EstimateStep[] = [
    { label: 'Run', expression: `${r2(a.run_length_m!)} m`, result: `${r2(a.run_length_m!)} m` },
    { label: 'With offcuts', expression: `${r2(a.run_length_m!)} × ${r2(1 + w)}`, result: `${r2(totalM)} m` },
    { label: 'Lengths to buy', expression: `${r2(totalM)} ÷ ${stock} m per length`, result: `${Math.ceil(lengths)} lengths` },
  ];

  const lines: MaterialLine[] = [
    { material: `${a.bore_mm} mm ${a.system ?? ''} pipe`.replace(/\s+/g, ' ').trim(), exact_qty: totalM, buy_qty: Math.ceil(lengths) * stock, unit: 'running metre', category: 'water_pipes', search_hint: `${a.system ?? ''} pipe ${a.bore_mm} mm`.trim() },
  ];

  return {
    ok: true, kind: 'pipe',
    headline: `${a.bore_mm} mm ${a.system ?? 'pipe'} — ${r2(a.run_length_m!)} m run`,
    lines, steps,
    coefficients: [WASTAGE.pipe], assumptions,
    caveats: ['Fittings — elbows, tees, couplers, solvent cement — are not counted here. On a typical domestic run they add 25–40% to the pipe cost, and they depend on the layout drawing.'],
    facts: collectFacts(lines, steps, [r2(a.run_length_m!), a.bore_mm!, stock, r2(w * 100)]),
  };
}

// ─── registry ────────────────────────────────────────────────────────────────

export const ESTIMATORS = {
  concrete: estimateConcrete,
  masonry: estimateMasonry,
  plaster: estimatePlaster,
  steel: estimateSteel,
  pipe: estimatePipe,
} as const;

export type EstimatorKind = keyof typeof ESTIMATORS;

export function runEstimator(kind: string, args: Record<string, unknown>): Estimate {
  const fn = (ESTIMATORS as Record<string, (a: any) => Estimate>)[kind];
  if (!fn) {
    return { ok: false, reason: 'UNKNOWN_ESTIMATOR', missing: [{ slot: 'kind', question: 'What are you building?', options: Object.keys(ESTIMATORS) }] };
  }
  return fn(args);
}

export { MASONRY_UNITS, MIX_GRADES, MORTAR_MIXES, WALL_THICKNESS, PLASTER_THICKNESS, STEEL_BANDS };
