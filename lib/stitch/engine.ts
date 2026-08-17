/**
 * The embroidery engine — cloth, threads, GPU.
 *
 * A typed port of the "epoch-stitch" renderer on indus.sarvam.ai/login,
 * reverse-engineered in stitch-clone/ and verified there thread-for-thread
 * (same 24,790 threads on the same art, same texture, same cursor physics).
 * Every constant, shader line and ordering rule is theirs. What is ours:
 *   · segments carry their own cell + width, so a thread clipped to the
 *     mark's outline schedules and moves exactly like a whole-cell thread;
 *   · mountStitch() can take touch as well as the mouse.
 *
 * Shape of the thing:
 *   StitchEngine   cells → lattice NODES (one per inked cell, coupled to its 4
 *                  neighbours) → LEGS (one per thread). tick() advances the
 *                  stitch-in progress of each leg and runs one physics step: the
 *                  pointer pushes nodes radially, each leg's own offset chases
 *                  its node, and the leg's bezier control point = midpoint + 2×
 *                  offset. Endpoints never move — that is why the cloth bows.
 *   GLRenderer     one shared offscreen WebGL1 canvas; every leg is an instance
 *                  of a 25-station ribbon (TRIANGLE_STRIP, 50 verts); the vertex
 *                  shader bends the ribbon along the bezier, the fragment shader
 *                  lights it as a round thread. Blitted onto a 2D canvas.
 *   SvgRenderer    the no-WebGL fallback (5 strokes per thread).
 *   Scheduler      one requestAnimationFrame for every surface on the page,
 *                  parked when all of them are settled; frame-drop watchdog.
 *   StitchRuntime  one surface: attach/resize/visibility/pause/render.
 *   mountStitch    the vanilla entry point the React canvas uses.
 *
 * Nothing at module top level touches window/document; the singletons are lazy.
 */
import {
  THREADS, UNITS, hexToRGB, isMotifUnit, mix3, saturateColor, shade, unitDelay, unitLegWidth,
  type Material, type MotionMode, type MotionOrder, type RGB, type UnitName, type Vec2, type WaveDir,
} from './units';

/* ── types ──────────────────────────────────────────────────────────────── */

export interface CellEntry { unit: UnitName; color: string; material: string; opacity?: number; group?: string; latent?: boolean; removing?: boolean }
export interface PlacedUnit { c: number; r: number; unit: UnitName; color: string; opacity?: number }
/** A free thread in engine space. `c,r,li` place it in a cell (scheduling +
    physics node) and `width` overrides the style width — both optional; a
    segment without them behaves as in the original (cell = midpoint cell). */
export interface Segment { ax: number; ay: number; bx: number; by: number; color: string; group?: string; width?: number; c?: number; r?: number; li?: number }
export interface LatticeNode { c: number; r: number; cx: number; cy: number; ox: number; oy: number; vx: number; vy: number; nbr: LatticeNode[] }
export interface Leg {
  uid: string; key: string; c: number; r: number; layer: number; li: number; group?: string;
  node: LatticeNode | null;
  a: Vec2; b: Vec2; mid: Vec2;
  x0: number; y0: number; x1: number; y1: number; cxp: number; cyp: number;
  ox: number; oy: number; vx: number; vy: number;
  color: string; rgb: RGB; opacity: number; width: number; material: Material;
  showNeedle: boolean; motifFill: boolean; pinned: boolean;
  t0: number; t1: number; reverse: boolean; progress: number; drawn: boolean; latent?: boolean;
}
export type PhysicsMode = 'cloth' | 'jelly' | 'wind' | 'gravity' | 'magnet' | 'ripple';
export interface MotionSettings { mode: MotionMode; order: MotionOrder; waveDir: WaveDir; stagger: number; speed: number; loop: boolean }
export interface PhysicsSettings { mode: PhysicsMode; spring: number; radius: number; sway: boolean; intensity: number }
export interface TickResult { anyStitching: boolean; allDone: boolean; punches: number; motion: number }

const ctrlGain = (motifFill: boolean) => (motifFill ? 0.9 : 2);

/* ── §2 StitchEngine ────────────────────────────────────────────────────── */

export class StitchEngine {
  cols: number; rows: number; cell: number; pad: number;
  cells = new Map<string, CellEntry[]>();
  nodes = new Map<string, LatticeNode>();
  segments: Segment[] = [];
  segmentStyle: { material: string; width: number } = { material: 'cotton', width: 4 };
  legs: Leg[] = [];
  legsRev = 0;
  motion: MotionSettings = { mode: 'coordinated', order: 'ltr', waveDir: 'right', stagger: 120, speed: 520, loop: false };
  physics: PhysicsSettings = { mode: 'cloth', spring: 14, radius: 80, sway: false, intensity: 1 };
  widthScale = 1;
  inset = 0;
  sheen = true;
  edgeShade = true;
  colorBoost = 0;
  castShadow = true;
  shadowDir: Vec2 = [0.6, 0.8];
  shadowOffset = 1.15;
  shadowSpread = 1.75;
  reducedMotion = false;
  physicsEnabled = true;
  pointer = { x: -9999, y: -9999, down: false, active: false };
  ripples: { x: number; y: number; t0: number }[] = [];
  loopAt: number | null = null;
  travelQueue: { group: string; at: number; reverse: boolean; stitchMs: number }[] = [];
  physicsIdle = false;
  settled = false;
  wakeListeners = new Set<() => void>();

  constructor(cols: number, rows: number, cell: number, pad = 6) { this.cols = cols; this.rows = rows; this.cell = cell; this.pad = pad; }
  get W(): number { return this.cols * this.cell + 2 * this.pad; }
  get H(): number { return this.rows * this.cell + 2 * this.pad; }

  onWake(fn: () => void): () => void { this.wakeListeners.add(fn); return () => this.wakeListeners.delete(fn); }
  emitWake(): void { this.settled = false; for (const fn of this.wakeListeners) fn(); }
  wakePhysics(): void { this.physicsIdle = false; this.emitWake(); }
  isSettled(): boolean { return this.settled; }

  setPointer(x: number, y: number, o: { down?: boolean; active?: boolean } = {}): void {
    this.pointer.x = x; this.pointer.y = y;
    if (o.down !== undefined) this.pointer.down = o.down;
    if (o.active !== undefined) this.pointer.active = o.active;
    if (this.pointer.active && this.physicsEnabled) { this.physicsIdle = false; this.emitWake(); }
  }
  releasePointer(): void { this.pointer.down = false; }
  clearPointer(): void { this.pointer.x = -9999; this.pointer.y = -9999; this.pointer.down = false; this.pointer.active = false; }

