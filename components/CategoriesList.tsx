'use client';

import React from 'react';
import { CATALOGUE, type CatalogueEntry } from '@/lib/catalogue';
import { CategoryIcon, IconChevronRight } from './icons';

/**
 * Every category as a list — the whole shelf on one screen, which the 4×2 grid
 * of photographs on the home page cannot be at a phone's width.
 *
 * Live and coming-soon are both here, in one list, because the shelf is the
 * point: a buyer looking for sand should find out that sand is not tracked yet
 * rather than not find sand. A coming-soon row is dimmed, is not a link, and
 * prints no count and no price — the rule the whole application is built on.
 */

/**
 * The photograph, or the glyph when there is none.
 *
 * Two of the nine categories have no image on disk, and a missing src renders
 * as the browser's broken-image icon — the one thing worse than no picture. So
 * the glyph is what shows underneath, and the photograph is layered over it
 * only once it has actually decoded.
 */
export function CatThumb({ entry, size = 60 }: { entry: CatalogueEntry; size?: number }) {
  const [ok, setOk] = React.useState(true);
  return (
    <div className="cat-row-thumb grid place-items-center" style={{ width: size, height: size }}>
      {ok && entry.image ? (
        <img
          src={entry.image}
          alt=""
          aria-hidden
          loading="lazy"
          onError={() => setOk(false)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <CategoryIcon name={entry.icon} size={Math.round(size * 0.42)} style={{ color: 'var(--ink-3)' }} />
      )}
    </div>
  );
}

export default function CategoriesList({
  onOpen, counts,
}: {
  onOpen: (e: CatalogueEntry) => void;
  /** Sellers per live category, from /api/meta. Absent while it loads. */
  counts?: Record<string, { sellers: number } | undefined>;
}) {
  return (
    <ul className="flex flex-col gap-2.5">
      {CATALOGUE.map((c) => {
        const n = c.live ? counts?.[c.id]?.sellers : undefined;
        const inner = (
          <>
            <CatThumb entry={c} />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] leading-tight" style={{ color: 'var(--ink)' }}>{c.label}</div>
              <div className="text-[11.5px] leading-[1.35] mt-1" style={{ color: 'var(--ink-3)' }}>
                {c.blurb}
              </div>
              {c.live
                ? n != null && (
                    <div className="text-[11px] mt-1 tnum" style={{ color: 'var(--ink-3)' }}>
                      {n.toLocaleString('en-IN')} sellers
                    </div>
                  )
                : (
                    <div className="text-[10px] uppercase mt-1.5 inline-block px-1.5 py-[1px]"
                      style={{
                        color: 'var(--accent-ink)', letterSpacing: '.11em',
                        border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius-pill)',
                      }}>
                      coming soon
                    </div>
                  )}
            </div>
            {c.live && <IconChevronRight size={17} style={{ color: 'var(--ink-3)' }} />}
          </>
        );

        return (
          <li key={c.id}>
            {c.live ? (
              <a
                href={`/c/${c.slug}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                  e.preventDefault();
                  onOpen(c);
                }}
                className="cat-row lift anim"
              >
                {inner}
              </a>
            ) : (
              <div className="cat-row cat-row--soon" aria-disabled>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
