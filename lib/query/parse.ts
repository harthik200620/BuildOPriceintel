/**
 * Query understanding — a grammar that emits TYPED CONSTRAINTS, never a text match.
 *
 * This is the whole differentiator on unit-bearing queries. A search engine's
 * built-in fuzziness cannot know that 4" SWR is 110 mm OD, that `sariya` is
 * rebar, or that `1 inch` is a bore constraint rather than a token. And an LLM
 * that parses `4 inch` into a bore in millimetres is inventing a dimension —
 * so the mapping is a table with tests, and the parser is deterministic.
 *
 * Runs in-process before retrieval. No network, no model call.
 */
import type { Category, ParsedQuery } from '../types';
import { lookupTerm, BRAND_ALIASES, VOCAB } from './vocab';
import { inchToBoreMm, TMT_KG_PER_M } from '../units';

const FRACTIONS: Record<string, number> = {
  '½': 0.5, '¾': 0.75, '¼': 0.25, '1½': 1.5, '1¼': 1.25, '2½': 2.5,
};

function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[×✕]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Damerau-Levenshtein, capped — used for edit-distance-2 correction. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

const ALL_FORMS = VOCAB.flatMap((v) => v.forms.map((f) => ({ form: f.toLowerCase(), entry: v })));

export interface ParseResult extends ParsedQuery {
  /** Set when a token was corrected — shown to the user, never applied silently. */
  correction: { from: string; to: string } | null;
  /** FTS5 MATCH expression built from the surviving free-text tokens. */
  ftsExpr: string;
  trgmExpr: string;
}

