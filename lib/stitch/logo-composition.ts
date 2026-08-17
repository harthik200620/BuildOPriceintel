/**
 * The mark as stitches: Sarvam's cell texture, clipped to our exact outline.
 *
 * The site's own art is a grid of whole cells. Ours lays the same grid over the
 * traced "b" (lib/stitch/logo-outline.ts), gives every cell the same unit the
 * site's streak hash would (satin diagonals with the odd row of hatch, in bands
 * five cells wide, seed 41), and then clips every thread against the outline
 * rings. Interior cells come out identical to the site's; the cells on the
 * edge keep only the part of each thread that lies inside the stroke, so the
 * silhouette is the logo's to a fraction of a scan pixel while the texture and
 * the per-thread cloth movement stay exactly the site's.
 *
 * Pure: no DOM, no engine import at runtime. Segments carry their cell (c, r,
 * li) so the engine schedules and moves them like whole-cell threads.
 */
import { LOGO_OUTLINE } from './logo-outline';
import { LOGO_BLUE } from './palette';
import { SITE_CELL_SIZE, UNITS, pickUnit, unitLegWidth, type UnitName, type Vec2 } from './units';
import type { Segment } from './engine';

export { LOGO_BLUE };
/** The site's login menu (unitBias "satin"): three parts satin, one part rows. */
export const LOGO_MENU: readonly UnitName[] = ['satin', 'satin', 'hatchH', 'satin'];
export const LOGO_SEED = 41;
export const LOGO_STREAK = 5;
export const LOGO_DEFAULT_COLS = 48;

export interface LogoGrid {
  cols: number; rows: number; cell: number;
  /** engine space */
  W: number; H: number;
  /** scan px per cell, and where scan (bx0, by0) lands in engine space */
  cellPx: number; ox: number; oy: number;
}

/** Lay `cols` cells over the mark's bounding box with a one-cell margin left and
    right; rows follow the aspect and the mark is centred vertically. */
export function logoGrid(cols = LOGO_DEFAULT_COLS, cell = SITE_CELL_SIZE): LogoGrid {
  const [bx0, by0, bx1, by1] = LOGO_OUTLINE.bbox;
  const bw = bx1 - bx0, bh = by1 - by0;
  const cellPx = bw / (cols - 2);
  const rows = Math.ceil(bh / cellPx) + 2;
  const W = cols * cell, H = rows * cell;
  const contentH = (bh / cellPx) * cell;
  return { cols, rows, cell, W, H, cellPx, ox: cell, oy: (H - contentH) / 2 };
}

/** The outline rings in engine space for a grid. */
export function ringsInEngine(g: LogoGrid): Vec2[][] {
  const [bx0, by0] = LOGO_OUTLINE.bbox, k = g.cell / g.cellPx;
  return LOGO_OUTLINE.rings.map((flat) => {
    const ring: Vec2[] = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([g.ox + (flat[i] - bx0) * k, g.oy + (flat[i + 1] - by0) * k]);
    return ring;
  });
}

/** Even-odd point-in-polygon across all rings (they never nest). */
export function pointInRings(p: Vec2, rings: Vec2[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * The parameter intervals of segment A→B that lie inside the rings, sorted.
 * Crossings use the half-open side rule (a vertex exactly on the line counts
 * with the positive side), so a vertex hit counts once, a touch counts twice
 * (no toggle) and a collinear edge not at all — no epsilons. Intervals are then
 * classified by their midpoint, which sidesteps every endpoint-on-edge case.
 */
export function clipToRings(A: Vec2, B: Vec2, rings: Vec2[][]): [number, number][] {
  const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy;
  if (len2 === 0) return [];
  const ts: number[] = [];
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const P = ring[j], Q = ring[i];
      const sp = dx * (P[1] - A[1]) - dy * (P[0] - A[0]);
      const sq = dx * (Q[1] - A[1]) - dy * (Q[0] - A[0]);
      if (sp > 0 === sq > 0) continue;
      const f = sp / (sp - sq);
      const X = P[0] + (Q[0] - P[0]) * f, Y = P[1] + (Q[1] - P[1]) * f;
      const t = ((X - A[0]) * dx + (Y - A[1]) * dy) / len2;
      if (t > 0 && t < 1) ts.push(t);
    }
  }
  ts.sort((a, b) => a - b);
  const cuts = [0, ...ts, 1], out: [number, number][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    if (t1 - t0 <= 0) continue;
    const tm = (t0 + t1) / 2;
    if (pointInRings([A[0] + dx * tm, A[1] + dy * tm], rings)) {
      const last = out[out.length - 1];
      if (last && last[1] === t0) last[1] = t1; else out.push([t0, t1]);   // merge touching intervals
    }
  }
  return out;
}

export interface LogoComposition { grid: LogoGrid; rings: Vec2[][]; segments: Segment[]; cellsTouched: number }

/**
 * Build the mark. `minLen` (engine units) drops slivers at the outline that
 * would read as dust; the site's satin thread is 2.7 units wide.
 */
export function buildLogoSegments(opts: { cols?: number; cell?: number; minLen?: number; color?: string } = {}): LogoComposition {
  const grid = logoGrid(opts.cols ?? LOGO_DEFAULT_COLS, opts.cell ?? SITE_CELL_SIZE);
  const rings = ringsInEngine(grid);
  const minLen = opts.minLen ?? 3, color = opts.color ?? LOGO_BLUE, cell = grid.cell;
  // quick reject: a cell must touch some ring's bounding box before we clip its threads
  const boxes = rings.map((r) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; });
  const segments: Segment[] = [];
  let cellsTouched = 0;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const cx0 = c * cell, cy0 = r * cell, cx1 = cx0 + cell, cy1 = cy0 + cell;
      // rings never nest, so only the rings whose box touches this cell can hold any of its threads
      const near = rings.filter((_, i) => { const b = boxes[i]; return cx1 >= b[0] && cx0 <= b[2] && cy1 >= b[1] && cy0 <= b[3]; });
      if (!near.length) continue;
      const unitName = pickUnit(LOGO_MENU, r, Math.floor(c / LOGO_STREAK), LOGO_SEED);
      const unit = UNITS[unitName], width = unitLegWidth(unit.legs.length, cell);
      let touched = false;
      unit.legs.forEach((leg, li) => {
        const A: Vec2 = [cx0 + leg[0][0] * cell, cy0 + leg[0][1] * cell];
        const B: Vec2 = [cx0 + leg[1][0] * cell, cy0 + leg[1][1] * cell];
        const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy);
        for (const [t0, t1] of clipToRings(A, B, near)) {
          if ((t1 - t0) * len < minLen) continue;
          segments.push({ ax: A[0] + dx * t0, ay: A[1] + dy * t0, bx: A[0] + dx * t1, by: A[1] + dy * t1, color, width, c, r, li });
          touched = true;
        }
      });
      if (touched) cellsTouched++;
    }
  }
  return { grid, rings, segments, cellsTouched };
}
