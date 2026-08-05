'use client';

import React from 'react';
import type { OfferView } from '@/lib/types';
import { Money, CertBadge, rupees } from './primitives';

type Key = 'vendor' | 'platform' | 'base' | 'gst' | 'delivery' | 'landed' | 'norm'
  | 'moq' | 'stock' | 'eta' | 'rating' | 'verified';

const COLS: Array<{ key: Key; label: string; align?: 'right'; w: number; title?: string }> = [
  { key: 'vendor', label: 'Vendor', w: 200 },
  { key: 'platform', label: 'Platform', w: 96 },
  { key: 'base', label: 'Seller price', align: 'right', w: 104, title: 'What the seller quotes, in the unit the seller quotes it in' },
  { key: 'gst', label: 'GST', w: 96, title: 'How the seller states tax, and at what rate' },
  { key: 'delivery', label: 'Delivery', align: 'right', w: 92, title: 'Freight + handling + loading, per canonical unit' },
  { key: 'landed', label: 'Landed', align: 'right', w: 104, title: 'base + GST + freight + handling + loading' },
  { key: 'norm', label: 'Per unit', align: 'right', w: 112, title: 'The landed price per canonical unit — the only figure computed identically for every seller' },
  { key: 'moq', label: 'MOQ', align: 'right', w: 84 },
  { key: 'stock', label: 'Stock', w: 86 },
  { key: 'eta', label: 'ETA', w: 82 },
  { key: 'rating', label: 'Rating', align: 'right', w: 80 },
  { key: 'verified', label: 'Verified', w: 96 },
];

/** Trailing spacer that carries the row's source link. */
const TAIL_W = 96;

/**
 * One source for every width.
 *
 * The body cells used to repeat each column's width as a second literal, so a
 * header and its column could drift apart silently — and the declared minWidth
 * had already drifted, sitting at 1240 against a real content width of 1328.
 * Derived here so a width can only be changed in one place.
 */
const W = (k: Key): number => COLS.find((c) => c.key === k)!.w;
const MIN_W = COLS.reduce((n, c) => n + c.w, 0) + TAIL_W;

const ROW_H = 40;

