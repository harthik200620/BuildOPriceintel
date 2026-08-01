'use client';

import React from 'react';

/**
 * The card's picture plate — up to five photographs, rotating while the cursor
 * is on the card.
 *
 * Product decisions worth stating, because each of them is a way this feature
 * usually goes wrong:
 *
 * - **It rotates on hover, not always.** Twenty-four cards animating on a price
 *   comparison page is a fairground. Motion here is a response to attention,
 *   so it starts on hover or keyboard focus and resets when attention leaves.
 * - **One picture never rotates** and shows no dots. A carousel of one is a lie
 *   about how much there is to see.
 * - **Nothing loads until it is wanted.** Only the first frame is in the initial
 *   payload; frames 2–5 are fetched on first hover. At 24 cards that is the
 *   difference between 24 images on load and 120.
 * - **Reduced motion is honoured properly** — no auto-advance at all, and the
 *   dots become real buttons so every picture stays reachable. The accessible
 *   path is not a degraded one.
 * - **A broken file removes its frame** rather than showing a torn-image icon.
 */

const INTERVAL_MS = 1150;

export default function CardGallery({
  images, alt, size = 92, active = false,
}: {
  images: string[]; alt: string; size?: number;
  /**
   * Driven by the whole CARD's hover/focus, not the plate's. The brief is
   * "rotate when the cursor is on the product card", and the card's content
   * layer is pointer-events-none so the overlay button can take the click —
   * a listener on this element would never fire.
   */
  active?: boolean;
}) {
  const [broken, setBroken] = React.useState<Set<string>>(() => new Set());
  const live = React.useMemo(() => images.filter((u) => !broken.has(u)).slice(0, 5), [images, broken]);

  const [idx, setIdx] = React.useState(0);
  const [hot, setHot] = React.useState(false);      // has anything beyond frame 1 been requested yet
  const reduceMotion = useReducedMotion();
  const rotating = active && live.length > 1 && !reduceMotion;

  React.useEffect(() => {
    if (!rotating) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % live.length), INTERVAL_MS);
    return () => clearInterval(t);
  }, [rotating, live.length]);

  // First time attention lands, admit frames 2-5 into the DOM.
  React.useEffect(() => { if (active) setHot(true); }, [active]);

  // Attention left: back to the seller's own first frame, so the resting state
  // of the grid is stable rather than however far each card happened to get.
  React.useEffect(() => { if (!active) setIdx(0); }, [active]);

  if (!live.length) return <EmptyPlate size={size} />;

  return (
    <div
      className="relative shrink-0 overflow-hidden"
      style={{
        width: size, height: size, borderRadius: '10px',
        background: 'linear-gradient(160deg, rgba(255,255,255,.92), rgba(22,20,18,.06))',
        border: '1px solid var(--glass-hair)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9)',
      }}
    >
      {live.map((src, i) => {
        // Frame 1 ships with the page; frames 2–5 are not mounted at all until
        // a cursor first lands on this card. An <img> with no src is a broken
        // image, so the element is withheld rather than emptied.
        if (i > 0 && !hot) return null;
        return (
          <img
            key={src}
            src={src}
            alt={i === 0 ? alt : ''}
            aria-hidden={i !== 0}
            loading={i === 0 ? 'lazy' : 'eager'}
            decoding="async"
            draggable={false}
            onError={() => setBroken((s) => new Set(s).add(src))}
            className="absolute inset-0 w-full h-full object-cover"
            style={{
              opacity: i === idx ? 1 : 0,
              transform: i === idx ? 'scale(1)' : 'scale(1.035)',
              transition: reduceMotion
                ? 'none'
                : 'opacity .34s ease, transform .5s cubic-bezier(.2,.7,.3,1)',
            }}
          />
        );
      })}

      {live.length > 1 && (
        <div
          className="absolute left-0 right-0 bottom-0 flex gap-[2px] p-[3px]"
          style={{ background: 'linear-gradient(to top, rgba(22,20,18,.34), transparent)' }}
        >
          {live.map((src, i) =>
            reduceMotion ? (
              <button
                key={src}
                onClick={(e) => { e.stopPropagation(); setIdx(i); setHot(true); }}
                aria-label={`Picture ${i + 1} of ${live.length}`}
                aria-current={i === idx}
                className="flex-1 pointer-events-auto"
                style={{ height: 3, borderRadius: 2, background: i === idx ? 'var(--accent-lift)' : 'rgba(255,255,255,.55)' }}
              />
            ) : (
              <span
                key={src}
                aria-hidden
                className="flex-1 anim"
                style={{ height: 3, borderRadius: 2, background: i === idx ? 'var(--accent-lift)' : 'rgba(255,255,255,.55)' }}
              />
            ),
          )}
        </div>
      )}

      {/* Screen readers get the count as a fact, not as an animation. */}
      {live.length > 1 && <span className="sr-only">{live.length} photographs of this product</span>}
    </div>
  );
}

function EmptyPlate({ size }: { size: number }) {
  return (
    <div
      className="shrink-0 grid place-items-center"
      style={{
        width: size, height: size, borderRadius: '10px',
        background: 'linear-gradient(160deg, rgba(255,255,255,.9), rgba(22,20,18,.05))',
        border: '1px solid var(--glass-hair)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9)',
      }}
      title="No photograph was published with any listing for this product"
    >
      {/* Blueprint line-art stand-in — a drawn object, not a broken image. */}
      <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden style={{ color: 'var(--ink-3)', opacity: .45 }}>
        <rect x="3" y="7" width="18" height="12" fill="none" stroke="currentColor" strokeWidth="1" />
        <path d="M3 11h18M8 7v12" stroke="currentColor" strokeWidth="1" />
      </svg>
    </div>
  );
}

function useReducedMotion(): boolean {
  const [v, setV] = React.useState(false);
  React.useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setV(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return v;
}
