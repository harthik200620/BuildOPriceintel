/**
 * The list a buyer builds while comparing, and the estimate it adds up to.
 *
 * This is a cart in shape and an estimate in fact, and the difference is the
 * honest part. Build Objects does not take an order or a payment: it knows what
 * each seller published, landed at your pincode. So a line holds the offer it
 * came from and a quantity, the totals are the same arithmetic the card
 * already showed — `normalised_paise` is the landed, GST-inclusive price per
 * canonical unit — and the last step sends the list to the sellers as an
 * enquiry rather than charging anyone.
 *
 * Two consequences worth stating, because they shape the numbers:
 *
 *   - GST is BACKED OUT, not added on. Every figure on this site is already
 *     inclusive at the stated HSN rate, so the tax line shows the component
 *     inside the total. Adding it again would overstate every estimate by the
 *     rate.
 *   - Delivery is already inside each line for the same reason — freight to
 *     the pincode is part of the landed price — so the estimate does not carry
 *     a separate delivery charge it would be double-counting.
 *
 * Lines are keyed by `offer_id`: one seller's listing of one product. The same
 * product from two sellers is two lines, because it is two prices.
 */

import type { ProductCard } from './types';

const KEY = 'buildobjects:list';
/** Beyond this a "quantity" is a project, and a project is a different flow. */
export const MAX_QTY = 9_999;

export interface CartLine {
  offer_id: string;
  product_id: string;
  title: string;
  vendor: string;
  vendor_id: string;
  image: string | null;
  unit: string;
  /** Landed, GST-inclusive, per canonical unit — the card's hero figure. */
  unit_paise: number;
  gst_rate_bp: number;
  qty: number;
  /** Seller's minimum, when they published one. Null means they did not. */
  moq_qty: number | null;
}

export interface CartTotals {
  lines: number;
  units: number;
  /** Sum of qty × landed price. GST-inclusive, freight-inclusive. */
  total_paise: number;
  /** The GST already inside `total_paise`, not an addition to it. */
  gst_paise: number;
  /** `total_paise` less the tax component. */
  net_paise: number;
}

export function lineOf(card: ProductCard, qty = 1): CartLine {
  return {
    offer_id: card.offer_id,
    product_id: card.product_id,
    title: card.title,
    vendor: card.best_vendor,
    vendor_id: card.vendor_id,
    image: card.images?.[0] ?? card.image_url ?? null,
    unit: card.unit_canonical,
    unit_paise: card.normalised_paise,
    gst_rate_bp: card.gst_rate_bp,
    qty: clampQty(qty, card.moq_qty ?? null),
    moq_qty: card.moq_qty ?? null,
  };
}

/** A quantity never drops below the seller's own minimum, or below one. */
export function clampQty(qty: number, moq: number | null): number {
  const floor = Math.max(1, Math.ceil(moq ?? 1));
  if (!Number.isFinite(qty)) return floor;
  return Math.min(MAX_QTY, Math.max(floor, Math.round(qty)));
}

export function totals(lines: CartLine[]): CartTotals {
  let total = 0;
  let gst = 0;
  let units = 0;
  for (const l of lines) {
    const sub = l.unit_paise * l.qty;
    total += sub;
    // Inclusive → the tax inside a gross figure is gross × r/(1+r).
    gst += Math.round((sub * l.gst_rate_bp) / (10_000 + l.gst_rate_bp));
    units += l.qty;
  }
  return { lines: lines.length, units, total_paise: total, gst_paise: gst, net_paise: total - gst };
}

/* ── persistence ───────────────────────────────────────────────────────────
   Same guard as prefs: private mode and some embedded browsers throw on
   access, and a list is never worth an exception. */

export function readCart(): CartLine[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const j = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    return j.filter(
      (l: any) =>
        l && typeof l.offer_id === 'string' && typeof l.unit_paise === 'number' && typeof l.qty === 'number',
    );
  } catch {
    return [];
  }
}

export function writeCart(lines: CartLine[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(lines));
  } catch {
    /* a list is never worth an exception */
  }
}