  setGrid(cols: number, rows: number, cell = this.cell): void {
    this.cols = cols; this.rows = rows; this.cell = cell; this.segments = [];
    for (const k of [...this.cells.keys()]) { const [c, r] = k.split(',').map(Number); if (c >= cols || r >= rows) this.cells.delete(k); }
    this.nodes.clear();
    for (const k of this.cells.keys()) { const [c, r] = k.split(',').map(Number); this.ensureNode(c, r); }
    this.rebuildLegs();
  }
  clear(): void {
    this.cells.clear(); this.nodes.clear(); this.segments = []; this.legs = []; this.legsRev++;
    this.ripples = []; this.loopAt = null; this.travelQueue = []; this.emitWake();
  }
  place(c: number, r: number, unit: UnitName, color: string, material: string, group?: string): void {
    if (c < 0 || c >= this.cols || r < 0 || r >= this.rows) return;
    const key = `${c},${r}`, stack = this.cells.get(key) ?? [], entry: CellEntry = { unit, color, material, group };
    stack.push(entry); this.cells.set(key, stack);
    const node = this.ensureNode(c, r), layer = stack.length - 1;
    this.buildPlacementLegs(key, c, r, node, entry, layer, null, this.legs); this.legsRev++; this.scheduleUnit(key, layer);
  }
  /** Load a baked composition of whole-cell units. */
  loadPlaced(units: PlacedUnit[], opts: { material: string; group?: string; clear?: boolean; schedule?: boolean }): void {
    if (opts.clear !== false) { this.cells.clear(); this.nodes.clear(); this.legs = []; }
    for (const u of units) {
      const key = `${u.c},${u.r}`, stack = this.cells.get(key) ?? [];
      stack.push({ unit: u.unit, color: u.color, material: opts.material, opacity: u.opacity, group: opts.group });
      this.cells.set(key, stack);
      if (Number.isInteger(u.c) && Number.isInteger(u.r)) this.ensureNode(u.c, u.r);
    }
    this.rebuildLegs();
    if (opts.schedule !== false) this.scheduleAll();
  }
  /** Load free threads (our clipped logo threads). Call setGrid() first — it resets segments. */
  loadSegments(segs: Segment[], opts: { material: string; width: number; group?: string; clear?: boolean; schedule?: boolean }): void {
    if (opts.clear !== false) { this.cells.clear(); this.nodes.clear(); this.segments = []; }
    this.segmentStyle = { material: opts.material, width: opts.width };
    for (const s of segs) this.segments.push(opts.group ? { ...s, group: s.group ?? opts.group } : s);
    this.rebuildLegs();
    if (opts.schedule !== false) this.scheduleAll();
  }
  cellAt(x: number, y: number): [number, number] {
    return [Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.pad) / this.cell))),
            Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.pad) / this.cell)))];
  }
  matFor(name: string): Material {
    const m = THREADS[name] ?? THREADS.cotton;
    return this.sheen && this.edgeShade ? m : { ...m, ...(this.sheen ? {} : { sheen: 0, sheenW: 0 }), ...(this.edgeShade ? {} : { edge: 1 }) };
  }
  legColor(hex: string): string { return this.colorBoost > 0 ? saturateColor(hex, 1 + 2.2 * this.colorBoost, 0.3 * this.colorBoost) : hex; }

  private buildSegmentLegs(prev: Map<string, Leg> | null, out: Leg[]): void {
    if (!this.segments.length) return;
    const mat = this.matFor(this.segmentStyle.material), styleW = this.segmentStyle.width * mat.widthMul * this.widthScale;
    // legs per cell, so a clipped cell still gets the whole-cell needle rule
    const perCell = new Map<string, number>();
    for (const s of this.segments) if (s.c !== undefined && s.r !== undefined) { const k = `${s.c},${s.r}`; perCell.set(k, (perCell.get(k) ?? 0) + 1); }
    this.segments.forEach((s, i) => {
      const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
      const placed = s.c !== undefined && s.r !== undefined;
      const [c, r] = placed ? [s.c as number, s.r as number] : this.cellAt(mx, my);
      const key = `${c},${r}`, node = this.ensureNode(c, r), uid = `seg|${i}`, p = prev?.get(uid);
      const ox = p?.ox ?? node.ox, oy = p?.oy ?? node.oy;
      const color = this.legColor(s.color);
      out.push({
        uid, key, c, r,
        layer: placed ? 0 : 1e5 + i, li: s.li ?? 0, group: s.group, node,
        a: [s.ax, s.ay], b: [s.bx, s.by], mid: [mx, my],
        x0: s.ax, y0: s.ay, x1: s.bx, y1: s.by, cxp: mx + 2 * ox, cyp: my + 2 * oy,
        ox, oy, vx: p?.vx ?? node.vx, vy: p?.vy ?? node.vy,
        color, rgb: hexToRGB(color), opacity: 1,
        width: s.width !== undefined ? s.width * mat.widthMul * this.widthScale : styleW,
        material: mat, showNeedle: placed ? (perCell.get(key) ?? 0) <= 14 : false, motifFill: false, pinned: false,
        t0: p?.t0 ?? 0, t1: p?.t1 ?? 0, reverse: p?.reverse ?? false, progress: p?.progress ?? 1, drawn: p?.drawn ?? false,
      });
    });
  }
  ensureNode(c: number, r: number): LatticeNode {
    const key = `${c},${r}`, ex = this.nodes.get(key);
    if (ex) return ex;
    const n: LatticeNode = { c, r, cx: this.pad + c * this.cell + this.cell / 2, cy: this.pad + r * this.cell + this.cell / 2, ox: 0, oy: 0, vx: 0, vy: 0, nbr: [] };
    this.nodes.set(key, n);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) { const nb = this.nodes.get(`${c + dc},${r + dr}`); if (nb) { n.nbr.push(nb); nb.nbr.push(n); } }
    return n;
  }
  /** One placed unit → its legs. Widths: cell/22 × (4.4 | 3 | 2.1) by leg count. */
  private buildPlacementLegs(key: string, c: number, r: number, node: LatticeNode | null, entry: CellEntry, layer: number, prev: Map<string, Leg> | null, out: Leg[]): void {
    const unit = UNITS[entry.unit], mat = this.matFor(entry.material), color = this.legColor(entry.color);
    const n = unit.legs.length, width = unitLegWidth(n, this.cell, mat.widthMul, this.widthScale);
    const showNeedle = n <= 14, motif = isMotifUnit(entry.unit), rgb = hexToRGB(color);
    const ins = this.inset * this.cell, span = this.cell - 2 * ins;
    unit.legs.forEach((lg, li) => {
      const x0 = this.pad + c * this.cell + ins + lg[0][0] * span, y0 = this.pad + r * this.cell + ins + lg[0][1] * span;
      const x1 = this.pad + c * this.cell + ins + lg[1][0] * span, y1 = this.pad + r * this.cell + ins + lg[1][1] * span;
      const uid = `${key}|${layer}|${li}`, p = prev?.get(uid), nd = !lg.pinned && node ? node : null;
      const ox = p?.ox ?? nd?.ox ?? 0, oy = p?.oy ?? nd?.oy ?? 0, motifFill = motif && !lg.pinned, gain = ctrlGain(motifFill);
      out.push({
        uid, key, c, r, layer, li, group: entry.group, node,
        a: [x0, y0], b: [x1, y1], mid: [(x0 + x1) / 2, (y0 + y1) / 2],
        x0, y0, x1, y1, cxp: (x0 + x1) / 2 + ox * gain, cyp: (y0 + y1) / 2 + oy * gain,
        ox, oy, vx: p?.vx ?? nd?.vx ?? 0, vy: p?.vy ?? nd?.vy ?? 0,
        color, rgb, opacity: entry.opacity ?? 1, width, material: mat, showNeedle, motifFill, pinned: !!lg.pinned,
        t0: p?.t0 ?? 0, t1: p?.t1 ?? 0, reverse: p?.reverse ?? false, progress: p?.progress ?? (entry.latent ? 0 : 1), drawn: p?.drawn ?? false,
        ...(entry.latent ? { latent: true } : {}),
      });
    });
  }
  rebuildLegs(): void {
    const prev = new Map<string, Leg>(); for (const l of this.legs) prev.set(l.uid, l);
    const out: Leg[] = [];
    for (const [key, stack] of this.cells) {
      const [c, r] = key.split(',').map(Number), node = this.nodes.get(key) ?? null;
      stack.forEach((entry, layer) => this.buildPlacementLegs(key, c, r, node, entry, layer, prev, out));
    }
    this.buildSegmentLegs(prev, out);
    this.legs = out; this.legsRev++; this.emitWake();
  }
  revealAll(): void { for (const l of this.legs) if (!l.latent) { l.progress = 1; l.drawn = true; l.t0 = 0; l.t1 = 0; } this.emitWake(); }
  scheduleAll(now = performance.now(), opts?: { seed?: number; reverse?: boolean }): void { this.scheduleLegs(this.legs.filter((l) => !l.latent), now, opts); }
  scheduleGroup(group: string, now = performance.now(), opts?: { seed?: number; reverse?: boolean }): void { this.scheduleLegs(this.legs.filter((l) => l.group === group), now, opts); }
  scheduleLegs(legs: Leg[], now: number, opts?: { seed?: number; reverse?: boolean }): void {
    if (!legs.length) return;
    const byCell = new Map<string, Leg[]>();
    for (const l of legs) { const k = `${l.key}|${l.layer}`; const a = byCell.get(k) ?? []; a.push(l); byCell.set(k, a); }
    const o = { mode: this.motion.mode, stagger: this.motion.stagger, cols: this.cols, rows: this.rows, seed: opts?.seed ?? 7, order: this.motion.order, waveDir: this.motion.waveDir };
    for (const group of byCell.values()) {
      const f = group[0], delay = unitDelay({ r: f.r, c: f.c }, o);
      const rev = opts?.reverse ?? ((this.motion.mode === 'uncoordinated' || this.motion.mode === 'random') && Math.random() < 0.5);
      this.applyStitch(group, now, delay, rev);
    }
    this.loopAt = null; this.emitWake();
  }
  scheduleUnit(key: string, layer: number, now = performance.now()): void {
    const legs = this.legs.filter((l) => l.key === key && l.layer === layer);
    if (!legs.length) return;
    this.applyStitch(legs, now, 0, this.motion.mode === 'uncoordinated' && Math.random() < 0.5); this.emitWake();
  }
  /** One unit's legs get [t0,t1] windows: each lasts speed/legCount ms, starting 75 % overlapped. */
  applyStitch(legs: Leg[], now: number, delay: number, reverse: boolean): void {
    if (this.reducedMotion) { for (const l of legs) { l.t0 = 0; l.t1 = 0; l.progress = 1; l.drawn = true; l.reverse = false; } return; }
    const per = this.motion.speed / Math.max(1, legs.length);
    legs.forEach((l, i) => {
      l.t0 = now + delay + i * per * 0.75; l.t1 = l.t0 + per; l.reverse = reverse;
      if (reverse) { l.progress = 1; l.drawn = true; } else { l.progress = 0; l.drawn = false; l.ox = l.oy = l.vx = l.vy = 0; }
    });
  }
  /** After a pause (hidden tab), slide every pending window forward so nothing pops. */
  shiftTimeline(ms: number): void {
    if (ms <= 0) return;
    for (const l of this.legs) if (!(l.t1 <= l.t0) && (l.reverse ? l.progress > 0 : !l.drawn)) { l.t0 += ms; l.t1 += ms; }
    if (this.loopAt != null) this.loopAt += ms;
    for (const t of this.travelQueue) t.at += ms;
  }
  addRipple(x: number, y: number): void { if (this.physicsEnabled) { this.ripples.push({ x, y, t0: performance.now() }); this.physicsIdle = false; this.emitWake(); } }

  /**
   * One physics step per frame. Cloth: nodes are pushed radially inside
   * `radius` (quadratic falloff), coupled to their 4 neighbours, spring-
   * returned and damped; each leg's offset chases its node's (0.5 gain, 0.8
   * damping) with its own direct push; control point = mid + 2×offset.
   */
  physicsStep(): number {
    if (!this.physicsEnabled) { this.physicsIdle = true; return 0; }
    const mode = this.physics.mode, ambient = mode === 'wind' || this.physics.sway, poked = this.pointer.active || this.ripples.length > 0;
    if (this.physicsIdle && !poked && !ambient) return 0;
    let damp = 0.86, couple = 0.14, spring = this.physics.spring / 1e3, gravity = 0, magnet = false, wind = 0;
    if (mode === 'jelly') { damp = 0.94; couple = 0.34; spring *= 0.5; }
    else if (mode === 'wind') { damp = 0.88; couple = 0.2; wind = 1; }
    else if (mode === 'gravity') { damp = 0.9; couple = 0.16; gravity = 0.55; }
    else if (mode === 'magnet') magnet = true;
    else if (mode === 'ripple') { damp = 0.9; couple = 0.22; }
    const radius = this.physics.radius, inten = this.physics.intensity ?? 1;
    const push = (this.pointer.down ? 1.9 : 0.55) * inten;
    const nodeMax = 0.5 * this.cell * inten, legMax = 0.32 * this.cell * inten;
    const now = performance.now();
    let motion = 0;
    for (let i = this.ripples.length - 1; i >= 0; i--) if (now - this.ripples[i].t0 > 1400) this.ripples.splice(i, 1);
    for (const n of this.nodes.values()) {
      let fx = 0, fy = 0;
      if (this.pointer.active) {
        const dx = n.cx + n.ox - this.pointer.x, dy = n.cy + n.oy - this.pointer.y, d2 = dx * dx + dy * dy;
        if (d2 < radius * radius) {
          const d = Math.sqrt(d2) || 1, l = 1 - d / radius, a = l * l * radius * 0.9 * push * (magnet ? -1 : 1);
          fx += (dx / d) * a; fy += (dy / d) * a;
        }
      }
      if (mode === 'ripple') for (const rp of this.ripples) {
        const age = (now - rp.t0) / 1400, ring = age * radius * 2.2, dx = n.cx + n.ox - rp.x, dy = n.cy + n.oy - rp.y, d = Math.hypot(dx, dy) || 1;
        const band = Math.exp(-(((d - ring) / (1.2 * this.cell)) ** 2)), amp = (1 - age) * radius * 0.9;
        fx += (dx / d) * band * amp; fy += (dy / d) * band * amp;
      }
      if (wind > 0) { const ph = 0.004 * now - 0.03 * n.cx - 0.01 * n.cy; fx += (0.6 * Math.sin(ph) + 0.5) * wind * 2.4; fy += Math.sin(1.7 * ph) * wind * 0.9; }
      if (gravity > 0) fy += 3 * gravity;
      if (this.physics.sway) { fx += 0.25 * Math.sin(0.001 * now + 0.05 * n.cy); fy += 0.25 * Math.cos(0.0013 * now + 0.05 * n.cx); }
      if (n.nbr.length > 0) {
        let ax = 0, ay = 0; for (const b of n.nbr) { ax += b.ox; ay += b.oy; }
        ax /= n.nbr.length; ay /= n.nbr.length; fx += (ax - n.ox) * couple * 40; fy += (ay - n.oy) * couple * 40;
      }
      n.vx = (n.vx + 0.02 * fx - n.ox * spring) * damp;
      n.vy = (n.vy + 0.02 * fy - n.oy * spring) * damp;
      n.ox += n.vx; n.oy += n.vy;
      const d = Math.hypot(n.ox, n.oy);
      if (d > nodeMax) { const k = nodeMax / d; n.ox *= k; n.oy *= k; n.vx *= 0.5; n.vy *= 0.5; }
      motion += Math.abs(n.vx) + Math.abs(n.vy);
    }
    for (const l of this.legs) {
      if (l.progress <= 0) continue;
      if (l.drawn && !l.pinned) {
        const n = l.node, tx = n ? n.ox : 0, ty = n ? n.oy : 0;
        l.vx = (l.vx + (tx - l.ox) * 0.5) * 0.8;
        l.vy = (l.vy + (ty - l.oy) * 0.5) * 0.8;
        if (this.pointer.active) {
          const mx = l.mid[0] + l.ox, my = l.mid[1] + l.oy, dx = mx - this.pointer.x, dy = my - this.pointer.y, d2 = dx * dx + dy * dy;
          if (d2 < radius * radius) {
            const d = Math.sqrt(d2) || 1, f = 1 - d / radius, s = magnet ? -1 : 1, a = f * f * push * (l.motifFill ? 0.35 : 0.9) * s;
            l.vx += (dx / d) * a; l.vy += (dy / d) * a;
          }
        }
        l.ox += l.vx; l.oy += l.vy;
        const cap = l.motifFill ? 0.4 * legMax : legMax, d = Math.hypot(l.ox, l.oy);
        if (d > cap) { const k = cap / d; l.ox *= k; l.oy *= k; }
        motion += Math.abs(l.vx) + Math.abs(l.vy);
      }
      const gain = ctrlGain(l.motifFill);
      l.x0 = l.a[0]; l.y0 = l.a[1]; l.x1 = l.b[0]; l.y1 = l.b[1];
      l.cxp = l.mid[0] + l.ox * gain; l.cyp = l.mid[1] + l.oy * gain;
    }
    const thresh = 0.05 + (this.nodes.size + this.legs.length) * 4e-4;
    this.physicsIdle = !poked && !ambient && motion < thresh;
    return motion;
  }

  /** Advance stitch progress and physics to time `now`. */
  tick(now = performance.now()): TickResult {
    if (this.travelQueue.length) {
      const keep: typeof this.travelQueue = [];
      for (const t of this.travelQueue) {
        if (now < t.at) { keep.push(t); continue; }
        const legs = this.legs.filter((l) => l.latent && l.group === t.group), sp = this.motion.speed;
        this.motion.speed = t.stitchMs; this.applyStitch(legs, now, 0, t.reverse); this.motion.speed = sp;
      }
      this.travelQueue = keep;
    }
    const motion = this.physicsStep();
    let allDone = true, anyStitching = false, punches = 0;
    for (const l of this.legs) {
      if (l.t1 <= l.t0) { if (!l.latent) { l.progress = 1; l.drawn = true; } continue; }
      let p = (now - l.t0) / (l.t1 - l.t0); p = Math.max(0, Math.min(1, p));
      l.progress = l.reverse ? 1 - p : p;
      if (p >= 1 && !l.drawn) { l.drawn = true; punches++; }
      if (p < 1 && now >= l.t0) { anyStitching = true; allDone = false; } else if (now < l.t0) allDone = false;
    }
    if (this.travelQueue.length) allDone = false;
    const loop = this.motion.loop && !this.reducedMotion;
    if (loop && allDone && this.legs.length) { if (this.loopAt == null) this.loopAt = now + 600; else if (now >= this.loopAt) { this.scheduleAll(now); allDone = false; } }
    else if (!loop) this.loopAt = null;
    this.settled = allDone && !anyStitching && this.physicsIdle && !loop;
    return { anyStitching, allDone, punches, motion };
  }
  dispose(): void { this.wakeListeners.clear(); }
}

