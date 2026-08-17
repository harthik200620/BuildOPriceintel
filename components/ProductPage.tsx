'use client';

import React from 'react';
import { Money, FreshnessDot, rupees } from './primitives';
import { clampQty, MAX_QTY } from '@/lib/cart';
import { IconPlus, IconMinus, IconCheck, IconStar, IconChevronRight } from './icons';

/**
 * One product, in full — the screen the detail sheet used to be, given a URL.
 *
 * What it does NOT invent is the point. A storefront puts a star rating and a
 * "bestseller" flag here; this catalogue holds neither for most products, so
 * the stars render only where a source actually published a rating, and the
 * badge above the price is a measured fact — the lowest landed price among the
 * sellers who have this — rather than a merchandising label.
 *
 * "Add to estimate" is the honest form of add-to-cart: it puts this seller's
 * offer and a quantity on a list that prices a whole order. Nothing is ordered
 * and nothing is paid for here.
 */

interface Props {
  productId: string;
  pincode: string;
  onBack: () => void;
  onAdd: (line: {
    offer_id: string; product_id: string; title: string; vendor: string; vendor_id: string;
    image: string | null; unit: string; unit_paise: number; gst_rate_bp: number; qty: number; moq_qty: number | null;
  }) => void;
  inList: (offerId: string) => boolean;
  onOpenList: () => void;
}

