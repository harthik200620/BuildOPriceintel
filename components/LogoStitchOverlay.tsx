'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { LOGO_BLUE } from '@/lib/stitch/palette';

/**
 * The mark's page: a white sheet over the whole viewport with the stitched
 * "b" in the middle and a × in the corner. This shell renders on the server
 * too, so a hard-loaded /logo is white from the first byte; only the WebGL
 * canvas is fetched on demand (and warmed when the pointer reaches the mark
 * in the header). × is a real link to "/", so it works before hydration and
 * without JavaScript.
 *
 * While the mark is up the page underneath is `inert` (Explorer sets it), so
 * the only key we care about is Escape — but several panels listen for keys
 * on `window`, and inert does not stop those. A capture-phase listener runs
 * first and swallows every key: Escape closes, Tab keeps focus on the ×.
 */
const StitchCanvas = dynamic(() => import('./LogoStitchCanvas'), { ssr: false });

/** Warm the canvas chunk (called from the header on pointer-enter / focus). */
export const preloadStitchCanvas = () => { void import('./LogoStitchCanvas'); };

const isModified = (e: React.MouseEvent) => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;

export default function LogoStitchOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = React.useRef<HTMLAnchorElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Tab') { e.preventDefault(); closeRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    const body = document.body, prevOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    const meta = document.querySelector('meta[name="theme-color"]');
    const prevTheme = meta?.getAttribute('content') ?? null;
    meta?.setAttribute('content', '#ffffff');
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      body.style.overflow = prevOverflow;
      if (meta && prevTheme !== null) meta.setAttribute('content', prevTheme);
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="The Build Objects mark"
      className="fixed inset-0 z-[70] grid place-items-center fade-up"
      style={{ background: '#ffffff', color: LOGO_BLUE, colorScheme: 'light', overscrollBehavior: 'contain', overflow: 'hidden' }}
    >
      <a
        ref={closeRef}
        href="/"
        aria-label="Close (Escape)"
        title="Close (Esc)"
        onClick={(e) => { if (isModified(e)) return; e.preventDefault(); onClose(); }}
        className="absolute top-3 right-3 sm:top-5 sm:right-5 grid place-items-center rounded-full anim opacity-60 hover:opacity-100 focus-visible:opacity-100"
        style={{ width: 44, height: 44, outlineColor: LOGO_BLUE }}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <path d="M4 4l12 12M16 4L4 16" />
        </svg>
      </a>

      <div style={{ width: 'min(72vmin, 760px)' }}>
        <StitchCanvas />
      </div>
    </div>
  );
}