/* ── §3 stitch mode: full (WebGL + motion) or static ────────────────────── */

const SOFT_GPU = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const MODE_KEY = 'buildobjects:stitch-mode';
const DEMOTE_KEY = 'buildobjects:stitch-demoted';
export type StitchMode = 'full' | 'static';
let modeCache: StitchMode | null = null;
let modeSource: 'auto' | 'param' | 'storage' | 'demoted' = 'auto';
const modeListeners = new Set<(m: StitchMode) => void>();

export function getStitchMode(): StitchMode {
  if (modeCache) return modeCache;
  if (typeof window === 'undefined') return 'static';
  const q = new URLSearchParams(window.location.search).get('stitch');
  if (q === 'full' || q === 'static') { modeSource = 'param'; return (modeCache = q); }
  try { const s = localStorage.getItem(MODE_KEY); if (s === 'full' || s === 'static') { modeCache = s; modeSource = 'storage'; return s; } } catch { /* private mode */ }
  try { const t = Number(localStorage.getItem(DEMOTE_KEY)); if (t && Date.now() - t < 6048e5) { modeCache = 'static'; modeSource = 'demoted'; return modeCache; } } catch { /* private mode */ }
  modeCache = ((): StitchMode => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return 'static';
    const nav = navigator as Navigator & { deviceMemory?: number };
    if ((nav.hardwareConcurrency && nav.hardwareConcurrency < 3) || (nav.deviceMemory && nav.deviceMemory < 3)) return 'static';
    let gl: WebGLRenderingContext | null = null;
    try {
      const c = document.createElement('canvas'); c.width = 1; c.height = 1;
      gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: true }) ?? c.getContext('webgl');
      if (!gl) return 'static';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) { const r = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? ''); if (SOFT_GPU.test(r)) return 'static'; }
      return 'full';
    } catch { return 'static'; } finally { gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
  })();
  modeSource = 'auto';
  return modeCache;
}
export const isFullMotion = (): boolean => getStitchMode() === 'full';
/** Force a mode for this device ('auto' clears). Exposed as window.__stitchMode. */
export function setStitchMode(m: 'auto' | StitchMode): StitchMode {
  try { if (m === 'auto') localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, m); localStorage.removeItem(DEMOTE_KEY); } catch { /* private mode */ }
  modeCache = null; return getStitchMode();
}
// Frame-drop watchdog: after 20 warm-up frames, 30 of the last 60 over 40 ms ⇒ static for 7 days.
let warmup = 20; const frameHist: number[] = []; let slowCount = 0;
function watchFrame(dt: number): void {
  if (dt <= 0 || dt > 240 || getStitchMode() !== 'full' || modeSource !== 'auto') return;
  if (warmup > 0) { warmup--; return; }
  frameHist.push(dt); if (dt > 40) slowCount++;
  if (frameHist.length > 60 && (frameHist.shift() as number) > 40) slowCount--;
  if (frameHist.length === 60 && slowCount >= 30 && getStitchMode() !== 'static') {
    try { localStorage.setItem(DEMOTE_KEY, String(Date.now())); } catch { /* private mode */ }
    modeCache = 'static'; modeSource = 'demoted';
    document.documentElement.dataset.stitchMode = 'static';
    console.info('[stitch] sustained frame drops; motion demoted to static for this device (undo: __stitchMode("auto"))');
    for (const fn of modeListeners) fn('static');
  }
}

