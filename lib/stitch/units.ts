/**
 * Stitch vocabulary — the DOM-free half of the embroidery engine.
 *
 * A port of the "epoch-stitch" renderer that Sarvam ships on
 * indus.sarvam.ai/login (Aug 2026), reverse-engineered and verified thread-for-
 * thread in stitch-clone/. Every constant here is theirs; this file holds the
 * stitch UNITS (which short threads make up one cell), the thread MATERIALS
 * (how the shader lights them), the reveal DELAY curves and the colour helpers.
 * Nothing here touches the DOM, so tests can import it.
 */

export type Vec2 = [number, number];
export type RGB = [number, number, number];

/** A leg is one thread inside a unit cell, in unit-square coordinates (y down).
    `pinned` legs (motif outlines) do not move with the cloth. */
export type UnitLeg = [Vec2, Vec2] & { pinned?: boolean };
export interface Unit { name: string; legs: UnitLeg[] }

export interface Material {
  name: string;
  widthMul: number;
  sheen: number;    // highlight strength
  sheenW: number;   // highlight band width
  ply: number;      // twist modulation strength
  plyFreq: number;  // twists per unit length
  edge: number;     // edge darkening (1 = none)
  tint: RGB | null; // cool bias for metallics
}

export const COMPOSITION_CELL_SIZE = 16;
export const SITE_CELL_SIZE = 20;

/* ── colour helpers ─────────────────────────────────────────────────────── */

export function hexToRGB(hex: string): RGB {
  const n = hex.replace('#', '');
  return [parseInt(n.slice(0, 2), 16) / 255, parseInt(n.slice(2, 4), 16) / 255, parseInt(n.slice(4, 6), 16) / 255];
}

const hex2 = (v: number) => ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2);

