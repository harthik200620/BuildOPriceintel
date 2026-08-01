/**
 * The missing-data ladder.
 *
 * Applied in this exact order, never skipping to invention:
 *   1. quoted   — the value the source published
 *   2. derived  — computed from other captured fields, with the arithmetic kept
 *   3. typical  — a brand- or category-level representative value, badged
 *                 TYPICAL in the UI with a tooltip saying it is representative,
 *                 not quoted
 *   4. unknown  — "Not published by seller", with a link to the source page
 *
 * Every field carries value, unit, source_url, fetched_at and confidence.
 * A field with no provenance cannot render.
 */
import type { Confidence, ProvenancedValue } from '../lib/types';

export interface FieldInput {
  field: string;
  label: string;
  unit?: string | null;
  source_url: string;
  fetched_at: string;
}

export class Ladder {
  readonly rows: ProvenancedValue[] = [];
  readonly tally: Record<Confidence, number> = { quoted: 0, derived: 0, typical: 0, unknown: 0 };

  private push(i: FieldInput, value: string, confidence: Confidence, derivation: string | null) {
    this.rows.push({
      field: i.field,
      label: i.label,
      value,
      unit: i.unit ?? null,
      source_url: i.source_url,
      fetched_at: i.fetched_at,
      confidence,
      derivation,
    });
    this.tally[confidence]++;
  }

  /** Rung 1 — the source published it. */
  quoted(i: FieldInput, value: string | number | null | undefined): boolean {
    if (value === null || value === undefined || value === '') return false;
    this.push(i, String(value), 'quoted', null);
    return true;
  }

  /** Rung 2 — computed from other captured fields. The arithmetic is kept. */
  derived(i: FieldInput, value: string | number | null | undefined, derivation: string): boolean {
    if (value === null || value === undefined || value === '') return false;
    this.push(i, String(value), 'derived', derivation);
    return true;
  }

  /** Rung 3 — representative, not quoted. Renders with a TYPICAL badge. */
  typical(i: FieldInput, value: string | number | null | undefined, basis: string): boolean {
    if (value === null || value === undefined || value === '') return false;
    this.push(i, String(value), 'typical', basis);
    return true;
  }

  /** Rung 4 — say so plainly, and link to the page that failed to say it. */
  unknown(i: FieldInput): void {
    this.push(i, 'Not published by seller', 'unknown', null);
  }

  /**
   * Walk the rungs in order and stop at the first that produces a value.
   * This is the only way fields should be resolved — it makes skipping a rung
   * structurally impossible rather than a matter of discipline.
   */
  resolve(
    i: FieldInput,
    rungs: {
      quoted?: () => string | number | null | undefined;
      derived?: () => { value: string | number | null | undefined; how: string } | null;
      typical?: () => { value: string | number | null | undefined; basis: string } | null;
    },
  ): void {
    if (rungs.quoted && this.quoted(i, rungs.quoted())) return;
    if (rungs.derived) {
      const d = rungs.derived();
      if (d && this.derived(i, d.value, d.how)) return;
    }
    if (rungs.typical) {
      const t = rungs.typical();
      if (t && this.typical(i, t.value, t.basis)) return;
    }
    this.unknown(i);
  }

  get(field: string): ProvenancedValue | undefined {
    return this.rows.find((r) => r.field === field);
  }

  value(field: string): string | null {
    const r = this.get(field);
    return r && r.confidence !== 'unknown' ? r.value : null;
  }

  numeric(field: string): number | null {
    const v = this.value(field);
    if (v === null) return null;
    const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
}