/* ── §4 GLRenderer — shared offscreen WebGL1, instanced bezier ribbons ──── */

export const VERT_SRC = `
precision highp float;
attribute float aSeg;
attribute float aSide;
attribute vec2 aP0;
attribute vec2 aP1;
attribute vec2 aCtrl;
attribute vec3 aColor;
attribute float aWidth;
attribute float aProgress;
attribute float aReverse;
attribute vec4 aMat;       // sheen, sheenW, ply, plyFreq
attribute vec4 aMat2;      // edge, tintR, tintG, tintB
uniform vec2 uRes;
uniform float uShadow;      // 0 = thread pass, 1 = cast-shadow pass
uniform vec2 uShadowDir;    // normalized light-relative offset direction
uniform float uShadowOffset; // offset distance, in units of aWidth
uniform float uShadowSpread; // half-width multiplier for the shadow silhouette
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vLen;
varying vec4 vMat;
varying vec4 vMat2;
varying float vShadow;
vec2 qbez(float t, vec2 p0, vec2 c, vec2 p1){
  float u=1.0-t; return u*u*p0 + 2.0*u*t*c + t*t*p1;
}
void main(){
  float prog = clamp(aProgress,0.0,1.0);
  float t = aSeg * prog;
  float tt = (aReverse>0.5) ? (1.0 - aSeg*prog) : t;
  vec2 p0=aP0, p1=aP1, c=aCtrl;
  vec2 pos = qbez(tt, p0,c,p1);
  float dt=0.01;
  vec2 pa = qbez(clamp(tt-dt,0.0,1.0), p0,c,p1);
  vec2 pb = qbez(clamp(tt+dt,0.0,1.0), p0,c,p1);
  vec2 dir = normalize(pb-pa + vec2(0.0001,0.0));
  vec2 nrm = vec2(-dir.y, dir.x);
  float taper = smoothstep(0.0,0.10,aSeg) * (1.0 - smoothstep(0.90,1.0,aSeg));
  float halfW = (aWidth*0.5) * mix(0.72,1.0,taper);
  bool shadow = uShadow > 0.5;
  if(shadow) halfW *= uShadowSpread;
  pos += nrm * aSide * halfW;
  if(shadow) pos += uShadowDir * aWidth * uShadowOffset;
  vec2 clip = (pos/uRes)*2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip,0.0,1.0);
  vColor=aColor; vSide=aSide;
  vAlong = aSeg;
  vLen = length(p1-p0);
  vMat = aMat; vMat2 = aMat2;
  vShadow = uShadow;
}`;