/** shade(hex, n): n ≥ 0 lightens toward white by n; n < 0 multiplies by (1 + n). */
export function shade(hex: string, n: number): string {
  const t = hex.replace('#', '');
  let r = parseInt(t.slice(0, 2), 16), g = parseInt(t.slice(2, 4), 16), b = parseInt(t.slice(4, 6), 16);
  if (n >= 0) { r += (255 - r) * n; g += (255 - g) * n; b += (255 - b) * n; }
  else { r *= 1 + n; g *= 1 + n; b *= 1 + n; }
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

export function mix3(hex: string, tint: RGB): string {
  const t = hex.replace('#', '');
  return '#' + hex2(parseInt(t.slice(0, 2), 16) * tint[0]) + hex2(parseInt(t.slice(2, 4), 16) * tint[1]) + hex2(parseInt(t.slice(4, 6), 16) * tint[2]);
}

/** HSL saturation boost used by StitchEngine.colorBoost (0 on every site surface). */
export function saturateColor(hex: string, satMul: number, lightAdd: number): string {
  const [r, g, b] = hexToRGB(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, c = max - min;
  let h = 0, s = 0;
  if (c > 0) {
    s = c / (1 - Math.abs(2 * l - 1));
    h = (max === r ? ((g - b) / c + 6 * (g < b ? 1 : 0)) % 6 : max === g ? (b - r) / c + 2 : (r - g) / c + 4) * 60;
  }
  const L = Math.max(0, Math.min(0.92, l + lightAdd));
  const C = (1 - Math.abs(2 * L - 1)) * Math.min(1, s * satMul);
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - C / 2;
  const [R, G, B] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  const w = (v: number) => `0${Math.round((v + m) * 255).toString(16)}`.slice(-2);
  return `#${w(R)}${w(G)}${w(B)}`;
}

/** mulberry32 — the PRNG behind the "random"/"uncoordinated" reveal delays. */
export function mulberry32(seed: number): () => number {
  let n = seed >>> 0;
  return () => {
    n |= 0;
    let e = Math.imul((n = (n + 0x6d2b79f5) | 0) ^ (n >>> 15), 1 | n);
    return (((e = (e + Math.imul(e ^ (e >>> 7), 61 | e)) ^ e) ^ (e >>> 14)) >>> 0) / 0x100000000;
  };
}

/* ── materials ──────────────────────────────────────────────────────────── */

export const THREADS: Record<string, Material> = {
  cotton:     { name: 'Stranded Cotton', widthMul: 1,    sheen: 0.72, sheenW: 0.26, ply: 1,    plyFreq: 0.55, edge: 0.42, tint: null },
  siteCotton: { name: 'Site Cotton',     widthMul: 1,    sheen: 0.35, sheenW: 0.16, ply: 0.35, plyFreq: 0.45, edge: 0.36, tint: null },
  heroCotton: { name: 'Hero Cotton',     widthMul: 1,    sheen: 0.56, sheenW: 0.24, ply: 0.4,  plyFreq: 0.48, edge: 0.32, tint: [0.85, 0.9, 1] },
  silk:       { name: 'Silk',            widthMul: 0.95, sheen: 0.92, sheenW: 0.42, ply: 0.25, plyFreq: 0.3,  edge: 0.55, tint: null },
  metallic:   { name: 'Metallic',        widthMul: 0.9,  sheen: 1,    sheenW: 0.2,  ply: 1.4,  plyFreq: 1.3,  edge: 0.3,  tint: [0.85, 0.88, 1] },
  pearl:      { name: 'Pearl Cotton',    widthMul: 1.15, sheen: 0.85, sheenW: 0.3,  ply: 1.3,  plyFreq: 0.7,  edge: 0.38, tint: null },
};

/* ── unit geometry generators (unit square, y down) ─────────────────────── */

const leg = (a: Vec2, b: Vec2): UnitLeg => [a, b];

/** n horizontal legs, boustrophedon (alternating direction) */
function rowsLegs(n: number): UnitLeg[] {
  const out: UnitLeg[] = [];
  for (let t = 0; t < n; t++) { const y = (t + 0.5) / n; out.push(t % 2 ? leg([1, y], [0, y]) : leg([0, y], [1, y])); }
  return out;
}
/** n vertical legs, alternating direction */
function colsLegs(n: number): UnitLeg[] {
  const out: UnitLeg[] = [];
  for (let t = 0; t < n; t++) { const x = (t + 0.5) / n; out.push(t % 2 ? leg([x, 1], [x, 0]) : leg([x, 0], [x, 1])); }
  return out;
}
/** 2e−1 parallel diagonals clipped to the square; "/" runs lower-left → upper-right */
function diagLegs(e: number, dir: '/' | '\\'): UnitLeg[] {
  const out: UnitLeg[] = [], count = 2 * e - 1;
  for (let k = 1; k <= count; k++) {
    const r = k / (count + 1), o = Math.max(0, 2 * r - 1), a = Math.min(1, 2 * r);
    out.push(dir === '/' ? leg([o, a], [a, o]) : leg([o, o], [a, a]));
  }
  return out;
}
const weaveLegs = (n: number): UnitLeg[] => [...rowsLegs(n), ...colsLegs(n)];
const r5 = (v: number) => Math.round(1e5 * v) / 1e5;

/** horizontal scan-line fill of a polygon (motif interiors) */
function scanFill(poly: Vec2[], n: number): UnitLeg[] {
  const ys = poly.map((p) => p[1]), y0 = Math.min(...ys), y1 = Math.max(...ys), out: UnitLeg[] = [];
  let flip = false;
  for (let t = 0; t < n; t++) {
    const y = y0 + ((y1 - y0) * (t + 0.5)) / n, xs: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) xs.push(a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    const yy = r5(y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xa = r5(xs[i]), xb = r5(xs[i + 1]);
      out.push(flip ? leg([xb, yy], [xa, yy]) : leg([xa, yy], [xb, yy]));
      flip = !flip;
    }
  }
  return out;
}
/** pinned outline legs — they do not move with the cloth */
function outlineLegs(poly: Vec2[]): UnitLeg[] {
  return poly.map((p, i) => { const q = poly[(i + 1) % poly.length]; const l = leg([p[0], p[1]], [q[0], q[1]]); l.pinned = true; return l; });
}
function heartPoly(): Vec2[] {
  const out: Vec2[] = [];
  for (let n = 0; n < 22; n++) {
    const t = (n / 22) * Math.PI * 2, x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    out.push([r5(0.5 + x / 38), r5(0.5 - y / 34)]);
  }
  return out;
}
function starPoly(): Vec2[] {
  const out: Vec2[] = [];
  for (let n = 0; n < 10; n++) { const t = -Math.PI / 2 + (n / 10) * Math.PI * 2, rr = n % 2 ? 0.18 : 0.45; out.push([r5(0.5 + Math.cos(t) * rr), r5(0.5 + Math.sin(t) * rr)]); }
  return out;
}
const circlePoly: Vec2[] = (() => { const o: Vec2[] = []; for (let n = 0; n < 18; n++) { const t = (n / 18) * Math.PI * 2; o.push([r5(0.5 + 0.42 * Math.cos(t)), r5(0.5 + 0.42 * Math.sin(t))]); } return o; })();
const diamondPoly: Vec2[] = [[0.5, 0.05], [0.95, 0.5], [0.5, 0.95], [0.05, 0.5]];
const leafPoly: Vec2[] = [[0.5, 0.05], [0.85, 0.35], [0.7, 0.75], [0.5, 0.95], [0.3, 0.75], [0.15, 0.35]];

export const UNITS = {
  cross:  { name: 'Cross',   legs: [leg([0, 1], [1, 0]), leg([0, 0], [1, 1])] },
  slash:  { name: 'Slash',   legs: [leg([0, 1], [1, 0])] },
  back:   { name: 'Back',    legs: [leg([0, 0], [1, 1])] },
  vert:   { name: 'Upright', legs: [leg([0.5, 0], [0.5, 1])] },
  horiz:  { name: 'Bar',     legs: [leg([0, 0.5], [1, 0.5])] },
  half:   { name: 'Half',    legs: [leg([0, 1], [1, 1]), leg([1, 1], [1, 0])] },
  box:    { name: 'Box',     legs: [leg([0.12, 0.12], [0.88, 0.12]), leg([0.88, 0.12], [0.88, 0.88]), leg([0.88, 0.88], [0.12, 0.88]), leg([0.12, 0.88], [0.12, 0.12])] },
  vee:    { name: 'Vee',     legs: [leg([0, 0], [0.5, 1]), leg([0.5, 1], [1, 0])] },
  plus:   { name: 'Plus',    legs: [leg([0.5, 0], [0.5, 1]), leg([0, 0.5], [1, 0.5])] },
  weave3: { name: 'Weave 3×3', legs: weaveLegs(3) },
  weave5: { name: 'Weave 5×5', legs: weaveLegs(5) },
  hatchH: { name: 'Rows',    legs: rowsLegs(6) },
  hatchV: { name: 'Columns', legs: colsLegs(6) },
  hatchR: { name: 'Hatch /', legs: diagLegs(4, '/') },
  hatchL: { name: 'Hatch \\', legs: diagLegs(4, '\\') },
  crossH: { name: 'Cross-hatch', legs: [...diagLegs(4, '/'), ...diagLegs(4, '\\')] },
  satin:  { name: 'Satin fill', legs: diagLegs(7, '/') },
  tweed:  { name: 'Tweed',   legs: [...rowsLegs(3), ...diagLegs(3, '/'), ...diagLegs(3, '\\')] },
  circleFill:  { name: 'Circle',  legs: [...outlineLegs(circlePoly), ...scanFill(circlePoly, 12)] },
  diamondFill: { name: 'Diamond', legs: [...outlineLegs(diamondPoly), ...scanFill(diamondPoly, 10)] },
  heartFill:   { name: 'Heart',   legs: [...outlineLegs(heartPoly()), ...scanFill(heartPoly(), 12)] },
  starFill:    { name: 'Star',    legs: [...outlineLegs(starPoly()), ...scanFill(starPoly(), 11)] },
  leaf:        { name: 'Leaf',    legs: [...outlineLegs(leafPoly), ...scanFill(leafPoly, 10)] },
  sunburst: { name: 'Sunburst', legs: (() => { const o: UnitLeg[] = []; for (let n = 0; n < 12; n++) { const t = (n / 12) * Math.PI * 2; o.push(leg([0.5, 0.5], [r5(0.5 + 0.45 * Math.cos(t)), r5(0.5 + 0.45 * Math.sin(t))])); } return o; })() },
} satisfies Record<string, Unit>;

export type UnitName = keyof typeof UNITS;
export const isMotifUnit = (u: UnitName): boolean => UNITS[u].legs.some((l) => l.pinned);

/** Thread width for a unit of `legCount` legs at cell size `cell` (engine units):
    the site's rule — cell/22 × 4.4 (≤6 legs), 3 (7–14) or 2.1 (>14). */
export const unitLegWidth = (legCount: number, cell: number, widthMul = 1, widthScale = 1): number =>
  (legCount > 14 ? 2.1 : legCount > 6 ? 3 : 4.4) * widthMul * (cell / 22) * widthScale;

/* ── reveal delays ──────────────────────────────────────────────────────── */

export type MotionMode = 'coordinated' | 'ltr' | 'together' | 'uncoordinated' | 'random' | 'wave';
export type MotionOrder = 'ltr' | 'spiral' | 'diag' | 'random';
export type WaveDir = 'right' | 'down' | 'diag' | 'radial';

export interface DelayOpts { mode: MotionMode; stagger: number; cols: number; rows: number; seed: number; order?: MotionOrder; waveDir?: WaveDir }

/** Start delay (ms) of one cell in the stitch-in reveal. */
export function unitDelay(cell: { r: number; c: number }, o: DelayOpts): number {
  const cx = (o.cols - 1) / 2, cy = (o.rows - 1) / 2;
  const rnd = () => mulberry32(o.seed + 31 * cell.r + 7 * cell.c)() * o.stagger * o.cols * 0.8;
  switch (o.mode) {
    case 'together': return 0;
    case 'uncoordinated':
    case 'random': return rnd();
    case 'wave': {
      const d = o.waveDir ?? 'right';
      return (d === 'right' ? cell.c : d === 'down' ? cell.r : d === 'diag' ? (cell.r + cell.c) * 0.7 : 1.2 * Math.hypot(cell.c - cx, cell.r - cy)) * o.stagger;
    }
    case 'coordinated':
    case 'ltr': {
      const ord = o.order ?? 'ltr';
      if (ord === 'spiral') return Math.hypot(cell.c - cx, cell.r - cy) * o.stagger * 1.6;
      if (ord === 'diag') return (cell.r + cell.c) * o.stagger;
      if (ord === 'random') return rnd();
      return (cell.r * o.cols + cell.c) * o.stagger * 0.35;
    }
  }
}

/** The site's streak hash: the same unit for `streak` columns in a row, so the
    texture reads as woven bands rather than noise. */
export function pickUnit<T>(menu: readonly T[], row: number, streak: number, seed: number): T {
  const e = 43758.5453 * Math.sin(127.1 * row + 311.7 * streak + 74.7 * seed);
  return menu[Math.floor((e - Math.floor(e)) * menu.length) % menu.length];
}
