'use client';

import React from 'react';
import { type CartLine, type CartTotals, clampQty, MAX_QTY } from '@/lib/cart';
import { rupees } from './primitives';
import { IconPlus, IconMinus, IconTrash, IconBag } from './icons';

/**
 * The estimate: what has been added, at what quantity, and what that comes to.
 *
 * The arithmetic is the same arithmetic the cards showed — each line is the
 * seller's landed, GST-inclusive price for one canonical unit, multiplied by a
 * quantity. Two lines of the summary exist to stop that being read as a
 * checkout total:
 *
 *   - GST is shown as the component ALREADY INSIDE the total, because every
 *     figure on this site is inclusive. A "+ GST" line would overstate the
 *     estimate by the rate.
 *   - Delivery is likewise already inside each price, so there is no separate
 *     freight line to add — the estimate says so rather than printing a ₹0 row
 *     that looks like free delivery.
 *
 * And it does not check out. Build Objects holds no stock and takes no payment;
 * what it can truthfully do at the end is hand the list to the sellers as an
 * enquiry, so that is what the button says.
 */
export default function ListPage({
  lines, sums, onQty, onRemove, onBrowse, pincode, regionName,
}: {
  lines: CartLine[];
  sums: CartTotals;
  onQty: (offerId: string, qty: number) => void;
  onRemove: (offerId: string) => void;
  onBrowse: () => void;
  pincode: string;
  regionName: string;
}) {
  if (lines.length === 0) {
    return (
      <div className="flex flex-col items-center text-center py-16 px-6 fade-up">
        <div className="grid place-items-center w-16 h-16 rounded-full" style={{ background: 'var(--wash)', color: 'var(--ink-3)' }}>
          <IconBag size={28} />
        </div>
        <h2 className="display text-[18px] mt-5" style={{ color: 'var(--ink)' }}>Nothing on the estimate yet</h2>
        <p className="text-[13px] mt-2 max-w-[38ch]" style={{ color: 'var(--ink-2)' }}>
          Add any seller&rsquo;s offer and it lands here with its quantity, so you can price a
          whole order before you call anyone.
        </p>
        <button onClick={onBrowse} className="btn-primary h-11 px-6 text-[13.5px] mt-6">
          Browse categories
        </button>
      </div>
    );
  }

  return (
    <div className="fade-up">
      <ul className="flex flex-col">
        {lines.map((l, i) => {
          const floor = Math.max(1, Math.ceil(l.moq_qty ?? 1));
          return (
            <li key={l.offer_id} className={i > 0 ? 'rule-t' : undefined}>
              <div className="line-row">
                <div className="line-thumb">
                  {l.image
                    ? <img src={l.image} alt="" aria-hidden loading="lazy" />
                    : <span className="grid place-items-center w-full h-full text-[10px]" style={{ color: 'var(--ink-3)' }}>no photo</span>}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-[1.35]" style={{
                        color: 'var(--ink)', display: '-webkit-box', WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical', overflow: 'hidden',
                      }}>
                        {l.title}
                      </p>
                      <p className="text-[11px] mt-1 truncate" style={{ color: 'var(--ink-3)' }}>{l.vendor}</p>
                    </div>
                    <button
                      onClick={() => onRemove(l.offer_id)}
                      className="icon-btn anim shrink-0"
                      style={{ width: 32, height: 32 }}
                      aria-label={`Remove ${l.title} from the estimate`}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
                    <div className="qty" role="group" aria-label={`Quantity, in ${l.unit}`}>
                      <button
                        onClick={() => onQty(l.offer_id, clampQty(l.qty - 1, l.moq_qty))}
                        disabled={l.qty <= floor}
                        aria-label="One fewer"
                        className="anim"
                      >
                        <IconMinus size={15} />
                      </button>
                      <span className="qty-val fig" aria-live="polite">
                        {l.qty} <span style={{ color: 'var(--ink-3)' }}>{l.unit}</span>
                      </span>
                      <button
                        onClick={() => onQty(l.offer_id, clampQty(l.qty + 1, l.moq_qty))}
                        disabled={l.qty >= MAX_QTY}
                        aria-label="One more"
                        className="anim"
                      >
                        <IconPlus size={15} />
                      </button>
                    </div>
                    <div className="text-right">
                      <div className="fig text-[15px]" style={{ color: 'var(--ink)' }}>
                        {rupees(l.unit_paise * l.qty)}
                      </div>
                      <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                        {rupees(l.unit_paise, l.unit_paise < 10_000)} per {l.unit}
                      </div>
                    </div>
                  </div>

                  {l.moq_qty != null && l.moq_qty > 1 && (
                    <p className="text-[10.5px] mt-1.5" style={{ color: 'var(--ink-3)' }}>
                      Seller&rsquo;s minimum is {l.moq_qty} {l.unit}.
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="glass-card p-4 mt-5" style={{ borderRadius: 'var(--radius-glass)' }} aria-label="Price details">
        <h2 className="text-[11px] uppercase mb-2" style={{ color: 'var(--ink-3)', letterSpacing: '.14em' }}>
          Price details
        </h2>
        <div className="sum-row">
          <span>Materials, before tax ({sums.lines} {sums.lines === 1 ? 'item' : 'items'})</span>
          <span className="fig" style={{ color: 'var(--ink)' }}>{rupees(sums.net_paise)}</span>
        </div>
        <div className="sum-row">
          <span>GST, included above</span>
          <span className="fig" style={{ color: 'var(--ink)' }}>{rupees(sums.gst_paise)}</span>
        </div>
        <div className="sum-row">
          <span>Delivery to {pincode}</span>
          <span style={{ color: 'var(--ink-3)' }}>in each price</span>
        </div>
        <div className="sum-row sum-row--total">
          <span>Estimated total</span>
          <span className="fig hero-figure" style={{ fontSize: '21px' }}>{rupees(sums.total_paise)}</span>
        </div>
        <p className="text-[11px] leading-[1.5] mt-3" style={{ color: 'var(--ink-3)' }}>
          Every figure is the price that seller published, landed at {pincode} in {regionName},
          inclusive of GST and freight. It is an estimate from published prices, not a quotation —
          confirm with the seller before you order.
        </p>
      </section>

      <div className="mt-4 flex flex-col gap-2.5">
        <button className="btn-primary h-12 w-full text-[14px]" onClick={onBrowse}>
          Add more materials
        </button>
      </div>
    </div>
  );
}
