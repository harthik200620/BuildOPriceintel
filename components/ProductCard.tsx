'use client';

import React from 'react';
import type { ProductCard as Card } from '@/lib/types';
import { Money, FreshnessDot, CertBadge } from './primitives';
import { IconChevronRight } from './icons';
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
  card, onOpen, onCompare, compared, saved, onSave,
}: {
  card: Card;
  onOpen: () => void;
  onCompare: () => void;
  compared: boolean;
  saved: boolean;
  onSave: () => void;
}) {
  const stale = card.freshness_state === 'STALE' || card.freshness_state === 'EXPIRED';
  // Rotation follows attention on the whole card — pointer or keyboard.
  const [hovered, setHovered] = React.useState(false);

  return (
    <article
      /* .glass-card, not .glass: this renders 24 times a page and once per
         keystroke. backdrop-filter here would put GPU cost on every repaint
         for a blur nobody can see over a near-flat canvas. */
      className="group relative glass-card lift overflow-hidden"
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
      {/* `why` is Rule 5(3)(f) — the ranking features that put this result
          here. It used to print as a fourth line of 10 px grey under the card
          and is now carried in the card's own accessible name instead: the
          disclosure still travels with the individual result, it just stops
          competing with the price for the eye. The page-level disclosure above
          the grid names the applied order in full. */}
      <button
        onClick={onOpen}
        className="absolute inset-0 z-0"
        aria-label={
          `${card.title}. ` +
          `${(card.normalised_paise / 100).toFixed(2)} rupees per ${card.unit_canonical}, delivered. ` +
          `${card.sellers_for_product > 1 ? `Lowest of ${card.sellers_for_product} sellers. ` : 'One seller. '}` +
          `${card.why.length ? `Ranked here on ${card.why.join(', ')}. ` : ''}` +
          `Open full detail.`
        }
      />
      <div className="relative z-[1] text-left p-5 pb-4 pointer-events-none">
        <div className="flex gap-3.5">
          {/* Rotates through this product's photographs while the cursor is on
              the card. Sized to be legible — a 54 px plate is a favicon, and a
              rotation nobody can see is decoration. */}
          <CardGallery images={card.images} alt={card.title} size={92} active={hovered} />

          <div className="min-w-0 flex-1">
            {/* The PRODUCT leads.
                The seller's business name used to be the headline, because the
                list was one card per vendor — which meant the same 50 kg bag
                appeared three times under three company names, and the name was
                the only thing telling those rows apart. The list is one card per
                product now, so the thing being bought is the heading and the
                seller is a consequence of it: which seller, and the rest of
                them, is on the product's own page. */}
            <h3
              className="text-[13.5px] leading-[1.35]"
              style={{
                color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical', overflow: 'hidden',
              }}
              title={card.title}
            >
              {card.title}
            </h3>
            {card.brand && (
              <div className="text-[10px] uppercase tracking-[0.11em] mt-1 truncate" style={{ color: 'var(--ink-3)' }}>
                {card.brand}
              </div>
            )}
            {/* The spec chips used to sit here — PPC, 50 kg — under a title
                that already reads "UltraTech PPC cement — 50 kg bag". They
                were a row of type restating the row above them, so they went;
                the sheet lists every typed attribute in full. */}
          </div>
        </div>

        {/* The hero number — the accent, spent once. */}
        <div className="mt-4">
          {/* `accent` is unconditional. It used to be `!stale`, which flipped
              the face between the display serif and the figure face at 38px
              and reflowed this min-w-0 flex child as a price aged. `stale`
              alone is enough: .price-stale sets background:none and
              -webkit-text-fill-color, and sits after .hero-figure at equal
              specificity, so it already neutralises the gradient. */}
          <Money paise={card.normalised_paise} unit={card.unit_canonical} size="hero" accent stale={stale} />
          {/* The range across every offer used to hang on the end of this line
              and wrapped it onto a second row at two of the three widths. It is
              a fact about the PRODUCT, not about this seller's price, and the
              product page prints it under the same figure — so it belongs
              there and this line stays one row wherever the card is. */}
          <div className="text-[10.5px] mt-1.5 uppercase tracking-[.07em]" style={{ color: 'var(--ink-3)' }}>
            {/* "lowest of N" only where there is more than one — on a product a
                single seller carries, "lowest of 1" is a boast about nothing. */}
            {card.sellers_for_product > 1 ? <>lowest of {card.sellers_for_product} sellers · </> : null}
            delivered · incl {(card.gst_rate_bp / 100).toFixed(0)}% GST
          </div>
        </div>

        {/*
          One meta line, not four.
          This card used to print thirteen separate facts — range, lead time,
          certification, freshness, the seller's other stock, how many sellers
          carried it, and the two ranking reasons — each on its own row at
          roughly the same weight. The file's own opening comment says a card
          that shows twelve facts shows none of them, and the card was the
          counter-example. What survives is what changes a decision at the
          moment of scanning: whether the price is current, whether the brand is
          licensed, and when it can arrive. The rest is one tap away in the
          sheet, which is where it always was as well.
        */}
        {/* No wrap: the certification chip is long enough that this row broke
            onto a second line in some cards and not others, so a grid of cards
            came out at two different heights on the same row. The chip is the
            one element allowed to shrink. */}
        <div className="mt-3.5 pt-3 rule-t flex items-center gap-x-2 gap-y-1.5 text-[11px] min-w-0 flex-wrap md:flex-nowrap">
          <span className="shrink-0">
            <FreshnessDot dot={card.freshness_dot} label={card.freshness_label} exact={card.priced_as_of} />
          </span>
          {/* Truncated only where the row may not wrap. On a phone the cards
              are a single column, so an extra line costs nothing and two cards
              cannot come out at different heights beside each other — and
              clipping a certification to "BIS-LICENSED BRAN" is worse than any
              amount of wrapping. */}
          <span className="min-w-0 md:truncate">
            <CertBadge state={card.cert_state} qco={card.qco_regulated} />
          </span>
          <span className="ml-auto shrink-0" style={{ color: 'var(--ink-3)' }}>
            {card.lead_time_days == null ? 'ETA on request'
              : card.lead_time_days <= 1 ? 'tomorrow' : `${card.lead_time_days} days`}
          </span>
        </div>

        {/* Where the card goes, said plainly.
            This used to read "+N more from this seller" — the roll-up a
            per-vendor list needed. What a product card rolls up is the other
            SELLERS of the same product, and they are on the product's page,
            which is where the whole card already leads. So this is a label in
            --ink-3 with a chevron, not accent-coloured text: an accent span
            that cannot be focused or clicked reads as a second control sitting
            inside the first one, and there is only one target here. */}
        {card.sellers_for_product > 1 && (
          <span
            className="mt-1 text-[11px] inline-flex items-center gap-1 min-h-8"
            style={{ color: 'var(--ink-3)' }}
          >
            Compare {card.sellers_for_product} sellers
            <IconChevronRight size={11} />
          </span>
        )}
      </div>

      {/* Compare and save reveal on hover; always reachable by keyboard. */}
      <div className="absolute top-2.5 right-2.5 z-[2] flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 anim">
        <button
          onClick={(e) => { e.stopPropagation(); onCompare(); }}
          aria-pressed={compared}
          title={compared ? 'Remove from compare' : 'Add to compare'}
          className="chip anim w-8 h-8 grid place-items-center"
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
          className="chip anim w-8 h-8 grid place-items-center"
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
