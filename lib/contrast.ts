/**
 * WCAG contrast, measured against what the browser actually paints.
 *
 * The palette is translucent panes over a gradient ground, and that is exactly
 * the case where eyeballing fails. A pane declared `rgba(198,214,219,.085)` is
 * not a colour anything is read against — the colour is what that alpha
 * *resolves to* over whichever bloom happens to sit behind it. Measuring ink
 * against the declared value instead of the composited one is how a dark theme
 * passes on paper and fails on screen.
 *
 * So this module composites first and measures second, and the test that uses
 * it walks every ink against every pane over every ground.
 */

export type RGB = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(…)` and `rgba(…)`. Alpha defaults to 1. */
export function parseColor(raw: string): RGBA | null {
  const s = raw.trim();

  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const wide = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return [
      parseInt(wide.slice(0, 2), 16),
      parseInt(wide.slice(2, 4), 16),
      parseInt(wide.slice(4, 6), 16),
      1,
    ];
  }

  const fn = s.match(/^rgba?\(([^)]+)\)$/i);
  if (fn) {
    const parts = fn[1].split(/[,/]/).map((p) => p.trim());
    if (parts.length < 3) return null;
    const n = parts.slice(0, 3).map(Number);
    if (n.some((v) => !Number.isFinite(v))) return null;
    const a = parts[3] === undefined ? 1 : Number(parts[3].replace('%', '')) / (parts[3].includes('%') ? 100 : 1);
    return [n[0], n[1], n[2], Number.isFinite(a) ? a : 1];
  }

  return null;
}

export function toHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/**
 * Source-over compositing, quantised to 8 bits per layer.
 *
 * The rounding is deliberate. Compositing in float and rounding once at the end
 * reads about 0.5% higher than what a browser paints, because the browser
 * writes each layer into an 8-bit buffer before the next one lands on it. On a
 * value sitting at 4.50 that difference decides pass or fail, so this rounds
 * where the browser rounds and the committed numbers stay the conservative ones.
 */
export function composite(fg: RGBA, bg: RGB): RGB {
  const a = fg[3];
  return [
    Math.round(a * fg[0] + (1 - a) * bg[0]),
    Math.round(a * fg[1] + (1 - a) * bg[1]),
    Math.round(a * fg[2] + (1 - a) * bg[2]),
  ];
}

/** Apply translucent layers bottom-up onto an opaque base. */
export function stack(base: RGB, ...layers: RGBA[]): RGB {
  return layers.reduce<RGB>((acc, l) => composite(l, acc), base);
}

/** WCAG 2.1 relative luminance. */
export function luminance(c: RGB): number {
  const lin = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.1 contrast ratio. Order-independent. */
export function contrast(a: RGB, b: RGB): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pull every declaration out of a `:root { … }` block.
 *
 * The test reads the live stylesheet rather than carrying its own copy of the
 * hexes. A duplicated palette in a test file drifts the moment someone nudges a
 * colour, and a drifted test asserts nothing — which is the failure mode this
 * whole module exists to replace.
 *
 * Plain properties are captured alongside custom ones because `color-scheme`
 * lives in that block and is load-bearing: on the wrong value the browser
 * renders native select popups and unchecked checkboxes in the opposite theme,
 * which no amount of correct CSS elsewhere can reach.
 */
export function parseRootTokens(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!block) return out;
  // Comments first, or a colon inside one is read as a declaration.
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/** Resolve a token to RGBA, following one level of `var(--x)` indirection. */
export function resolveToken(tokens: Map<string, string>, name: string): RGBA | null {
  const raw = tokens.get(name);
  if (!raw) return null;
  const ref = raw.match(/^var\((--[\w-]+)\)$/);
  return ref ? resolveToken(tokens, ref[1]) : parseColor(raw);
}

export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;