export const FRAG_SRC = `
precision highp float;
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vLen;
varying vec4 vMat;
varying vec4 vMat2;
varying float vShadow;
void main(){
  float s=abs(vSide);
  if(vShadow > 0.5){
    float core = (1.0 - smoothstep(0.0, 0.55, s)) * 0.5;
    float penumbra = (1.0 - smoothstep(0.15, 1.0, s)) * 0.4;
    float shAlpha = max(core, penumbra);
    gl_FragColor = vec4(0.07, 0.045, 0.03, shAlpha);
    return;
  }
  float sheenAmt = vMat.x, sheenW = vMat.y, plyAmt = vMat.z, plyFreq = vMat.w;
  float edgeDark = vMat2.x;
  vec3  tint = vMat2.yzw;
  float lift = sqrt(max(0.0,1.0 - s*s));
  vec3 edge  = vColor*edgeDark;
  vec3 body  = vColor;
  float liftAmt = sheenAmt * 0.34;
  vec3 pale = vColor + (vec3(1.0) - vColor) * liftAmt;
  vec3 sheenCol = mix(min(vec3(1.0), vColor * (1.0 + sheenAmt * 0.65)), pale, 0.4);
  if(dot(tint,tint) > 0.001) sheenCol *= mix(vec3(1.0), tint, 0.4);
  vec3 col = mix(edge, body, smoothstep(0.0,0.55,lift));
  float sheenBand = sheenW * 0.7;
  col = mix(col, sheenCol, smoothstep(1.0-sheenBand, 1.0, lift));
  float twists = max(3.0, vLen*plyFreq);
  float ply = sin((vAlong*twists + vSide*0.9) * 6.2831853);
  col *= 1.0 + ply*0.12*plyAmt;
  float fibre = sin(vAlong*twists*6.0 + vSide*8.0);
  col += fibre * 0.02 * plyAmt * vColor;
  float occAmt = edgeDark > 0.995 ? 0.0 : 0.25;
  col *= 1.0 - smoothstep(0.78,1.0,s)*occAmt;
  float alpha = 1.0 - smoothstep(0.90,1.0,s);
  gl_FragColor = vec4(clamp(col,0.0,1.0), alpha);
}`;

interface GLClient { staticBuf: WebGLBuffer; dynBuf: WebGLBuffer; staticCap: number; dynCap: number; rev: string; count: number; dynData: Float32Array }
interface GLLocs { aSeg: number; aSide: number; aP0: number; aP1: number; aCtrl: number; aColor: number; aWidth: number; aProgress: number; aReverse: number; aMat: number; aMat2: number; uRes: WebGLUniformLocation | null; uShadow: WebGLUniformLocation | null; uShadowDir: WebGLUniformLocation | null; uShadowOffset: WebGLUniformLocation | null; uShadowSpread: WebGLUniformLocation | null }

export class GLRenderer {
  failed = false;
  onRestored: (() => void) | null = null;
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext | null = null;
  ext: ANGLE_instanced_arrays | null = null;
  prog: WebGLProgram | null = null;
  loc: GLLocs | null = null;
  geoBuf: WebGLBuffer | null = null;
  clients = new Map<string, GLClient>();
  ready = false;
  constructor() {
    this.canvas = document.createElement('canvas'); this.canvas.width = 1; this.canvas.height = 1;
    const gl = this.canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false, alpha: true, powerPreference: 'low-power' });
    if (!gl) { this.failed = true; return; }
    this.gl = gl; this.ext = gl.getExtension('ANGLE_instanced_arrays');
    if (!this.ext) { this.failed = true; return; }
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ready = false; });
    this.canvas.addEventListener('webglcontextrestored', () => { this.clients.clear(); this.build(); this.onRestored?.(); });
    this.build();
  }
  private compile(type: number, src: string): WebGLShader | null {
    const gl = this.gl as WebGLRenderingContext, sh = gl.createShader(type); if (!sh) return null;
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return sh;
    console.warn(gl.getShaderInfoLog(sh)); gl.deleteShader(sh); return null;
  }
  private build(): void {
    const gl = this.gl; if (!gl) return;
    const vs = this.compile(gl.VERTEX_SHADER, VERT_SRC), fs = this.compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) { this.failed = true; return; }
    const p = gl.createProgram(); if (!p) { this.failed = true; return; }
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(p)); this.failed = true; return; }
    gl.useProgram(p); this.prog = p;
    // ribbon template: 25 stations along the thread × 2 sides = 50 verts
    const geo: number[] = []; for (let i = 0; i <= 24; i++) { const t = i / 24; geo.push(t, -1, t, 1); }
    this.geoBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo), gl.STATIC_DRAW);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const A = (n: string) => gl.getAttribLocation(p, n), U = (n: string) => gl.getUniformLocation(p, n);
    this.loc = { aSeg: A('aSeg'), aSide: A('aSide'), aP0: A('aP0'), aP1: A('aP1'), aCtrl: A('aCtrl'), aColor: A('aColor'), aWidth: A('aWidth'),
      aProgress: A('aProgress'), aReverse: A('aReverse'), aMat: A('aMat'), aMat2: A('aMat2'),
      uRes: U('uRes'), uShadow: U('uShadow'), uShadowDir: U('uShadowDir'), uShadowOffset: U('uShadowOffset'), uShadowSpread: U('uShadowSpread') };
    this.ready = true;
  }
  private ensureSize(w: number, h: number): void { if (this.canvas.width < w) this.canvas.width = w; if (this.canvas.height < h) this.canvas.height = h; }
  /** Per-surface buffers. The static half (16 floats/leg) is rebuilt only when the leg list changes. */
  private clientFor(id: string, count: number, rev: string, legs: Leg[]): GLClient | null {
    const gl = this.gl as WebGLRenderingContext; let c = this.clients.get(id);
    if (!c) {
      const s = gl.createBuffer(), d = gl.createBuffer(); if (!s || !d) return null;
      c = { staticBuf: s, dynBuf: d, staticCap: 0, dynCap: 0, rev: '', count: 0, dynData: new Float32Array(0) }; this.clients.set(id, c);
    }
    if (c.rev !== rev || c.count !== count) {
      const arr = new Float32Array(16 * count); let k = 0;
      for (const l of legs) {
        const m = l.material, tint = m.tint ?? [0, 0, 0], fade = 0.28 * (l.opacity < 1 ? 1 - 0.9 * l.opacity : 0);
        arr[k++] = l.a[0]; arr[k++] = l.a[1]; arr[k++] = l.b[0]; arr[k++] = l.b[1];
        arr[k++] = l.rgb[0] + (1 - l.rgb[0]) * fade; arr[k++] = l.rgb[1] + (1 - l.rgb[1]) * fade; arr[k++] = l.rgb[2] + (1 - l.rgb[2]) * fade;
        arr[k++] = l.width; arr[k++] = m.sheen; arr[k++] = m.sheenW; arr[k++] = m.ply; arr[k++] = m.plyFreq;
        arr[k++] = m.edge; arr[k++] = tint[0]; arr[k++] = tint[1]; arr[k++] = tint[2];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, c.staticBuf); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      c.staticCap = arr.length; c.rev = rev; c.count = count;
      if (c.dynData.length < 4 * count) c.dynData = new Float32Array(4 * count);
    }
    return c;
  }
  /** Draw `legs` (engine space W×H stretched over dw×dh device px), then blit onto destCtx. */
  render(id: string, legs: Leg[], rev: string, W: number, H: number, destCtx: CanvasRenderingContext2D, dw: number, dh: number,
         castShadow = true, shadowDir: Vec2 = [0.6, 0.8], shadowOffset = 1.15, shadowSpread = 1.75): void {
    const gl = this.gl, ext = this.ext, L = this.loc;
    if (!gl || !ext || !L || !this.ready || dw < 1 || dh < 1) return;
    this.ensureSize(dw, dh);
    const y0 = this.canvas.height - dh;
    gl.viewport(0, y0, dw, dh); gl.enable(gl.SCISSOR_TEST); gl.scissor(0, y0, dw, dh); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    const n = legs.length;
    if (n > 0) {
      const c = this.clientFor(id, n, rev, legs);
      if (!c) { gl.disable(gl.SCISSOR_TEST); return; }
      const dyn = c.dynData; let k = 0;
      for (const l of legs) { dyn[k++] = l.cxp; dyn[k++] = l.cyp; dyn[k++] = l.progress; dyn[k++] = l.reverse ? 1 : 0; }
      gl.useProgram(this.prog); gl.uniform2f(L.uRes, W, H); gl.bindBuffer(gl.ARRAY_BUFFER, this.geoBuf);
      const per = (loc: number, off: number) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 8, off); ext.vertexAttribDivisorANGLE(loc, 0); };
      per(L.aSeg, 0); per(L.aSide, 4);
      const inst = (loc: number, size: number, stride: number, off: number) => { if (loc < 0) return; gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off); ext.vertexAttribDivisorANGLE(loc, 1); };
      gl.bindBuffer(gl.ARRAY_BUFFER, c.staticBuf);
      inst(L.aP0, 2, 64, 0); inst(L.aP1, 2, 64, 8); inst(L.aColor, 3, 64, 16); inst(L.aWidth, 1, 64, 28); inst(L.aMat, 4, 64, 32); inst(L.aMat2, 4, 64, 48);
      gl.bindBuffer(gl.ARRAY_BUFFER, c.dynBuf);
      const need = 4 * n;
      if (c.dynCap < need) { gl.bufferData(gl.ARRAY_BUFFER, dyn.subarray(0, need), gl.DYNAMIC_DRAW); c.dynCap = need; } else gl.bufferSubData(gl.ARRAY_BUFFER, 0, dyn.subarray(0, need));
      inst(L.aCtrl, 2, 16, 0); inst(L.aProgress, 1, 16, 8); inst(L.aReverse, 1, 16, 12);
      if (castShadow) {
        gl.uniform2f(L.uShadowDir, shadowDir[0], shadowDir[1]); gl.uniform1f(L.uShadowOffset, shadowOffset); gl.uniform1f(L.uShadowSpread, shadowSpread);
        gl.uniform1f(L.uShadow, 1); ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 50, n);
      }
      gl.uniform1f(L.uShadow, 0); ext.drawArraysInstancedANGLE(gl.TRIANGLE_STRIP, 0, 50, n);
    }
    gl.disable(gl.SCISSOR_TEST);
    destCtx.clearRect(0, 0, dw, dh); destCtx.drawImage(this.canvas, 0, 0, dw, dh, 0, 0, dw, dh);
  }
  releaseClient(id: string): void {
    const c = this.clients.get(id); if (!c) return; this.clients.delete(id);
    const gl = this.gl; if (gl && !gl.isContextLost()) { gl.deleteBuffer(c.staticBuf); gl.deleteBuffer(c.dynBuf); }
  }
}
let sharedGL: GLRenderer | null = null, triedGL = false;
export function getSharedGL(): GLRenderer | null { if (!triedGL) { triedGL = true; const r = new GLRenderer(); sharedGL = r.failed ? null : r; } return sharedGL; }

