/**
 * Freshness. There is no state in which a stale price is presented as current.
 *
 * This is the specific thing every competitor does. IndiaMART's TMT listings
 * run ₹41.30–₹57/kg entirely undated. Moglix is the only Indian platform found
 * that shows a price timestamp at all, and it is page-level rather than per-line.
 */

export type FreshnessState = 'FRESH' | 'AGEING' | 'STALE' | 'EXPIRED';

/** Volatility classes and their refresh SLAs. */
export const SLA_HOURS: Record<string, number> = {
  V0: 24,   // cement, sand, aggregate, bricks/blocks, steel — cement moved ₹15–20/bag in a month
  V1: 168,  // pipes, wires, paints, tiles — commodity-linked inputs, list revisions a few times a year
  V2: 720,  // fittings, hardware, switches, lights, fans
  V3: 2160, // furniture, décor
};

export const CATEGORY_VOLATILITY: Record<string, string> = {
  cement: 'V0',
  tmt_steel: 'V0',
  bricks_blocks: 'V0',
  water_pipes: 'V1',
};

export interface Freshness {
  state: FreshnessState;
  ageHours: number;
  slaHours: number;
  /** Green under 24 h, amber under 72 h, grey beyond — the card's dot. */
  dot: 'green' | 'amber' | 'grey';
  label: string;
  exact: string;
  /** Rank penalty applied when the price is past its SLA. */
  penalty: number;
  quotable: boolean;
}

export function ageHours(pricedAsOf: string, now: Date = new Date()): number {
  return (now.getTime() - new Date(pricedAsOf).getTime()) / 3_600_000;
}

export function humaniseAge(h: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} d ago`;
}

export function assess(pricedAsOf: string, slaHours: number, now: Date = new Date()): Freshness {
  const age = ageHours(pricedAsOf, now);
  const ratio = age / slaHours;

  let state: FreshnessState;
  if (ratio < 0.5) state = 'FRESH';
  else if (ratio < 1) state = 'AGEING';
  else if (ratio < 3) state = 'STALE';
  else state = 'EXPIRED';

  // The dot is on absolute age, not on the SLA ratio — a buyer reads "verified
  // today" the same way whatever category they are looking at.
  const dot: Freshness['dot'] = age < 24 ? 'green' : age < 72 ? 'amber' : 'grey';

  const label =
    state === 'FRESH' || state === 'AGEING'
      ? `verified ${humaniseAge(age)}`
      : state === 'STALE'
        ? `last verified ${humaniseAge(age)}`
        : 'price not current';

  return {
    state,
    ageHours: age,
    slaHours,
    dot,
    label,
    exact: new Date(pricedAsOf).toISOString(),
    penalty: state === 'STALE' || state === 'EXPIRED' ? 0.25 : 0,
    // An EXPIRED price cannot be quoted. No override path exists.
    quotable: state !== 'EXPIRED',
  };
}

/** Excluded from the headline "from ₹" figure once stale. */
export function countsTowardHeadline(f: Freshness): boolean {
  return f.state === 'FRESH' || f.state === 'AGEING';
}
