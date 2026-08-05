'use client';

import React from 'react';
import type { ProductCard as Card } from '@/lib/types';
import { Money, FreshnessDot, CertBadge } from './primitives';
import CardGallery from './CardGallery';

/**
 * The card shows only the main features. Everything else lives one tap away in
 * the detail sheet. The discipline here is the point: a card that shows twelve
 * facts shows none of them.
 *
 * The normalised unit price is the hero — the largest type on the card, and the
 * one place the terracotta accent is spent.
 */
export default function ProductCard({
  card, onOpen, onCompare, compared, saved, onSave, onShowVendor,
}: {
  card: Card;
  onOpen: () => void;
  onCompare: () => void;
  compared: boolean;
  saved: boolean;
  onSave: () => void;
  /** Show every matching offer from this seller, ungrouped. */
  onShowVendor?: () => void;
}) {
  const stale = card.freshness_state === 'STALE' || card.freshness_state === 'EXPIRED';
  // Rotation follows attention on the whole card — pointer or keyboard.
  const [hovered, setHovered] = React.useState(false);

  return (
    <article
      /* .glass-card, not .glass: this renders 24 times a page and once per
         keystroke. backdrop-filter here would put GPU cost on every repaint
         for a blur nobody can see over a near-flat canvas. */
      className="group relative glass-card lift corner-tick overflow-hidden"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
      }}
    >
      {/* The open action is an overlay behind the content rather than a button
          wrapping it: the roll-up line is itself a control, and a button inside
          a button is invalid and unreachable by keyboard. Content is
          pointer-events-none so clicks fall through; the inner controls opt
          back in. */}
      <button
        onClick={onOpen}
        className="absolute inset-0 z-0"
        aria-label={`${card.best_vendor}${card.vendor_locality ? `, ${card.vendor_locality}` : ''}. ${card.title}. ${(card.normalised_paise / 100).toFixed(2)} rupees per ${card.unit_canonical}, delivered. Open full detail.`}
      />
      <div className="relative z-[1] text-left p-5 pb-4 pointer-events-none">
        <div className="flex gap-3.5">
          {/* Rotates through this product's photographs while the cursor is on
              the card. Sized to be legible — a 54 px plate is a favicon, and a
              rotation nobody can see is decoration. */}
          <CardGallery images={card.images} alt={card.title} size={92} active={hovered} />

          <div className="min-w-0 flex-1">
            {/* The seller leads. A card is one vendor's offer, and the results
                list is a list of sellers — so the name a buyer is choosing
                between is the headline, and the product sits under it. */}
            <h3
              className="text-[13.5px] leading-[1.3] truncate"
              style={{ color: 'var(--ink)' }}
              title={card.best_vendor}
            >
              {card.best_vendor}
            </h3>
            <div className="text-[10px] uppercase tracking-[0.11em] mt-0.5 truncate" style={{ color: 'var(--ink-3)' }}>
              {[card.vendor_locality, card.platform].filter(Boolean).join(' · ')}
            </div>
            {/* What they are selling, capped at two lines. */}
            <p
              className="text-[11.5px] leading-[1.3] mt-1.5"
              style={{
                color: 'var(--ink-2)', display: '-webkit-box', WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}
            >
              {card.title}
            </p>
            {card.spec_chips.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {card.spec_chips.slice(0, 3).map((c) => (
                  <span key={c} className="text-[10.5px] px-2 py-[2px]"
                    style={{
                      color: 'var(--ink-2)', background: 'var(--wash)',
                      border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius-pill)',
                    }}>
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* The hero number — the accent, spent once. */}
        <div className="mt-4 flex items-end justify-between gap-3">
          <div className="min-w-0">
            {/* `accent` is unconditional. It used to be `!stale`, which flipped
                the face between the display serif and the figure face at 38px
                and reflowed this min-w-0 flex child as a price aged. `stale`
                alone is enough: .price-stale sets background:none and
                -webkit-text-fill-color, and sits after .hero-figure at equal
                specificity, so it already neutralises the gradient. */}
            <Money paise={card.normalised_paise} unit={card.unit_canonical} size="hero" accent stale={stale} />
            <div className="text-[10.5px] mt-1.5 uppercase tracking-[.07em]" style={{ color: 'var(--ink-3)' }}>
              delivered to {' '}
              <span style={{ color: 'var(--ink-2)' }}>your pincode</span> · incl {(card.gst_rate_bp / 100).toFixed(0)}% GST
            </div>
          </div>
          {card.offer_count > 1 && (
            <div className="text-right shrink-0">
              <div className="text-[9.5px] uppercase tracking-[0.11em]" style={{ color: 'var(--ink-3)' }}>range</div>
              <div className="fig text-[11.5px] mt-0.5" style={{ color: 'var(--ink-2)' }}>
                {(card.floor_paise / 100).toFixed(0)}–{(card.ceiling_paise / 100).toFixed(0)}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 pt-3 rule-t flex items-center justify-between gap-2 text-[11.5px]">
          <span className="truncate min-w-0" style={{ color: 'var(--ink-2)' }}>
            {/* This seller's other matching stock, then how many sellers carry
                the same product — two different facts. The first must be a real
                control: with one card per vendor, a category supplied by a
                single seller would otherwise leave the rest of their stock
                unreachable, and a roll-up that hides is not a roll-up. */}
            {card.also_from_vendor > 0 ? (
              <button
                onClick={(e) => { e.stopPropagation(); onShowVendor?.(); }}
                className="anim hover:opacity-70 underline decoration-dotted underline-offset-2 pointer-events-auto"
                style={{ color: 'var(--accent)' }}
              >
                +{card.also_from_vendor} more from this seller
              </button>
            ) : 'only this item from this seller'}
            {card.vendor_count > 1 && (
              <span style={{ color: 'var(--ink-3)' }}> · {card.vendor_count} sellers carry it</span>
            )}
          </span>
          <span className="shrink-0" style={{ color: 'var(--ink-3)' }}>
            {card.lead_time_days == null ? 'ETA on request'
              : card.lead_time_days <= 1 ? 'tomorrow' : `${card.lead_time_days} days`}
          </span>
        </div>

        <div className="mt-2.5 flex items-center justify-between gap-2">
          <CertBadge state={card.cert_state} qco={card.qco_regulated} />
          <FreshnessDot dot={card.freshness_dot} label={card.freshness_label} exact={card.priced_as_of} />
        </div>

        {/* Rule 5(3)(f): the top two contributing ranking features, in plain language. */}
        {card.why.length > 0 && (
          <p className="mt-2.5 text-[10px] leading-snug tracking-[.01em]" style={{ color: 'var(--ink-3)', opacity: .82 }}>
            {card.why.join(' · ')}
          </p>
        )}
      </div>

      {/* Compare and save reveal on hover; always reachable by keyboard. */}
      <div className="absolute top-2.5 right-2.5 z-[2] flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 anim">
        <button
          onClick={(e) => { e.stopPropagation(); onCompare(); }}
          aria-pressed={compared}
          title={compared ? 'Remove from compare' : 'Add to compare'}
          className="chip anim w-7 h-7 grid place-items-center"
          style={compared ? { background: 'var(--ink)', color: 'var(--on-bright)', borderColor: 'var(--ink)' } : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
            <path d="M4 18V9M10 18V5M16 18v-6M22 18V8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSave(); }}
          aria-pressed={saved}
          title={saved ? 'Remove from my list' : 'Add to my list'}
          className="chip anim w-7 h-7 grid place-items-center"
          style={saved ? { background: 'var(--accent)', color: 'var(--on-bright)', borderColor: 'var(--accent)' } : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </article>
  );
}