/* ── §5 SvgRenderer — no-WebGL fallback ─────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
type SvgCache = { x0: number; y0: number; x1: number; y1: number; cxp: number; cyp: number; progress: number; reverse: boolean; color: string; width: number; opacity: number };
export class SvgRenderer {
  svg: SVGSVGElement; group: SVGGElement; cache: (SvgCache | undefined)[] = []; nodeCount = 0;
  constructor(svg: SVGSVGElement) {
    this.svg = svg;
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML = `<filter id="st-soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0.6" dy="1.2" stdDeviation="0.8" flood-color="rgba(40,25,10,.45)"/></filter>`;
    svg.appendChild(defs); this.group = document.createElementNS(SVG_NS, 'g'); svg.appendChild(this.group);
  }
  render(legs: Leg[]): void {
    const g = this.group;
    while (g.childNodes.length < legs.length) {
      const el = document.createElementNS(SVG_NS, 'g');
      for (let i = 0; i < 6; i++) { const p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-linecap', 'round'); el.appendChild(p); }
      const c = document.createElementNS(SVG_NS, 'circle'); c.setAttribute('r', '3.2'); el.appendChild(c); g.appendChild(el);
    }
    while (g.childNodes.length > legs.length) g.removeChild(g.lastChild as ChildNode);
    if (this.cache.length !== legs.length) this.cache.length = legs.length;
    legs.forEach((l, i) => {
      const c = this.cache[i];
      if (c && c.x0 === l.x0 && c.y0 === l.y0 && c.x1 === l.x1 && c.y1 === l.y1 && c.cxp === l.cxp && c.cyp === l.cyp && c.progress === l.progress && c.reverse === l.reverse && c.color === l.color && c.width === l.width && c.opacity === l.opacity) return;
      this.cache[i] = { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, cxp: l.cxp, cyp: l.cyp, progress: l.progress, reverse: l.reverse, color: l.color, width: l.width, opacity: l.opacity };
      const d = `M${l.x0} ${l.y0} Q${l.cxp} ${l.cyp} ${l.x1} ${l.y1}`, el = g.childNodes[i] as SVGGElement, len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0), dash = 1.4 * len + 2, m = l.material;
      let hi = shade(l.color, 0.34 * m.sheen); if (m.tint) hi = mix3(hi, m.tint);
      const strokes = [
        { w: 1.3 * l.width, col: 'rgba(40,25,10,0.30)', soft: true },
        { w: 1.06 * l.width, col: shade(l.color, m.edge - 1) },
        { w: l.width, col: l.color },
        { w: 0.6 * l.width, col: shade(l.color, 0.18 * m.sheen) },
        { w: l.width * (0.2 + 0.35 * m.sheenW), col: hi },
      ];
      if (el.dataset.op !== String(l.opacity)) { el.dataset.op = String(l.opacity); el.setAttribute('opacity', String(l.opacity)); }
      for (let k = 0; k < 5; k++) {
        const p = el.childNodes[k] as SVGPathElement, s = strokes[k];
        p.setAttribute('d', d); p.setAttribute('stroke', s.col); p.setAttribute('stroke-width', String(s.w));
        if (s.soft) p.setAttribute('filter', 'url(#st-soft)'); else p.removeAttribute('filter');
        p.setAttribute('stroke-dasharray', String(dash));
        p.setAttribute('stroke-dashoffset', String(l.reverse ? -dash * (1 - l.progress) : dash * (1 - l.progress)));
      }
      const ply = el.childNodes[5] as SVGPathElement;
      if (l.progress >= 1 && l.width > 2.6 && m.ply > 0.15) {
        const tw = Math.max(3, len * m.plyFreq), seg = len / tw;
        ply.setAttribute('d', d); ply.setAttribute('stroke', shade(l.color, 0.55)); ply.setAttribute('stroke-width', String(0.5 * l.width));
        ply.setAttribute('stroke-linecap', 'butt'); ply.setAttribute('stroke-dasharray', `${(0.5 * seg).toFixed(2)} ${(0.5 * seg).toFixed(2)}`); ply.style.opacity = (0.3 * m.ply).toFixed(2);
      } else ply.style.opacity = '0';
      const needle = el.childNodes[6] as SVGCircleElement;
      if (l.showNeedle && l.progress > 0 && l.progress < 1) {
        const t = l.reverse ? 1 - l.progress : l.progress, u = 1 - t;
        needle.setAttribute('cx', String(u * u * l.x0 + 2 * u * t * l.cxp + t * t * l.x1));
        needle.setAttribute('cy', String(u * u * l.y0 + 2 * u * t * l.cyp + t * t * l.y1));
        needle.setAttribute('fill', '#e8e8ee'); needle.setAttribute('stroke', '#888'); needle.setAttribute('stroke-width', '0.5'); needle.style.opacity = '1';
      } else needle.style.opacity = '0';
    });
    this.nodeCount = 7 * g.childNodes.length;
  }
  dispose(): void { this.svg.replaceChildren(); this.cache = []; }
}

/* ── §6 Scheduler (one rAF for every surface) + StitchRuntime (one surface) ─ */

