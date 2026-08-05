'use client';

import React from 'react';
import type { ProductCard } from '@/lib/types';
import { Money, rupees } from './primitives';

/**
 * Docks once two or more items are selected. Comparison is only ever offered
 * across a single basis — delivered to the same pincode, inclusive of GST, per
 * canonical unit — because sorting incomparable prices is a correctness bug,
 * not a UX preference.
 */
export default function CompareTray({
  items, onRemove, onClear, onOpen,
}: {
  items: ProductCard[]; onRemove: (id: string) => void; onClear: () => void;
  /** The whole card, not just its product: a compare item is one seller's offer. */
  onOpen: (c: ProductCard) => void;
}) {
  if (items.length < 2) return null;

  const units = new Set(items.map((i) => i.unit_canonical));
  const comparable = units.size === 1;
  const sorted = [...items].sort((a, b) => a.normalised_paise - b.normalised_paise);
  const cheapest = sorted[0];
  const dearest = sorted[sorted.length - 1];
  const spread = dearest.normalised_paise - cheapest.normalised_paise;
  const spreadPct = (spread / cheapest.normalised_paise) * 100;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 tray-in"
      style={{
        background: 'var(--chrome)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
        backdropFilter: 'blur(20px) saturate(1.15)',
        borderTop: '1px solid var(--glass-hair)',
        boxShadow: '0 -12px 40px -18px rgba(0,8,11,.66), inset 0 1px 0 var(--glass-border)',
      }}>
      <div className="mx-auto max-w-[1680px] px-6 lg:px-10 py-3">
        <div className="flex items-center justify-between gap-4 mb-2.5">
          <div className="flex items-baseline gap-3">
            <h2 className="display text-[15px]">Comparing {items.length}</h2>
            {comparable ? (
              <span className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                spread <span className="fig" style={{ color: 'var(--accent)' }}>{rupees(spread)}</span>
                {' '}· <span className="tnum">{spreadPct.toFixed(1)}%</span> between cheapest and dearest, delivered
              </span>
            ) : (
              /* The engine refuses to render a comparison across bases. */
              <span className="text-[11.5px] px-2 py-0.5" style={{ color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '10px' }}>
                not comparable — {[...units].join(' vs ')} are different units, so these are shown separately rather than sorted together
              </span>
            )}
          </div>
          <button onClick={onClear} className="text-[11.5px] anim hover:opacity-70" style={{ color: 'var(--ink-3)' }}>
            clear all
          </button>
        </div>

        <div className="flex gap-2 overflow-x-auto scroll-thin pb-1">
          {sorted.map((c) => (
            <div key={c.offer_id} className="shrink-0 w-[230px] p-2.5 relative anim"
              style={{
                background: 'var(--glass-strong)',
                border: `1px solid ${comparable && c.offer_id === cheapest.offer_id ? 'var(--accent)' : 'var(--rule)'}`,
                borderRadius: '10px',
              }}>
              <button onClick={() => onRemove(c.offer_id)}
                className="absolute top-1.5 right-1.5 anim hover:opacity-70 text-[11px]"
                style={{ color: 'var(--ink-3)' }} aria-label={`Remove ${c.title} from compare`}>✕</button>
              <button onClick={() => onOpen(c)} className="text-left w-full">
                <div className="text-[11px] truncate pr-4" style={{ color: 'var(--ink-3)' }}>{c.brand ?? 'Unbranded'}</div>
                <div className="text-[12px] leading-snug mb-1.5" style={{
                  color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                }}>{c.title}</div>
                {/* No `accent` here. The cheapest card is already marked twice
                    — the accent border above, and the "+₹N vs cheapest" line
                    below on every other card — and this third encoding was the
                    only one that changed typeface mid-row. */}
                <Money paise={c.normalised_paise} unit={c.unit_canonical} size="md" />
                {comparable && c.offer_id !== cheapest.offer_id && (
                  <div className="fig text-[11px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    +{rupees(c.normalised_paise - cheapest.normalised_paise)} vs cheapest
                  </div>
                )}
                <div className="text-[10.5px] mt-1" style={{ color: 'var(--ink-3)' }}>
                  {c.vendor_count} {c.vendor_count === 1 ? 'vendor' : 'vendors'} · {c.freshness_label}
                </div>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
