/**
 * How heavy is the stitched mark at a given grid? Prints threads / inked cells
 * / build time for a range of column counts, so the one knob in
 * lib/stitch/logo-composition.ts (LOGO_DEFAULT_COLS) can be chosen with numbers.
 *
 *   npx tsx scripts/logo-stitch-stats.ts            → 40 44 48 52 56
 *   npx tsx scripts/logo-stitch-stats.ts 36 64      → a custom range, step 4
 */
import { buildLogoSegments } from '../lib/stitch/logo-composition';

const [from = '40', to = '56'] = process.argv.slice(2);
for (let cols = Number(from); cols <= Number(to); cols += 4) {
  const t0 = performance.now();
  const m = buildLogoSegments({ cols });
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`cols ${String(cols).padStart(3)} → grid ${m.grid.cols}×${m.grid.rows}, cell ${m.grid.cellPx.toFixed(1)} scan px, ${String(m.segments.length).padStart(6)} threads in ${String(m.cellsTouched).padStart(5)} cells, built in ${ms} ms`);
}