class Scheduler {
  runtimes = new Set<StitchRuntime>(); byEl = new Map<Element, StitchRuntime>(); io: IntersectionObserver | null = null;
  raf = 0; running = false; lastFrameAt: number | null = null;
  register(rt: StitchRuntime, el: Element): void {
    this.runtimes.add(rt); this.byEl.set(el, rt);
    if (!this.io && typeof IntersectionObserver !== 'undefined')
      this.io = new IntersectionObserver((entries) => { for (const e of entries) this.byEl.get(e.target)?.setVisible(e.isIntersecting); }, { rootMargin: '120px' });
    this.io?.observe(el); this.requestFrame();
  }
  unregister(rt: StitchRuntime, el: Element): void { this.runtimes.delete(rt); this.byEl.delete(el); this.io?.unobserve(el); }
  requestFrame(): void { if (!this.running) { this.running = true; this.raf = requestAnimationFrame(this.frame); } }
  wakeAll(): void { for (const r of this.runtimes) r.wake(); }
  frame = (now: number): void => {
    if (this.lastFrameAt != null) watchFrame(now - this.lastFrameAt);
    let any = false;
    for (const r of this.runtimes) if (r.step(now)) any = true;
    if (any) { this.lastFrameAt = now; this.raf = requestAnimationFrame(this.frame); } else { this.lastFrameAt = null; this.running = false; }
  };
  applyStaticMode(): void { for (const r of this.runtimes) r.applyStaticMode(); }
  debug() { return { mode: getStitchMode(), source: modeSource, surfaces: [...this.runtimes].map((r) => ({ id: r.id, state: r.state, threads: r.engines.reduce((a, e) => a + e.legs.length, 0) })) }; }
}
let scheduler: Scheduler | null = null;
declare global { interface Window { __stitchDebug?: () => unknown; __stitchMode?: (m: 'auto' | StitchMode) => StitchMode } }
export function getScheduler(): Scheduler {
  if (!scheduler) {
    scheduler = new Scheduler();
    const gl = getSharedGL();
    if (gl) gl.onRestored = () => scheduler?.wakeAll();
    modeListeners.add((m) => { if (m === 'static') scheduler?.applyStaticMode(); });
    window.__stitchDebug = () => scheduler?.debug();
    window.__stitchMode = (m) => setStitchMode(m);
  }
  return scheduler;
}

export type RuntimeState = 'idle' | 'active' | 'offscreen';
export interface RuntimeOpts {
  renderer: 'webgl' | 'svg'; layerClass?: string; resolutionScale?: number;
  onFallback?: () => void; onTick?: (ticks: TickResult[], rt: StitchRuntime) => void; onState?: (s: RuntimeState) => void;
  onHud?: (h: { fps: number; renderMs: number; threads: number }) => void;
}
let runtimeSeq = 1;
export class StitchRuntime {
  id = `stitch-${runtimeSeq++}`;
  engines: StitchEngine[]; primary: StitchEngine; activeRenderer: 'webgl' | 'svg'; state: RuntimeState = 'idle'; opts: RuntimeOpts;
  host: HTMLElement | null = null; gl: GLRenderer | null = null; destCtx: CanvasRenderingContext2D | null = null; destCanvas: HTMLCanvasElement | null = null;
  svg: SvgRenderer | null = null; svgViewBox = ''; ro: ResizeObserver | null = null; unsubs = new Map<StitchEngine, () => void>();
  dw = 0; dh = 0; visible = true; wantFrame = true; pendingResize = false; lastNow: number | null = null; pausedAt: number | null = null;
  fpsAcc = 0; fpsCnt = 0; renderMs = 0; hudAt = 0;
  constructor(engines: StitchEngine | StitchEngine[], opts: RuntimeOpts) { this.engines = Array.isArray(engines) ? [...engines] : [engines]; this.primary = this.engines[this.engines.length - 1]; this.opts = opts; this.activeRenderer = opts.renderer; }
  attach(host: HTMLElement): void {
    this.host = host;
    if (this.opts.renderer === 'webgl') {
      const gl = getSharedGL();
      if (gl) {
        this.gl = gl;
        const c = document.createElement('canvas');
        if (this.opts.layerClass) c.setAttribute('class', this.opts.layerClass);
        host.appendChild(c); this.destCanvas = c; this.destCtx = c.getContext('2d'); this.activeRenderer = 'webgl';
      } else { this.mountSvg(host); this.opts.onFallback?.(); }
    } else this.mountSvg(host);
    if (!isFullMotion()) for (const e of this.engines) { e.reducedMotion = true; e.physicsEnabled = false; e.physics.sway = false; }
    for (const e of this.engines) this.subscribe(e);
    this.ro = new ResizeObserver(() => this.sizeDest()); this.ro.observe(host);
    this.sizeDest(); getScheduler().register(this, host); this.wake();
  }
  private mountSvg(host: HTMLElement): void {
    const s = document.createElementNS(SVG_NS, 'svg'); s.setAttribute('preserveAspectRatio', 'none');
    if (this.opts.layerClass) s.setAttribute('class', this.opts.layerClass);
    host.appendChild(s); this.svg = new SvgRenderer(s); this.activeRenderer = 'svg';
  }
  private subscribe(e: StitchEngine): void { if (!this.unsubs.has(e)) this.unsubs.set(e, e.onWake(() => this.onEngineWake())); }
  private onEngineWake(): void {
    const now = performance.now();
    if (this.pausedAt != null) this.pausedAt = now; else if (this.lastNow != null) this.lastNow = Math.max(this.lastNow, now - 16);
    this.wake();
  }
  wake(): void { this.wantFrame = true; getScheduler().requestFrame(); }
  applyStaticMode(): void { for (const e of this.engines) { e.reducedMotion = true; e.physicsEnabled = false; e.physics.sway = false; e.motion.loop = false; e.clearPointer(); e.revealAll(); } }
  setVisible(v: boolean): void { if (v === this.visible) return; this.visible = v; if (v) { if (this.pendingResize) this.applyCanvasSize(); this.wake(); } else this.setState('offscreen'); }
  private setState(s: RuntimeState): void { if (s !== this.state) { this.state = s; this.opts.onState?.(s); } }
  /** backing store = CSS size × min(dpr, 2) × resolutionScale */
  sizeDest(): void {
    const host = this.host; if (!host || !this.destCanvas) return;
    const r = host.getBoundingClientRect(), s = Math.min(window.devicePixelRatio || 1, 2) * (this.opts.resolutionScale ?? 1);
    const w = Math.max(1, Math.round(r.width * s)), h = Math.max(1, Math.round(r.height * s));
    if (w !== this.dw || h !== this.dh) { this.dw = w; this.dh = h; if (!this.visible) { this.pendingResize = true; return; } this.applyCanvasSize(); this.wake(); }
  }
  private applyCanvasSize(): void { if (this.destCanvas) { this.destCanvas.width = this.dw; this.destCanvas.height = this.dh; this.pendingResize = false; } }
  step(now: number): boolean {
    if (!this.visible || !this.host) { this.notePause(now); return false; }
    if (this.pausedAt != null) { const gap = now - this.pausedAt; if (gap > 250) for (const e of this.engines) e.shiftTimeline(gap); this.pausedAt = null; }
    else if (this.lastNow != null) { const gap = now - this.lastNow; if (gap > 250) for (const e of this.engines) e.shiftTimeline(gap - 16); }
    const dt = this.lastNow != null ? now - this.lastNow : 0; this.lastNow = now;
    const ticks = this.engines.map((e) => e.tick(now));
    this.opts.onTick?.(ticks, this);
    const t0 = performance.now(); this.render(); this.renderMs = performance.now() - t0; this.hud(now, dt);
    this.wantFrame = false;
    if (this.engines.every((e) => e.isSettled()) && !this.wantFrame) { this.setState('idle'); this.notePause(now); return false; }
    this.setState('active'); return true;
  }
  private notePause(now: number): void { if (this.pausedAt == null) this.pausedAt = now; this.lastNow = null; }
  render(): void {
    const legs = this.engines.length === 1 ? this.engines[0].legs : this.engines.flatMap((e) => e.legs), { W, H } = this.primary;
    if (this.gl && this.destCtx) {
      const rev = this.engines.map((e) => `${e.legsRev}:${e.legs.length}`).join('|');
      this.gl.render(this.id, legs, rev, W, H, this.destCtx, this.dw, this.dh, this.primary.castShadow, this.primary.shadowDir, this.primary.shadowOffset, this.primary.shadowSpread);
    } else if (this.svg) {
      const vb = `0 0 ${W} ${H}`; if (vb !== this.svgViewBox) { this.svgViewBox = vb; this.svg.svg.setAttribute('viewBox', vb); }
      this.svg.render(legs);
    }
  }
  /** A synchronous frame outside the rAF loop (tests, screenshots). */
  renderNow(now = performance.now()): void { for (const e of this.engines) e.tick(now); this.render(); }
  private hud(now: number, dt: number): void {
    if (!this.opts.onHud) return;
    if (dt > 0) { this.fpsAcc += dt; this.fpsCnt++; }
    if (now - this.hudAt < 500) return;
    this.hudAt = now;
    this.opts.onHud({ fps: this.fpsCnt ? Math.round(1e3 / (this.fpsAcc / this.fpsCnt)) : 0, renderMs: Math.round(100 * this.renderMs) / 100, threads: this.engines.reduce((a, e) => a + e.legs.length, 0) });
    this.fpsAcc = 0; this.fpsCnt = 0;
  }
  dispose(): void {
    if (this.host) getScheduler().unregister(this, this.host);
    this.ro?.disconnect(); this.ro = null;
    for (const u of this.unsubs.values()) u(); this.unsubs.clear();
    this.gl?.releaseClient(this.id); this.gl = null;
    this.destCanvas?.remove(); this.destCanvas = null; this.destCtx = null;
    if (this.svg) { this.svg.dispose(); this.svg.svg.remove(); this.svg = null; }
    this.host = null;
  }
}