export default function VendorTable({
  offers, unit, onBreakdown, totalOffers, highlightVendorId,
}: {
  offers: OfferView[]; unit: string; onBreakdown: (o: OfferView) => void;
  totalOffers?: number;
  /** The seller whose card opened this sheet — their row is marked, never moved. */
  highlightVendorId?: string | null;
}) {
  const [sort, setSort] = React.useState<{ key: Key; dir: 1 | -1 }>({ key: 'norm', dir: 1 });
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [platform, setPlatform] = React.useState<string>('');
  const [stockOnly, setStockOnly] = React.useState(false);
  const [certOnly, setCertOnly] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);

  const platforms = React.useMemo(
    () => [...new Set(offers.map((o) => o.platform))].sort(), [offers],
  );

  const filtered = React.useMemo(() => {
    let x = offers;
    if (platform) x = x.filter((o) => o.platform === platform);
    if (stockOnly) x = x.filter((o) => o.stock_state !== 'out_of_stock');
    if (certOnly) x = x.filter((o) => o.cert_state === 'CERTIFIED' || o.cert_state === 'BRAND_LICENSED');
    const val = (o: OfferView): number | string => {
      switch (sort.key) {
        case 'vendor': return o.vendor.name.toLowerCase();
        case 'platform': return o.platform.toLowerCase();
        case 'base': return o.base_paise;
        case 'gst': return o.gst_treatment;
        case 'delivery': return o.freight_paise + o.handling_paise + o.loading_paise;
        case 'landed': return o.landed_paise;
        case 'norm': return o.normalised_paise;
        case 'moq': return o.moq_qty ?? Number.MAX_SAFE_INTEGER;
        case 'stock': return o.stock_state;
        case 'eta': return o.lead_time_days ?? 99;
        case 'rating': return -(o.rating ?? 0);
        case 'verified': return o.fetched_at;
      }
    };
    return [...x].sort((a, b) => {
      const A = val(a), B = val(b);
      if (A === B) return 0;
      return (A < B ? -1 : 1) * sort.dir;
    });
  }, [offers, sort, platform, stockOnly, certOnly]);

  // Virtualised so hundreds of rows stay smooth.
  const H = Math.min(440, Math.max(120, filtered.length * ROW_H));
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const visible = Math.ceil(H / ROW_H) + 12;
  const slice = filtered.slice(start, start + visible);
  const showFilters = offers.length >= 12;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        {/* Both numbers, because they differ: a seller can post the same bag
            three times. The table is one row per vendor; the offer count is
            what those rows rolled up, and every rolled-up listing is still
            reachable from its row. */}
        <p className="text-[12px]" style={{ color: 'var(--ink-2)' }}>
          <strong className="tnum" style={{ color: 'var(--ink)' }}>{totalOffers ?? filtered.length}</strong>
          {' '}offers from{' '}
          <strong className="tnum" style={{ color: 'var(--ink)' }}>{filtered.length}</strong>
          {filtered.length === offers.length ? '' : ` of ${offers.length}`} sellers — every vendor collected, none truncated.
        </p>
        {showFilters && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={platform} onChange={(e) => setPlatform(e.target.value)}
              className="field h-7 px-1.5 text-[11px]" aria-label="Filter by platform"
            >
              <option value="">All platforms</option>
              {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button onClick={() => setStockOnly((v) => !v)} aria-pressed={stockOnly}
              className="chip anim px-2 h-7 text-[11px]">in stock</button>
            <button onClick={() => setCertOnly((v) => !v)} aria-pressed={certOnly}
              className="chip anim px-2 h-7 text-[11px]">BIS on file</button>
          </div>
        )}
      </div>

      <div className="x-scroll glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ minWidth: MIN_W }}>
          {/* header */}
          <div className="flex sticky top-0 z-10 rule-b" style={{ background: 'var(--wash)' }}>
            {COLS.map((c) => (
              <button
                key={c.key}
                onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 1 ? -1 : 1 }))}
                title={c.title}
                className="px-2.5 py-2 text-[10px] uppercase tracking-[0.09em] anim hover:opacity-70 flex items-center gap-1"
                style={{
                  width: c.w, flexShrink: 0, color: sort.key === c.key ? 'var(--ink)' : 'var(--ink-3)',
                  justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
                }}
                aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              >
                {c.label}
                {sort.key === c.key && <span aria-hidden style={{ fontSize: 8 }}>{sort.dir === 1 ? '▲' : '▼'}</span>}
              </button>
            ))}
            <span style={{ width: TAIL_W, flexShrink: 0 }} />
          </div>

          <div
            ref={scrollRef}
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            className="scroll-thin"
            style={{ height: H, overflowY: 'auto', position: 'relative' }}
          >
            <div style={{ height: filtered.length * ROW_H, position: 'relative' }}>
              <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
                {slice.map((o) => {
                  const delivery = o.freight_paise + o.handling_paise + o.loading_paise;
                  const cell = 'px-2.5 text-[12px] flex items-center';
                  return (
                    <div key={o.offer_id} className="flex rule-soft-b anim hover:bg-[var(--accent-bg)]"
                      style={{
                        height: ROW_H, position: 'relative',
                        // Marked where it sorts, not lifted to the top: the
                        // table's order is the price comparison, and moving a
                        // row would misstate where this seller actually stands.
                        ...(o.vendor.vendor_id === highlightVendorId
                          ? { background: 'var(--wash)', boxShadow: 'inset 2px 0 0 var(--accent)' }
                          : null),
                      }}>
                      <div className={cell} style={{ width: W('vendor'), flexShrink: 0, gap: '6px' }}>
                        <span className="truncate" title={`${o.vendor.name}${o.vendor.locality ? ` — ${o.vendor.locality}` : ''}`}>
                          <span style={{ color: 'var(--ink)' }}>{o.vendor.name}</span>
                          {o.vendor.locality && (
                            <span className="ml-1.5 text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{o.vendor.locality}</span>
                          )}
                        </span>
                        {/* This seller posted the same product more than once.
                            The row shows their cheapest; this opens the rest,
                            each with the source URL it came from. */}
                        {!!o.also_listed?.length && (
                          <button
                            onClick={() => setExpanded((s) => {
                              const n = new Set(s);
                              n.has(o.offer_id) ? n.delete(o.offer_id) : n.add(o.offer_id);
                              return n;
                            })}
                            aria-expanded={expanded.has(o.offer_id)}
                            className="shrink-0 text-[10px] px-1 anim hover:opacity-70"
                            style={{ color: 'var(--accent)', border: '1px solid var(--rule)', borderRadius: '10px' }}
                            title={`${o.also_listed.length + 1} listings from this seller for this product`}
                          >
                            {o.also_listed.length + 1} listings {expanded.has(o.offer_id) ? '▾' : '▸'}
                          </button>
                        )}
                      </div>
                      {expanded.has(o.offer_id) && !!o.also_listed?.length && (
                        <div
                          className="absolute left-0 right-0 p-2.5 z-10 fade-up"
                          style={{
                            top: '100%', background: 'var(--glass-strong)',
                            border: '1px solid var(--rule)', borderRadius: '10px',
                            boxShadow: '0 8px 26px -6px rgba(0,8,11,.62)',
                          }}
                        >
                          <div className="text-[10px] uppercase tracking-[0.11em] mb-1.5" style={{ color: 'var(--ink-3)' }}>
                            also listed by {o.vendor.name} — rolled up, not discarded
                          </div>
                          {o.also_listed.map((al) => (
                            <div key={al.offer_id} className="flex items-baseline justify-between gap-3 py-[3px] text-[11px]">
                              <a href={al.source_url} target="_blank" rel="noopener noreferrer"
                                className="truncate anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                                style={{ color: 'var(--ink-2)' }}>
                                {al.listing_title ?? al.source_url}
                              </a>
                              <span className="fig shrink-0" style={{ color: 'var(--ink)' }}>
                                {rupees(al.base_paise)}<span className="opacity-55 text-[9px]">/{al.base_unit}</span>
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className={cell} style={{ width: W('platform'), flexShrink: 0, color: 'var(--ink-2)' }}>{o.platform}</div>
                      <div className={`${cell} justify-end`} style={{ width: W('base'), flexShrink: 0 }}>
                        <span className="fig" style={{ color: 'var(--ink-2)' }}>
                          {rupees(o.base_paise)}<span className="opacity-55 text-[9px]">/{o.base_unit}</span>
                        </span>
                      </div>
                      <div className={cell} style={{ width: W('gst'), flexShrink: 0 }}>
                        <span className="text-[10.5px]" style={{ color: 'var(--ink-3)' }}>
                          {o.gst_treatment === 'INCL' ? 'incl' : 'excl'} {(o.gst_rate_bp / 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className={`${cell} justify-end`} style={{ width: W('delivery'), flexShrink: 0 }}>
                        <button onClick={() => onBreakdown(o)} className="fig anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                          style={{ color: 'var(--ink-2)' }} title="Show how this delivery cost was computed">
                          {rupees(delivery)}
                        </button>
                      </div>
                      <div className={`${cell} justify-end`} style={{ width: W('landed'), flexShrink: 0 }}>
                        <span className="fig" style={{ color: 'var(--ink)' }}>{rupees(o.landed_paise)}</span>
                      </div>
                      <div className={`${cell} justify-end`} style={{ width: W('norm'), flexShrink: 0 }}>
                        <Money paise={o.normalised_paise} unit={unit} size="sm" />
                      </div>
                      <div className={`${cell} justify-end`} style={{ width: W('moq'), flexShrink: 0, color: 'var(--ink-2)' }}>
                        <span className="tnum text-[11.5px]">{o.moq_qty ? `${o.moq_qty}${o.moq_unit ? ' ' + o.moq_unit : ''}` : '—'}</span>
                      </div>
                      <div className={cell} style={{ width: W('stock'), flexShrink: 0 }}>
                        <span className="text-[11px]" style={{ color: o.stock_state === 'out_of_stock' ? 'var(--accent)' : 'var(--ink-3)' }}>
                          {o.stock_state === 'in_stock' ? 'in stock' : o.stock_state === 'out_of_stock' ? 'out' : o.stock_state === 'on_request' ? 'on request' : 'unknown'}
                        </span>
                      </div>
                      <div className={cell} style={{ width: W('eta'), flexShrink: 0, color: 'var(--ink-3)' }}>
                        <span className="text-[11px]">{o.lead_time_days == null ? '—' : o.lead_time_days <= 1 ? 'tomorrow' : `${o.lead_time_days} d`}</span>
                      </div>
                      <div className={`${cell} justify-end`} style={{ width: W('rating'), flexShrink: 0 }}>
                        <span className="tnum text-[11.5px]" style={{ color: 'var(--ink-2)' }}>
                          {o.rating ? `${o.rating.toFixed(1)}` : '—'}
                          {o.review_count ? <span className="opacity-55 ml-0.5">({o.review_count})</span> : null}
                        </span>
                      </div>
                      <div className={cell} style={{ width: W('verified'), flexShrink: 0 }}>
                        <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}
                          title={new Date(o.fetched_at).toLocaleString('en-IN')}>
                          {relative(o.fetched_at)}
                        </span>
                      </div>
                      <div className="px-2.5 flex items-center gap-1.5" style={{ width: TAIL_W, flexShrink: 0 }}>
                        <CertBadge state={o.cert_state} compact />
                        <a href={o.source_url} target="_blank" rel="noreferrer noopener"
                          className="anim hover:opacity-70" style={{ color: 'var(--ink-3)' }} title="Open the source listing">
                          <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
                            <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
                              fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                          </svg>
                        </a>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>
        Sorted on <strong>{COLS.find((c) => c.key === sort.key)?.label}</strong>. Every row is normalised to the same
        basis — delivered to your pincode, inclusive of GST, per {unit.replace('_', ' ')} — which is the only
        condition under which two sellers' prices are the same kind of number.
      </p>
    </div>
  );
}

function relative(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} d ago`;
}
