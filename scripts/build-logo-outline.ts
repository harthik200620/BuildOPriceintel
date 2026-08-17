/**
 * Trace the Build Objects mark into a vector outline the stitch engine can clip
 * threads against.
 *
 *   npx tsx scripts/build-logo-outline.ts [scan.jpeg] [--iso 128] [--eps 0.6] [--blur 3]
 *
 * Reads the original logo scan (navy on white; the file is gitignored, so pass
 * its path if it moved), thresholds luminance, runs marching squares with
 * linearly interpolated crossings — the JPEG's antialiased ramp becomes a
 * sub-pixel-accurate contour — links the crossings into closed rings, drops
 * JPEG-blocking noise, simplifies with Douglas–Peucker and writes
 * lib/stitch/logo-outline.ts. The mark is five separate strokes (three slanted
 * bars, two bowl strokes) with no counters, so the script insists on exactly
 * five rings. A check image, scan + rings, lands in screenshots/ (gitignored)
 * so the fit can be eyeballed before the outline is committed.
 */
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name: string, dflt: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
const positional = args.filter((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--')));
const SRC = resolve(positional[0] ?? 'WhatsApp_Image_2026-08-07_at_6.47.36_PM (1).jpeg');
const ISO = flag('iso', 128);        // luminance below this is ink (the scan is bimodal: ink ≈ 51, paper ≥ 240)
const EPS = flag('eps', 0.6);        // Douglas–Peucker tolerance, px
const BLUR = flag('blur', 3);        // box blur radius in px (odd; 1 = none) — tames JPEG ringing
const MIN_AREA = 40;                 // px²: anything smaller is compression noise, not a stroke
const EXPECT_RINGS = 5;
const OUT_TS = resolve('lib/stitch/logo-outline.ts');
const OUT_PNG = resolve('screenshots/logo-outline-check.png');

if (!existsSync(SRC)) {
  console.error(`No scan at ${SRC}\nPass the path to the original logo scan as the first argument.`);
  process.exit(1);
}

type Pt = [number, number];

async function main() {
  const { data, info } = await sharp(SRC).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, ch = info.channels;
  // luminance plane
  let L: Float32Array = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) L[i] = data[i * ch];
  if (BLUR > 1) L = boxBlur(L, W, H, (BLUR - 1) / 2);

  // ── marching squares ─────────────────────────────────────────────────────
  // Corners of cell (x,y): a=(x,y) b=(x+1,y) c=(x+1,y+1) d=(x,y+1). Edge ids
  // name the crossing between two pixel centres; each ring is a walk over them.
  const inside = (x: number, y: number) => L[y * W + x] < ISO;
  const adj = new Map<string, string[]>();
  const link = (p: string, q: string) => {
    (adj.get(p) ?? adj.set(p, []).get(p)!).push(q);
    (adj.get(q) ?? adj.set(q, []).get(q)!).push(p);
  };
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = inside(x, y), b = inside(x + 1, y), c = inside(x + 1, y + 1), d = inside(x, y + 1);
      const idx = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = `h:${x},${y}`, R = `v:${x + 1},${y}`, B = `h:${x},${y + 1}`, Lf = `v:${x},${y}`;
      switch (idx) {
        case 1: link(Lf, B); break;
        case 2: link(B, R); break;
        case 3: link(Lf, R); break;
        case 4: link(T, R); break;
        case 6: link(T, B); break;
        case 7: link(T, Lf); break;
        case 8: link(T, Lf); break;
        case 9: link(T, B); break;
        case 11: link(T, R); break;
        case 12: link(Lf, R); break;
        case 13: link(B, R); break;
        case 14: link(Lf, B); break;
        case 5: case 10: {
          // saddle: decide by the cell centre
          const mean = (L[y * W + x] + L[y * W + x + 1] + L[(y + 1) * W + x + 1] + L[(y + 1) * W + x]) / 4;
          const centreIn = mean < ISO;
          if (idx === 5) { // b,d inside
            if (centreIn) { link(T, Lf); link(R, B); } else { link(T, R); link(Lf, B); }
          } else {         // a,c inside
            if (centreIn) { link(T, R); link(Lf, B); } else { link(T, Lf); link(R, B); }
          }
          break;
        }
      }
    }
  }
  // crossing point of an edge id, in image pixel space (pixel centre = +0.5)
  const point = (id: string): Pt => {
    const [k, rest] = id.split(':'); const [x, y] = rest.split(',').map(Number);
    const L0 = L[y * W + x];
    if (k === 'h') { const L1 = L[y * W + x + 1]; return [x + 0.5 + (ISO - L0) / (L1 - L0), y + 0.5]; }
    const L1 = L[(y + 1) * W + x]; return [x + 0.5, y + 0.5 + (ISO - L0) / (L1 - L0)];
  };

  // ── link into rings ──────────────────────────────────────────────────────
  const seen = new Set<string>();
  const rings: Pt[][] = [];
  let degreeErrors = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ring: Pt[] = [];
    let prev: string | null = null, cur: string = start;
    for (;;) {
      seen.add(cur); ring.push(point(cur));
      const nb = adj.get(cur)!;
      if (nb.length !== 2) { degreeErrors++; break; }
      const next: string = nb[0] === prev ? nb[1] : nb[0];
      if (next === start) break;
      if (seen.has(next)) { degreeErrors++; break; }
      prev = cur; cur = next;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  if (degreeErrors) console.warn(`warning: ${degreeErrors} irregular junction(s) while walking rings`);

  // ── filter, orient, simplify ─────────────────────────────────────────────
  const area = (r: Pt[]) => { let s = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; };
  const kept = rings.filter((r) => Math.abs(area(r)) >= MIN_AREA)
    .map((r) => (area(r) < 0 ? r.slice().reverse() : r))         // canonical winding
    .map((r) => simplifyRing(r, EPS))
    .sort((p, q) => Math.min(...p.map((v) => v[0])) - Math.min(...q.map((v) => v[0])));  // left→right, stable to read
  const dropped = rings.length - kept.length;
  const areas = kept.map((r) => Math.round(Math.abs(area(r))));
  console.log(`rings: ${rings.length} traced, ${dropped} dropped as noise, ${kept.length} kept; areas px²: ${areas.join(', ')}`);
  console.log(`points: ${kept.reduce((n, r) => n + r.length, 0)} after DP ε=${EPS}`);
  if (kept.length !== EXPECT_RINGS) {
    console.error(`expected ${EXPECT_RINGS} rings (three bars + two bowl strokes), got ${kept.length}. Adjust --iso/--blur.`);
    process.exit(2);
  }
  // no ring may sit inside another (the mark has no counters)
  for (let i = 0; i < kept.length; i++) for (let j = 0; j < kept.length; j++) {
    if (i !== j && pointInRing(kept[i][0], kept[j])) { console.error(`ring ${i} lies inside ring ${j} — unexpected counter`); process.exit(3); }
  }

  const xs = kept.flat().map((p) => p[0]), ys = kept.flat().map((p) => p[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v * 10) / 10);
  const sha = createHash('sha1').update(readFileSync(SRC)).digest('hex').slice(0, 8);
  const flat = kept.map((r) => r.flatMap((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]));

  const ts = `/* Generated by scripts/build-logo-outline.ts — do not edit by hand.
 * source ${basename(SRC)} (sha1 ${sha}) ${W}×${H} px · iso ${ISO} · blur ${BLUR} · ε ${EPS} px
 * ${kept.length} rings (three slanted bars + two bowl strokes, no counters), ${flat.reduce((n, r) => n + r.length / 2, 0)} points.
 * Coordinates are scan pixels, origin top-left, y down; each ring is a closed
 * polygon as a flat [x0, y0, x1, y1, …] list. bbox = [x0, y0, x1, y1]. */
export const LOGO_OUTLINE = {
  w: ${W},
  h: ${H},
  bbox: [${bbox.join(', ')}] as [number, number, number, number],
  rings: [
${flat.map((r) => `    [${r.join(', ')}],`).join('\n')}
  ] as number[][],
};
`;
  writeFileSync(OUT_TS, ts);
  console.log(`wrote ${OUT_TS}`);

  // ── check image: scan + rings ────────────────────────────────────────────
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    ${kept.map((r) => `<polygon points="${r.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')}" fill="rgba(0,255,0,.18)" stroke="#ff2a2a" stroke-width="1.2"/>`).join('\n')}
    <rect x="${bbox[0]}" y="${bbox[1]}" width="${bbox[2] - bbox[0]}" height="${bbox[3] - bbox[1]}" fill="none" stroke="#3aa0ff" stroke-width="1" stroke-dasharray="6 4"/>
  </svg>`;
  mkdirSync(join(OUT_PNG, '..'), { recursive: true });
  await sharp(SRC).composite([{ input: Buffer.from(svg) }]).png().toFile(OUT_PNG);
  console.log(`wrote ${OUT_PNG}  bbox ${bbox.join(',')} (${(bbox[2] - bbox[0]).toFixed(1)}×${(bbox[3] - bbox[1]).toFixed(1)})`);
}

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += src[y * W + xx]; n++; } } tmp[y * W + x] = s / n;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; } } out[y * W + x] = s / n;
  }
  return out;
}

function pointInRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker for a closed ring: split at the vertex farthest from vertex 0, simplify both halves. */
function simplifyRing(ring: Pt[], eps: number): Pt[] {
  let far = 1, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), eps), b = dp([...ring.slice(far), ring[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}
function dp(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts;
  const [ax, ay] = pts[0], [bx, by] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  let imax = 0, dmax = -1;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    const d = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
    if (d > dmax) { dmax = d; imax = i; }
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, imax + 1), eps).slice(0, -1), ...dp(pts.slice(imax), eps)];
}

main().catch((e) => { console.error(e); process.exit(1); });