/* ── §7 mountStitch — the vanilla entry point ───────────────────────────── */

export const SITE_CLOTH_PHYSICS = { spring: 14, radiusCells: 3.5, sway: false } as const;
export const SITE_THREAD_MATERIAL = 'siteCotton';

export interface HoverPhysics { intensity: number; radiusCells: number; riseMs: number; fallMs: number }
export interface MountOptions {
  cols: number; rows: number; cell: number; pad?: number;
  /** Put the art into the engine (loadSegments / loadPlaced). setGrid() has already run. */
  load: (engine: StitchEngine, animate: boolean) => void;
  animate?: boolean;
  motion?: Partial<MotionSettings>;
  /** false = no cloth. Otherwise the resting intensity/radius, and the hover envelope. */
  physics?: false | { mode?: PhysicsMode; intensity: number; radiusCells: number; hover?: HoverPhysics; ambient?: boolean };
  pointerTypes?: 'mouse' | 'all';
  sheen?: boolean; castShadow?: boolean; widthScale?: number;
  resolutionScale?: number; layerClass?: string;
  onState?: (s: RuntimeState) => void;
}
export interface StitchInstance { engine: StitchEngine; runtime: StitchRuntime; host: HTMLDivElement; renderNow: (now?: number) => void; dispose: () => void }

/**
 * Mount a stitched surface into `container` (position:relative expected). Same
 * behaviour as the site's <StitchCanvas>: hover ramps the cloth from resting to
 * hover physics over riseMs and back over fallMs (smoothstep), the pointer is
 * mapped into engine space, and the whole thing parks itself when settled.
 */
export function mountStitch(container: HTMLElement, o: MountOptions): StitchInstance {
  const engine = new StitchEngine(o.cols, o.rows, o.cell, o.pad ?? 0);
  const host = document.createElement('div');
  const clothHover = o.physics !== false && (o.physics?.mode ?? 'cloth') === 'cloth';
  Object.assign(host.style, { position: 'absolute', inset: '0', touchAction: clothHover ? (o.pointerTypes === 'all' ? 'none' : 'pan-y') : '' });
  container.appendChild(host);

  const runtime = new StitchRuntime(engine, { renderer: 'webgl', layerClass: o.layerClass, resolutionScale: o.resolutionScale, onState: o.onState });
  runtime.attach(host);
  const layer = host.querySelector('canvas, svg') as HTMLElement | null;
  if (layer) Object.assign(layer.style, { position: 'absolute', inset: '0', display: 'block', width: '100%', height: '100%', pointerEvents: 'none' });

  // hover envelope 0..1 → interpolates intensity/radius (rise/fall, smoothstep)
  const ph = o.physics === false ? null : (o.physics ?? { intensity: 1, radiusCells: SITE_CLOTH_PHYSICS.radiusCells });
  const hover = ph?.hover;
  let env = 0, envRaf: number | null = null;
  const applyPhysics = (e: number) => {
    if (!ph) { engine.physics.mode = 'cloth'; engine.physics.sway = false; engine.physics.radius = 0; engine.physics.intensity = 1; return; }
    const lerp = (a: number, b: number | undefined) => (b === undefined ? a : a + (b - a) * e);
    engine.physics.mode = ph.mode ?? 'cloth'; engine.physics.spring = SITE_CLOTH_PHYSICS.spring;
    engine.physics.intensity = lerp(ph.intensity, hover?.intensity); engine.physics.radius = engine.cell * lerp(ph.radiusCells, hover?.radiusCells);
    engine.physics.sway = !!ph.ambient || engine.physics.mode === 'wind' || e > 0.01;
  };
  const rampTo = (target: number) => {
    if (!hover) return;
    if (envRaf !== null) cancelAnimationFrame(envRaf);
    const from = env, dur = target > from ? hover.riseMs : hover.fallMs, t0 = performance.now();
    const stepFn = () => {
      const p = dur > 0 ? Math.min(1, (performance.now() - t0) / dur) : 1;
      env = from + p * p * (3 - 2 * p) * (target - from);
      applyPhysics(env); engine.wakePhysics(); runtime.wake();
      envRaf = p < 1 ? requestAnimationFrame(stepFn) : null;
    };
    envRaf = requestAnimationFrame(stepFn);
  };

  const animate = o.animate ?? true;
  Object.assign(engine.motion, o.motion ?? {}); engine.motion.loop = false;
  engine.widthScale = o.widthScale ?? 1; engine.sheen = o.sheen ?? true; engine.castShadow = o.castShadow ?? true;
  applyPhysics(0); engine.wakePhysics(); engine.setGrid(o.cols, o.rows, o.cell);
  o.load(engine, animate);
  if (!animate) engine.revealAll();
  runtime.wake();

  const accept = (ev: PointerEvent) => o.pointerTypes === 'all' || ev.pointerType === 'mouse';
  const toEngine = (ev: PointerEvent): Vec2 => { const r = host.getBoundingClientRect(); return [((ev.clientX - r.left) / r.width) * engine.W, ((ev.clientY - r.top) / r.height) * engine.H]; };
  const handlers: Partial<Record<'pointerdown' | 'pointerenter' | 'pointermove' | 'pointerup' | 'pointerleave' | 'pointercancel', (ev: PointerEvent) => void>> = {};
  if (clothHover) {
    handlers.pointerdown = (ev) => { if (!accept(ev)) return; (ev.target as Element).setPointerCapture?.(ev.pointerId); const [x, y] = toEngine(ev); engine.setPointer(x, y, { down: true, active: true }); if (env < 1 && envRaf === null) rampTo(1); };
    handlers.pointerenter = (ev) => { if (accept(ev)) rampTo(1); };
    handlers.pointermove = (ev) => { if (!accept(ev)) return; const [x, y] = toEngine(ev); engine.setPointer(x, y, { active: true }); if (env < 1 && envRaf === null) rampTo(1); };
    handlers.pointerup = (ev) => { engine.releasePointer(); if (ev.pointerType !== 'mouse') { engine.clearPointer(); rampTo(0); } };
    handlers.pointerleave = () => { engine.clearPointer(); rampTo(0); };
    handlers.pointercancel = () => { engine.clearPointer(); rampTo(0); };
  }
  for (const [k, fn] of Object.entries(handlers)) host.addEventListener(k, fn as EventListener);

  let disposed = false;
  return {
    engine, runtime, host,
    renderNow: (now) => runtime.renderNow(now),
    dispose() {
      if (disposed) return; disposed = true;
      if (envRaf !== null) cancelAnimationFrame(envRaf);
      for (const [k, fn] of Object.entries(handlers)) host.removeEventListener(k, fn as EventListener);
      runtime.dispose(); engine.dispose(); host.remove();
    },
  };
}