export function parseQuery(raw: string, vocabulary: string[] = []): ParseResult {
  const q = normalise(raw);
  const constraints: Record<string, string | number> = {};
  const matched: ParsedQuery['matched_vocabulary'] = [];
  let category: Category | null = null;
  let intent: 'browse' | 'price' = 'browse';
  let unitBearing = false;
  let correction: { from: string; to: string } | null = null;

  // ── 1. dimension triples: `aac block 600x200x100` ─────────────────────────
  const dim = q.match(/(\d{2,4})\s*x\s*(\d{2,4})\s*x\s*(\d{2,4})/);
  if (dim) {
    constraints.size_mm = `${dim[1]}×${dim[2]}×${dim[3]}`;
    unitBearing = true;
  }

  // ── 2. millimetre sizes: `8mm tmt`, `25 mm cpvc` ──────────────────────────
  const mm = q.match(/(\d+(?:\.\d+)?)\s*mm\b/);
  if (mm && !dim) {
    const v = Number(mm[1]);
    // The same number means different things in different categories, so it is
    // held as a pending dimension until the category resolves below.
    constraints._mm = v;
    unitBearing = true;
  }

  // ── 3. inch sizes — a TABLE, never ×25.4 ──────────────────────────────────
  const inch = q.match(/(\d+(?:\s*\/\s*\d+)?(?:\.\d+)?|[½¾¼])\s*(?:inch|inches|in\b|")/);
  if (inch) {
    const t = inch[1].replace(/\s+/g, '');
    const asNum = FRACTIONS[t] ?? (t.includes('/') ? (() => { const [a, b] = t.split('/').map(Number); return a / b; })() : Number(t));
    const key = asNum === 0.5 ? '1/2' : asNum === 0.75 ? '3/4' : String(asNum);
    const bore = inchToBoreMm(key);
    if (bore) {
      constraints.nominal_bore_mm = bore;
      constraints._inch_source = `${inch[1]}" → ${bore} mm (nominal-bore table, not ×25.4)`;
      category = 'water_pipes';
      unitBearing = true;
    }
  }

  // ── 4. cement grade: `53 grade cement`, `opc 43` ──────────────────────────
  const grade = q.match(/\b(33|43|53)\s*(?:grade)?\b/);
  if (grade && /cement|siment|opc|ppc|సిమెంట్|सीमेंट/.test(q)) {
    constraints.opc_grade = `${grade[1]} grade`;
    category = 'cement';
    unitBearing = true;
  }

  // ── 5. steel grade: `fe500d`, `fe 500` ────────────────────────────────────
  const fe = q.replace(/\s+/g, '').match(/fe\s?-?(415|500d|500|550d|550|600)/i);
  if (fe) {
    const g = fe[1].toUpperCase();
    constraints.grade = `Fe ${g}`;
    category = 'tmt_steel';
    unitBearing = true;
  }

  // ── 6. pipe pressure classes ──────────────────────────────────────────────
  const sdr = q.match(/sdr\s*-?\s*(11|13\.5)/);
  if (sdr) { constraints.sdr = `SDR-${sdr[1]}`; category = 'water_pipes'; unitBearing = true; }
  const swr = q.match(/type\s*-?\s*([ab])\b/);
  if (swr && /swr|drain/.test(q)) { constraints.swr_type = `Type ${swr[1].toUpperCase()}`; category = 'water_pipes'; }

  // ── 7. pack size: `cement 50kg` ───────────────────────────────────────────
  const kg = q.match(/(\d+)\s*kg\b/);
  if (kg) { constraints.pack_size_kg = Number(kg[1]); unitBearing = true; }

  // ── 8. vocabulary, including Telugu, Hindi and transliterations ───────────
  const tokens = q.split(/[\s,]+/).filter(Boolean);
  const freeText: string[] = [];

  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) continue;

    const hit = lookupTerm(tok);
    if (hit) {
      if (hit.canonical === 'price') intent = 'price';
      else {
        if (hit.category && !category) category = hit.category as Category;
        freeText.push(hit.canonical);
        if (hit.script !== 'latin' || /[^\x00-\x7F]/.test(tok) || tok !== hit.canonical) {
          matched.push({ term: tok, means: hit.gloss, script: hit.script });
        }
      }
      continue;
    }

    // multi-word vocabulary (`aac block`, `fly ash brick`)
    const two = tokens.slice(tokens.indexOf(tok), tokens.indexOf(tok) + 2).join(' ');
    const hit2 = lookupTerm(two);
    if (hit2) {
      if (hit2.category && !category) category = hit2.category as Category;
      freeText.push(hit2.canonical);
      continue;
    }

    // brand aliases — corrections are shown, never silent
    const brand = BRAND_ALIASES[tok];
    if (brand) {
      constraints.brand = brand;
      if (brand.toLowerCase() !== tok) correction = { from: tok, to: brand };
      continue;
    }

    // edit-distance-2 correction over the real catalogue vocabulary
    if (tok.length >= 4) {
      let best: { form: string; d: number } | null = null;
      for (const { form } of ALL_FORMS) {
        if (Math.abs(form.length - tok.length) > 2) continue;
        const d = editDistance(tok, form, 2);
        if (d > 0 && d <= 2 && (!best || d < best.d)) best = { form, d };
      }
      if (!best) {
        for (const v of vocabulary) {
          const d = editDistance(tok, v, 2);
          if (d > 0 && d <= 2 && (!best || d < best.d)) best = { form: v, d };
        }
      }
      if (best) {
        const e = lookupTerm(best.form);
        if (e?.category && !category) category = e.category as Category;
        if (!correction) correction = { from: tok, to: best.form };
        freeText.push(e?.canonical ?? best.form);
        continue;
      }
    }

    freeText.push(tok);
  }

  // ── 9. resolve the pending millimetre against the category ────────────────
  if (constraints._mm !== undefined) {
    const v = Number(constraints._mm);
    delete constraints._mm;
    if (category === 'tmt_steel' || (!category && TMT_KG_PER_M[v] && v <= 40)) {
      constraints.diameter_mm = v;
      category ??= 'tmt_steel';
    } else if (category === 'water_pipes') {
      constraints.nominal_bore_mm = v;
    } else if (category === 'bricks_blocks') {
      constraints.thickness_mm = v;
    } else {
      constraints.diameter_mm = v;
    }
  }

  if (/price|rate|cost|ధర|రేటు|भाव|दाम/.test(q)) intent = 'price';

  // ── 10. build the retrieval expressions ───────────────────────────────────
  const terms = [...new Set(freeText.filter((t) => t.length > 1))];
  const ftsExpr = terms.length
    ? terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' OR ')
    : '';
  const trgmExpr = terms.length ? terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : '';

  return {
    tokens: terms,
    category,
    constraints,
    intent,
    matched_vocabulary: matched,
    unit_bearing: unitBearing,
    correction,
    ftsExpr,
    trgmExpr,
  };
}

/**
 * The zero-result ladder. Never a dead end: relax the least-selective typed
 * constraint first, then widen to the category, then offer the nearest
 * category, then "request this item".
 */
export function relaxationOrder(constraints: Record<string, string | number>): string[] {
  // Least selective first — dropping a length or a pack size loses far less
  // than dropping a bore or a grade.
  const priority = [
    'pack_size_kg', 'thickness_mm', 'size_mm', 'swr_type', 'sdr', 'opc_grade',
    'grade', 'brand', 'nominal_bore_mm', 'diameter_mm',
  ];
  return priority.filter((k) => k in constraints);
}
