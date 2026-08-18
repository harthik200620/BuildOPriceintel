'use client';

import * as React from 'react';
import { mountStitch, SITE_THREAD_MATERIAL, type MotionSettings } from '@/lib/stitch/engine';
import { buildLogoSegments, logoGrid, LOGO_DEFAULT_COLS } from '@/lib/stitch/logo-composition';

/**
 * The stitched "b". Loaded lazily by LogoStitchOverlay — this file is the only
 * importer of the engine, so nothing of it rides in the catalogue's chunk.
 *
 * Numbers are the site's login panel, exactly:
 *   physics   StitchAsset(width 480, cols 40, physicsScale 3) ⇒ S = 12 css px per
 *             cell ⇒ resting intensity 5.5·3/(0.5·12) = 2.75 and radius 20·3/12 =
 *             5 cells; on hover 8·3/6 = 4 and 28·3/12 = 7 cells, ramped over
 *             220 ms in and 520 ms out; cloth spring 14.
 *   reveal    wave, left → right; every cell's threads sew in over 320 ms
 *             (legDur 160 × 2), rows of cells staggered so the whole mark takes
 *             about a second.
 *   thread    "siteCotton", sheen on, no cast shadow, width scale 1.
 */
export const LOGO_PHYSICS = { mode: 'cloth' as const, intensity: 2.75, radiusCells: 5, hover: { intensity: 4, radiusCells: 7, riseMs: 220, fallMs: 520 } };
export const LOGO_MOTION: Partial<MotionSettings> = { mode: 'wave', waveDir: 'right', stagger: 14, speed: 320 };

/** Dev-only tuning: /logo?cols=52 (ignored in production). */
function colsFromUrl(): number {
  if (process.env.NODE_ENV === 'production' || typeof window === 'undefined') return LOGO_DEFAULT_COLS;
  const v = Number(new URLSearchParams(window.location.search).get('cols'));
  return Number.isFinite(v) && v >= 24 && v <= 120 ? Math.round(v) : LOGO_DEFAULT_COLS;
}

export default function LogoStitchCanvas({ cols: colsProp, color }: { cols?: number; color?: string }) {
  const host = React.useRef<HTMLDivElement>(null);
  const [cols] = React.useState(() => colsProp ?? colsFromUrl());
  const grid = React.useMemo(() => logoGrid(cols), [cols]);

  React.useEffect(() => {
    const el = host.current;
    if (!el) return;
    // The mark's own blue on /logo's white sheet; the site's aqua when the
    // welcome screen sews it onto the dark ground. Same geometry either way —
    // only the thread changes.
    const art = buildLogoSegments({ cols, ...(color ? { color } : {}) });
    const inst = mountStitch(el, {
      cols: art.grid.cols, rows: art.grid.rows, cell: art.grid.cell, pad: 0,
      load: (engine, animate) => engine.loadSegments(art.segments, { material: SITE_THREAD_MATERIAL, width: 4, schedule: animate }),
      animate: true,
      motion: LOGO_MOTION,
      physics: LOGO_PHYSICS,
      pointerTypes: 'all',
      sheen: true, castShadow: false, widthScale: 1, resolutionScale: 1,
    });
    // dev-only handle for the browser console / screenshots: window.__logoStitch
    const w = window as Window & { __logoStitch?: unknown };
    if (process.env.NODE_ENV !== 'production') w.__logoStitch = { ...inst, art };
    return () => { inst.dispose(); if (w.__logoStitch && (w.__logoStitch as { engine?: unknown }).engine === inst.engine) delete w.__logoStitch; };
  }, [cols, color]);

  // The box keeps the grid's aspect so every cell is square on screen; the
  // engine stretches its W×H space over whatever the box measures.
  return <div ref={host} style={{ position: 'relative', width: '100%', aspectRatio: `${grid.W} / ${grid.H}` }} />;
}
