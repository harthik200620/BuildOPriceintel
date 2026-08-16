/**
 * All money in Build Objects is integer paise. No float touches a rupee anywhere.
 *
 * The reason is not fastidiousness: a cart total that differs from the sum of
 * its lines by a rupee is a dispute on a signed contract, and floating-point
 * rupees produce exactly that at scale.
 */

export type Paise = number;

/** Half-up rounding, the convention Indian tax arithmetic uses. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** GST on a base amount, at a rate in basis points (1800 = 18%). */
export function gstOn(basePaise: Paise, rateBp: number): Paise {
  return roundHalfUp((basePaise * rateBp) / 10_000);
}

/** Strip GST out of a tax-inclusive figure. */
export function baseFromInclusive(inclPaise: Paise, rateBp: number): Paise {
  return roundHalfUp((inclPaise * 10_000) / (10_000 + rateBp));
}

export function rupeesToPaise(rupees: number): Paise {
  return roundHalfUp(rupees * 100);
}

/**
 * Parse a rupee figure straight out of source text, without a float ever
 * existing.
 *
 *   "7.30" -> 730 · "1,250" -> 125000 · "24" -> 2400 · "₹ 8" -> 800
 *
 * `rupeesToPaise` above takes a `number`, which means every caller has already
 * done `Number(text)` and the float has already happened — by the time it is
 * rounded the damage is done. Every adapter was doing `Math.round(rupees * 100)`
 * for exactly this reason. This reads the integer and fractional parts as
 * separate integers and never multiplies a decimal.
 *
 * Returns null rather than guessing: more than two decimal places, a missing
 * number, or trailing junk are all refusals, because a price we cannot read
 * precisely is one we must not publish.
 */
export function paiseFromRupeeText(s: string | null | undefined): Paise | null {
  if (!s) return null;
  const m = s.replace(/[₹,\s]/g, '').match(/^(?:Rs\.?)?(\d+)(?:\.(\d{1,2}))?$/i);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/**
 * Format for display. Always pass the unit separately — this function
 * deliberately will not produce a bare number with no basis attached.
 */
export function formatPaise(p: Paise, opts: { decimals?: boolean } = {}): string {
  const neg = p < 0;
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  // Indian digit grouping: last three, then pairs.
  const s = String(rupees);
  const head = s.length > 3 ? s.slice(0, s.length - 3) : '';
  const tail = s.slice(-3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail : tail;
  const showDecimals = opts.decimals ?? paise !== 0;
  return `${neg ? '−' : ''}₹${grouped}${showDecimals ? '.' + String(paise).padStart(2, '0') : ''}`;
}

/** Compact form for axis labels and dense tables: ₹1.2L, ₹45k. */
export function formatPaiseCompact(p: Paise): string {
  const r = p / 100;
  if (Math.abs(r) >= 1e7) return `₹${(r / 1e7).toFixed(2)}Cr`;
  if (Math.abs(r) >= 1e5) return `₹${(r / 1e5).toFixed(2)}L`;
  if (Math.abs(r) >= 1e3) return `₹${(r / 1e3).toFixed(1)}k`;
  return formatPaise(p, { decimals: false });
}

export function pct(a: number, b: number): number {
  return b === 0 ? 0 : ((a - b) / b) * 100;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : roundHalfUp((s[m - 1] + s[m]) / 2);
}