export default function ProductPage({ productId, pincode, onBack, onAdd, inList, onOpenList }: Props) {
  const [data, setData] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [shot, setShot] = React.useState(0);
  const [qty, setQty] = React.useState(1);
  const [sellersOpen, setSellersOpen] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    setData(null); setErr(null); setShot(0);
    fetch(`/api/sku/${encodeURIComponent(productId)}?pincode=${pincode}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error ?? r.statusText)))))
      .then((j) => { if (live) setData(j); })
      .catch((e) => { if (live) setErr(String(e.message ?? e)); });
    return () => { live = false; };
  }, [productId, pincode]);

  const p = data?.product;
  const price = data?.price;
  const offers: any[] = data?.offers ?? [];
  const best = offers[0] ?? null;
  const moq: number | null = best?.moq_qty ?? null;

  // The seller's minimum is not known until the fetch lands, so the opening
  // quantity is corrected once rather than left below a floor the seller set.
  React.useEffect(() => { setQty((q) => clampQty(q, moq)); }, [moq]);

  const images: string[] = React.useMemo(() => {
    const l = (data?.images ?? []).map((i: any) => i.local_path).filter(Boolean);
    return l.length ? l : p?.image_url ? [p.image_url] : [];
  }, [data, p]);

  /** The typed attributes, as the reference's highlight checklist. */
  const highlights: string[] = React.useMemo(() => {
    const out: string[] = [];
    const a = p?.attrs ?? {};
    for (const [k, v] of Object.entries(a)) {
      if (k.startsWith('_') || v === null || v === '' || v === undefined) continue;
      out.push(`${k.replace(/_/g, ' ')}: ${v}`);
      if (out.length === 5) break;
    }
    for (const s of p?.cert_standards ?? []) if (out.length < 6) out.push(String(s));
    return out;
  }, [p]);

  if (err) {
    return (
      <div className="py-16 text-center fade-up">
        <p className="text-[14px]" style={{ color: 'var(--ink)' }}>This product is not in the catalogue.</p>
        <button onClick={onBack} className="btn-ghost h-10 px-5 text-[13px] mt-4">Go back</button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="fade-up">
        <div className="skel" style={{ aspectRatio: '1 / 1', borderRadius: 'var(--radius-lg)' }} />
        <div className="skel h-5 w-3/4 mt-4" /><div className="skel h-9 w-1/2 mt-3" />
      </div>
    );
  }

  const added = best ? inList(best.offer_id) : false;
  const rating: number | null = best?.rating ?? null;
  const reviews: number | null = best?.review_count ?? null;

  return (
    <div className="fade-up">
      <figure className="pdp-figure">
        {images.length ? (
          <img src={images[shot]} alt={p.title} />
        ) : (
          <div className="grid place-items-center w-full h-full text-[12px]" style={{ color: 'var(--ink-3)' }}>
            No photograph collected
          </div>
        )}
      </figure>

      {images.length > 1 && (
        <div className="pdp-dots mt-3" role="group" aria-label="Photographs">
          {images.slice(0, 6).map((src, i) => (
            <button
              key={src}
              className="pdp-dot anim"
              aria-current={i === shot}
              aria-label={`Photograph ${i + 1} of ${Math.min(images.length, 6)}`}
              onClick={() => setShot(i)}
            />
          ))}
        </div>
      )}

      <h1 className="text-[17px] leading-[1.3] mt-4" style={{ color: 'var(--ink)' }}>{p.title}</h1>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
        {rating != null && (
          <span className="flex items-center gap-1.5" aria-label={`Rated ${rating} out of 5`}>
            <span className="flex" style={{ color: 'var(--accent)' }}>
              {[0, 1, 2, 3, 4].map((i) => <IconStar key={i} lit={Math.max(0, Math.min(1, rating - i))} size={13} />)}
            </span>
            <span className="fig text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {rating.toFixed(1)}{reviews != null && ` (${reviews.toLocaleString('en-IN')})`}
            </span>
          </span>
        )}
        {p.brand && (
          <span className="text-[11.5px] uppercase" style={{ color: 'var(--ink-3)', letterSpacing: '.1em' }}>{p.brand}</span>
        )}
        {price && (
          <FreshnessDot dot={price.freshness_dot} label={price.freshness_label} exact={price.freshness_exact} />
        )}
      </div>

      {price ? (
        <>
          {/* Measured, not merchandised: this is the cheapest landed price among
              the sellers who carry it, which is a fact the listing can prove. */}
          {data.total_vendors > 1 && (
            <span className="inline-block text-[10px] uppercase mt-3.5 px-2 py-[3px]"
              style={{
                color: 'var(--accent-ink)', letterSpacing: '.12em',
                border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius-pill)', background: 'var(--accent-bg)',
              }}>
              lowest of {data.total_vendors} sellers
            </span>
          )}

          <div className="mt-2.5">
            <Money paise={price.normalised_paise} unit={price.normalised_unit} size="hero" accent />
          </div>
          <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--ink-3)' }}>
            Delivered to {pincode}, incl. {(p.gst_rate_bp / 100).toFixed(0)}% GST
            {price.offer_count > 1 && <> · {rupees(price.floor_paise, true)}–{rupees(price.ceiling_paise, true)} across {price.offer_count} offers</>}
          </p>

          <div className="mt-5">
            <h2 className="text-[11px] uppercase" style={{ color: 'var(--ink-3)', letterSpacing: '.14em' }}>Quantity</h2>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="qty" role="group" aria-label={`Quantity in ${price.normalised_unit}`}>
                <button onClick={() => setQty((q) => clampQty(q - 1, moq))} disabled={qty <= Math.max(1, Math.ceil(moq ?? 1))} aria-label="One fewer" className="anim">
                  <IconMinus size={15} />
                </button>
                <span className="qty-val fig" aria-live="polite">{qty} <span style={{ color: 'var(--ink-3)' }}>{price.normalised_unit}</span></span>
                <button onClick={() => setQty((q) => clampQty(q + 1, moq))} disabled={qty >= MAX_QTY} aria-label="One more" className="anim">
                  <IconPlus size={15} />
                </button>
              </div>
              <span className="fig text-[15px]" style={{ color: 'var(--ink)' }}>
                {rupees(price.normalised_paise * qty)}
              </span>
            </div>
            {moq != null && moq > 1 && (
              <p className="text-[11px] mt-2" style={{ color: 'var(--ink-3)' }}>
                This seller&rsquo;s minimum is {moq} {price.normalised_unit}.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-[13px] mt-4" style={{ color: 'var(--ink-2)' }}>
          No current price — every offer for this product is past its refresh window.
        </p>
      )}

      {highlights.length > 0 && (
        <section className="mt-6">
          <h2 className="text-[11px] uppercase mb-2.5" style={{ color: 'var(--ink-3)', letterSpacing: '.14em' }}>
            Product highlights
          </h2>
          <ul className="flex flex-col gap-2">
            {highlights.map((h) => (
              <li key={h} className="flex items-start gap-2.5 text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
                <IconCheck size={15} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1 }} />
                <span className="first-letter:uppercase">{h}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {best && (
        <section className="mt-6 glass-card p-3.5" style={{ borderRadius: 'var(--radius-glass)' }}>
          <h2 className="text-[11px] uppercase" style={{ color: 'var(--ink-3)', letterSpacing: '.14em' }}>Sold by</h2>
          <p className="text-[13.5px] mt-1.5" style={{ color: 'var(--ink)' }}>{best.vendor?.name ?? best.vendor_name}</p>
          {(best.vendor?.locality || best.platform) && (
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
              {[best.vendor?.locality, best.platform].filter(Boolean).join(' · ')}
            </p>
          )}

          {/* Every other seller of this product, at their own price. The API
              already returned them rolled up by vendor, so this opens what is
              in hand rather than sending the buyer to a search that would have
              to find its way back to the same rows. */}
          {offers.length > 1 && (
            <>
              <button
                onClick={() => setSellersOpen((v) => !v)}
                aria-expanded={sellersOpen}
                className="anim mt-2.5 inline-flex items-center gap-1 text-[12.5px] min-h-8"
                style={{ color: 'var(--accent)' }}
              >
                {sellersOpen ? 'Hide the other sellers' : `See all ${data.total_vendors} sellers`}
                <IconChevronRight size={13} style={{ transform: sellersOpen ? 'rotate(90deg)' : undefined }} />
              </button>
              {sellersOpen && (
                <ul className="mt-2 fade-up">
                  {offers.map((o: any, i: number) => (
                    <li key={o.offer_id ?? i} className={`flex items-baseline justify-between gap-3 py-2 ${i > 0 ? 'rule-t' : ''}`}>
                      <span className="min-w-0">
                        <span className="text-[12.5px] block truncate" style={{ color: 'var(--ink)' }}>
                          {o.vendor?.name ?? o.vendor_name ?? 'Seller'}
                        </span>
                        {o.vendor?.locality && (
                          <span className="text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{o.vendor.locality}</span>
                        )}
                      </span>
                      <span className="fig text-[13px] shrink-0" style={{ color: i === 0 ? 'var(--accent)' : 'var(--ink-2)' }}>
                        {rupees(o.normalised_paise, o.normalised_paise < 10_000)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      <div className="mt-6 flex flex-col gap-2.5">
        <button
          className="btn-primary h-12 w-full text-[14px]"
          disabled={!best || !price}
          onClick={() => {
            if (!best || !price) return;
            onAdd({
              offer_id: best.offer_id,
              product_id: p.product_id,
              title: p.title,
              vendor: best.vendor?.name ?? best.vendor_name ?? 'Seller',
              vendor_id: best.vendor?.vendor_id ?? best.vendor_id ?? '',
              image: images[0] ?? null,
              unit: price.normalised_unit,
              unit_paise: price.normalised_paise,
              gst_rate_bp: p.gst_rate_bp,
              qty,
              moq_qty: moq,
            });
          }}
        >
          {added ? 'Update the estimate' : 'Add to estimate'}
        </button>
        <button className="btn-ghost h-12 w-full text-[14px]" onClick={onOpenList}>
          View the estimate
        </button>
      </div>

      <p className="text-[11px] leading-[1.5] mt-4" style={{ color: 'var(--ink-3)' }}>
        Build Objects holds no stock and takes no payment. This is the price this seller
        published, landed at {pincode} — confirm it with them before you order.
      </p>
    </div>
  );
}
