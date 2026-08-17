'use client';

import React from 'react';
import { IconChevronLeft, IconShare, IconBag } from './icons';

/**
 * The bar on a screen you arrived at from somewhere: back, what this is, and
 * the two actions that belong to it.
 *
 * Back goes back in history rather than to a fixed parent, because arriving at
 * a product from a search and from a category are different journeys and only
 * history knows which one happened. `fallback` is what it does when there is no
 * history to return to — a deep link opened in a fresh tab — so the arrow is
 * never a dead control.
 *
 * Share uses the platform sheet when the browser has one and falls back to
 * copying the URL, which is what a share is for on a desktop anyway.
 */
export default function AppBar({
  title, onBack, fallbackLabel, listCount, onList, share,
}: {
  title: string;
  onBack: () => void;
  fallbackLabel: string;
  listCount: number;
  onList: () => void;
  /** Omitted on screens where there is nothing specific to share. */
  share?: { title: string; url: string };
}) {
  const [copied, setCopied] = React.useState(false);

  const doShare = React.useCallback(async () => {
    if (!share) return;
    const url = new URL(share.url, window.location.origin).toString();
    try {
      if (navigator.share) {
        await navigator.share({ title: share.title, url });
        return;
      }
    } catch {
      // A dismissed share sheet throws AbortError. That is the buyer changing
      // their mind, not a failure, and it must not fall through to the clipboard.
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* nothing sensible left to try */
    }
  }, [share]);

  return (
    <div className="appbar md:hidden">
      <div className="appbar-in">
        <button onClick={onBack} className="icon-btn anim" aria-label={`Back to ${fallbackLabel}`}>
          <IconChevronLeft size={21} />
        </button>
        <h1 className="appbar-title display">{title}</h1>
        {share && (
          <button onClick={doShare} className="icon-btn anim" aria-label={copied ? 'Link copied' : 'Share this product'}>
            {copied
              ? <span className="text-[10px] font-semibold" style={{ color: 'var(--accent)' }}>copied</span>
              : <IconShare size={19} />}
          </button>
        )}
        <button onClick={onList} className="icon-btn anim" aria-label={`The estimate, ${listCount} ${listCount === 1 ? 'line' : 'lines'}`}>
          <IconBag size={21} />
          {listCount > 0 && <span className="badge" aria-hidden>{listCount > 99 ? '99+' : listCount}</span>}
        </button>
      </div>
    </div>
  );
}
