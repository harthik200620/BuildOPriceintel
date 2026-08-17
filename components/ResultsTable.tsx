'use client';

/**
 * The results, as a sortable table.
 *
 * Two rules make this honest rather than merely dense:
 *
 * 1. **Sorting is server-side.** A header click changes `col`/`dir` on the
 *    query and refetches. The alternative — sorting the 24 rows the client is
 *    holding — reorders the window rather than the result, so page 2 would
 *    disagree with page 1 and the sort dropdown would disagree with the header.
 *
 * 2. **Every column states its own coverage.** A column populated on 9% of rows
 *    says "9%" in its header. Without that, a mostly-empty column reads as a
 *    broken feature instead of an honest measurement of what sellers publish —
 *    which is the same reason a facet with no data ships disabled with a reason
 *    rather than being quietly dropped.
 */

import { useMemo, useRef, useState } from 'react';
import type { ProductCard } from '@/lib/types';
import { Money, rupees, FreshnessDot, CertBadge, UNIT_LABEL } from './primitives';
import { DAMPED } from './CardGallery';

const ROW_H = 44;

export interface ColumnDef {
  /** Matches a key in COLUMN_SORTS on the server; null means not sortable. */
  key: string | null;
  id: string;
  label: string;
  w: number;
  align?: 'left' | 'right';
  /** Categories this column is meaningful for. Absent = all. */
  only?: string[];
  /** In the default 14, or behind "More columns". */
  core?: boolean;
  render: (c: ProductCard) => React.ReactNode;
  /** For the coverage figure in the header. */
  has: (c: ProductCard) => boolean;
}

const dash = <span style={{ color: 'var(--ink-3)' }}>—</span>;
const txt = (v: unknown) => (v === null || v === undefined || v === '' ? dash : String(v));
const attr = (c: ProductCard, k: string) => c.attrs?.[k] ?? null;

export const COLUMNS: ColumnDef[] = [
  {
    key: null, id: 'photo', label: '', w: 44, core: true,
    has: (c) => !!c.images?.length,
    render: (c) => (c.images?.[0]
      ? <img src={c.images[0]} alt="" width={30} height={30} loading="lazy"
          style={{ width: 30, height: 30, objectFit: 'cover', borderRadius: 4, background: 'var(--glass-quiet)', filter: DAMPED }} />
      : <span style={{ width: 30, height: 30, borderRadius: 4, background: 'var(--glass-quiet)', display: 'block' }} />),
  },
  {
    key: 'seller', id: 'seller', label: 'Seller', w: 190, core: true,
    has: () => true,
    render: (c) => (
      <span className="truncate" title={c.best_vendor}>
        <span style={{ color: 'var(--ink)' }}>{c.best_vendor}</span>
        {c.vendor_locality && <span className="ml-1.5 text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{c.vendor_locality}</span>}
      </span>
    ),
  },
  {
    key: 'platform', id: 'platform', label: 'Platform', w: 104, core: true,
    has: () => true, render: (c) => <span className="truncate">{c.platform}</span>,
  },
  {
    key: 'product', id: 'product', label: 'Product', w: 240, core: true,
    has: () => true,
    render: (c) => <span className="truncate" title={c.listing_title ?? c.title}>{c.title}</span>,
  },
  {
    key: 'brand', id: 'brand', label: 'Brand', w: 116, core: true,
    has: (c) => !!c.brand, render: (c) => txt(c.brand),
  },

  // ── category-specific spec columns ────────────────────────────────────────
  { key: 'cement_type', id: 'cement_type', label: 'Type', w: 74, only: ['cement'], core: true, has: (c) => attr(c, 'cement_type') != null, render: (c) => txt(attr(c, 'cement_type')) },
  { key: 'opc_grade', id: 'opc_grade', label: 'Grade', w: 82, only: ['cement'], core: true, has: (c) => attr(c, 'opc_grade') != null, render: (c) => txt(attr(c, 'opc_grade')) },
  { key: 'pack_size_kg', id: 'pack_size_kg', label: 'Pack', w: 70, align: 'right', only: ['cement'], has: (c) => attr(c, 'pack_size_kg') != null, render: (c) => (attr(c, 'pack_size_kg') != null ? `${attr(c, 'pack_size_kg')} kg` : dash) },
  { key: 'diameter_mm', id: 'diameter_mm', label: 'Dia', w: 68, align: 'right', only: ['tmt_steel'], core: true, has: (c) => attr(c, 'diameter_mm') != null, render: (c) => (attr(c, 'diameter_mm') != null ? `${attr(c, 'diameter_mm')} mm` : dash) },
  { key: 'pipe_system', id: 'pipe_system', label: 'System', w: 96, only: ['water_pipes'], core: true, has: (c) => attr(c, 'pipe_system') != null, render: (c) => txt(attr(c, 'pipe_system')) },
  { key: 'nominal_bore_mm', id: 'nominal_bore_mm', label: 'Bore', w: 72, align: 'right', only: ['water_pipes'], core: true, has: (c) => attr(c, 'nominal_bore_mm') != null, render: (c) => (attr(c, 'nominal_bore_mm') != null ? `${attr(c, 'nominal_bore_mm')} mm` : dash) },
  { key: 'block_type', id: 'block_type', label: 'Block type', w: 150, only: ['bricks_blocks'], core: true, has: (c) => attr(c, 'block_type') != null, render: (c) => txt(attr(c, 'block_type')) },
  { key: 'size_mm', id: 'size_mm', label: 'Size', w: 120, only: ['bricks_blocks'], has: (c) => attr(c, 'size_mm') != null, render: (c) => txt(attr(c, 'size_mm')) },
  { key: 'density_kg_m3', id: 'density_kg_m3', label: 'Density', w: 86, align: 'right', only: ['bricks_blocks'], has: (c) => attr(c, 'density_kg_m3') != null, render: (c) => (attr(c, 'density_kg_m3') != null ? `${attr(c, 'density_kg_m3')}` : dash) },
  { key: 'length_m', id: 'length_m', label: 'Length', w: 76, align: 'right', only: ['water_pipes', 'tmt_steel'], has: (c) => attr(c, 'length_m') != null, render: (c) => (attr(c, 'length_m') != null ? `${attr(c, 'length_m')} m` : dash) },

  // ── money ─────────────────────────────────────────────────────────────────
  {
    key: 'unit_price', id: 'unit_price', label: 'Unit price', w: 126, align: 'right', core: true,
    has: () => true,
    // One face down the whole column. `accent` used to be passed here on
    // freshness, which switched between .hero-figure (the display serif) and
    // .fig (the figure face) at 13px inside one 126px right-aligned column —
    // roughly a 37% difference in advance width between adjacent rows, in the
    // one column that exists to be read down its decimal. tabular-nums aligns
    // digits *within* a face; it cannot align two.
    //
    // It also never passed `stale`, so a dead price rendered unstruck here
    // while ProductCard struck it. Both are fixed by the same swap.
    render: (c) => (
      <Money
        paise={c.normalised_paise} unit={c.unit_canonical} size="sm"
        stale={c.freshness_state === 'STALE' || c.freshness_state === 'EXPIRED'}
      />
    ),
  },
  { key: 'landed', id: 'landed', label: 'Landed', w: 100, align: 'right', core: true, has: () => true, render: (c) => <span className="fig">{rupees(c.landed_paise, false)}</span> },
  { key: null, id: 'unit', label: 'Unit', w: 92, core: true, has: () => true, render: (c) => <span style={{ color: 'var(--ink-3)' }}>{UNIT_LABEL[c.unit_canonical] ?? c.unit_canonical}</span> },
  { key: 'gst', id: 'gst', label: 'GST', w: 92, core: true, has: () => true, render: (c) => <span className="fig">{(c.gst_rate_bp / 100).toFixed(0)}% <span style={{ color: 'var(--ink-3)' }}>{c.gst_treatment === 'INCL' ? 'incl' : 'excl'}</span></span> },
  { key: 'floor', id: 'floor', label: 'Lowest', w: 96, align: 'right', has: () => true, render: (c) => <span className="fig">{rupees(c.floor_paise, false)}</span> },
  { key: 'median', id: 'median', label: 'Median', w: 96, align: 'right', has: () => true, render: (c) => <span className="fig">{rupees(c.median_paise, false)}</span> },
  { key: 'mrp', id: 'mrp', label: 'MRP', w: 96, align: 'right', has: (c) => c.mrp_paise != null, render: (c) => (c.mrp_paise != null ? <span className="fig">{rupees(c.mrp_paise, false)}</span> : dash) },

  // ── commercial ────────────────────────────────────────────────────────────
  {
    key: 'moq', id: 'moq', label: 'MOQ', w: 104, align: 'right', core: true,
    has: (c) => c.moq_qty != null,
    render: (c) => (c.moq_qty != null
      ? <span className="fig">{c.moq_qty}<span className="ml-1 text-[10.5px]" style={{ color: 'var(--ink-3)' }}>{c.moq_unit ?? ''}</span></span>
      : dash),
  },
  {
    key: 'rating', id: 'rating', label: 'Rating', w: 92, align: 'right', core: true,
    has: (c) => c.rating != null,
    render: (c) => (c.rating != null
      ? <span className="fig">{c.rating.toFixed(1)}<span className="ml-1 text-[10.5px]" style={{ color: 'var(--ink-3)' }}>({c.review_count ?? 0})</span></span>
      : dash),
  },
  { key: 'cert', id: 'cert', label: 'BIS', w: 84, core: true, has: () => true, render: (c) => <CertBadge state={c.cert_state} qco={c.qco_regulated} compact /> },
  {
    key: 'verified', id: 'verified', label: 'Verified', w: 116, core: true,
    has: () => true,
    render: (c) => <FreshnessDot dot={c.freshness_dot} label={c.freshness_label} exact={c.priced_as_of} />,
  },
  { key: 'eta', id: 'eta', label: 'ETA', w: 84, has: (c) => c.lead_time_days != null, render: (c) => (c.lead_time_days == null ? dash : c.lead_time_days <= 1 ? 'tomorrow' : `${c.lead_time_days} d`) },
  { key: 'sellers', id: 'sellers', label: 'Sellers', w: 78, align: 'right', has: () => true, render: (c) => <span className="fig">{c.vendor_count}</span> },
  { key: 'offers', id: 'offers', label: 'Offers', w: 76, align: 'right', has: () => true, render: (c) => <span className="fig">{c.offer_count}</span> },
  { key: 'origin', id: 'origin', label: 'Origin', w: 96, has: (c) => !!c.country_of_origin, render: (c) => txt(c.country_of_origin) },
  { key: 'supply_type', id: 'supply_type', label: 'Supply', w: 108, has: (c) => attr(c, 'supply_type') != null, render: (c) => txt(attr(c, 'supply_type')) },
  { key: 'trade_type', id: 'trade_type', label: 'Trade', w: 92, has: (c) => attr(c, 'trade_type') != null, render: (c) => txt(attr(c, 'trade_type')) },
  { key: 'material', id: 'material', label: 'Material', w: 110, has: (c) => attr(c, 'material') != null, render: (c) => txt(attr(c, 'material')) },
  { key: 'color', id: 'color', label: 'Colour', w: 92, has: (c) => attr(c, 'color') != null, render: (c) => txt(attr(c, 'color')) },
  { key: 'hsn', id: 'hsn', label: 'HSN', w: 84, has: () => true, render: (c) => <span className="fig">{c.hsn}</span> },
  { key: 'score', id: 'score', label: 'Match', w: 78, align: 'right', has: () => true, render: (c) => <span className="fig">{c.score.toFixed(2)}</span> },
  {
    key: null, id: 'source', label: 'Source', w: 74,
    has: () => true,
    render: (c) => (
      <a href={c.source_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
        className="anim hover:opacity-70 pointer-events-auto" style={{ color: 'var(--accent)' }} title={c.source_url}>
        listing ↗
      </a>
    ),
  },
];

const DEFAULT_ON = new Set(COLUMNS.filter((c) => c.core).map((c) => c.id));

export default function ResultsTable({
  cards, category, sortKey, sortDir, onSort, onOpen, total,
}: {
  cards: ProductCard[];
  category: string | null;
  sortKey: string | null;
  sortDir: 'asc' | 'desc';
  onSort: (key: string) => void;
  onOpen: (c: ProductCard) => void;
  total: number;
}) {
  const [visible, setVisible] = useState<Set<string>>(() => new Set(DEFAULT_ON));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // A spec column for a category you are not looking at would be empty for
  // every row, so it is not offered at all rather than offered and blank.
  const applicable = useMemo(
    () => COLUMNS.filter((c) => !c.only || (category && c.only.includes(category))),
    [category],
  );
  const cols = useMemo(() => applicable.filter((c) => visible.has(c.id)), [applicable, visible]);
  const minWidth = cols.reduce((n, c) => n + c.w, 0) + 16;

  // Coverage is measured over the rows actually on screen, and says so — it is
  // the share of THIS result set that publishes the field, not a global claim.
  const coverage = useMemo(() => {
    const m = new Map<string, number>();
    if (!cards.length) return m;
    for (const c of applicable) m.set(c.id, cards.filter(c.has).length / cards.length);
    return m;
  }, [cards, applicable]);

  const H = Math.max(200, Math.min(cards.length * ROW_H + 4, 620));
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const slice = cards.slice(start, start + Math.ceil(H / ROW_H) + 12);

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
          {cards.length === total
            ? <>All <span className="fig">{total}</span> sellers</>
            : <><span className="fig">{cards.length}</span> of <span className="fig">{total}</span> sellers</>}
          {' '}· click a column to sort every matching result, not just what is loaded
        </p>
        <div className="relative">
          <button onClick={() => setPickerOpen((v) => !v)} aria-expanded={pickerOpen}
            className="chip anim px-2.5 h-7 text-[11.5px]">
            Columns <span style={{ color: 'var(--ink-3)' }}>{cols.length}</span>
          </button>
          {pickerOpen && (
            <div className="absolute right-0 mt-1 z-30 glass-strong rule p-3 scroll-thin"
              style={{ width: 260, maxHeight: 340, overflowY: 'auto', borderRadius: 12 }}>
              <p className="text-[10px] uppercase tracking-[0.1em] mb-2" style={{ color: 'var(--ink-3)' }}>
                Columns · % is how many of these results publish it
              </p>
              {applicable.filter((c) => c.label).map((c) => {
                const cov = coverage.get(c.id) ?? 0;
                return (
                  <label key={c.id} className="check-row anim py-1">
                    <input
                      type="checkbox" className="check" checked={visible.has(c.id)}
                      onChange={() => setVisible((s) => {
                        const n = new Set(s);
                        n.has(c.id) ? n.delete(c.id) : n.add(c.id);
                        return n;
                      })}
                    />
                    <span className="flex-1">{c.label}</span>
                    <span className="fig text-[10.5px]" style={{ color: cov === 0 ? 'var(--stale)' : 'var(--ink-3)' }}>
                      {(cov * 100).toFixed(0)}%
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="x-scroll glass-card" style={{ overflow: 'hidden' }}>
        <div style={{ minWidth }}>
          <div className="flex sticky top-0 z-10 rule-b" style={{ background: 'var(--wash)' }}>
            {cols.map((c) => {
              const active = c.key && sortKey === c.key;
              const cov = coverage.get(c.id) ?? 0;
              const inner = (
                <>
                  <span className="truncate">{c.label}</span>
                  {active && <span aria-hidden style={{ fontSize: 8 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
                  {/* Only shown when a field is genuinely patchy — a 100% column
                      needs no annotation and the noise would drown the ones
                      that do. */}
                  {c.label && cov > 0 && cov < 0.9 && (
                    <span className="fig text-[9px]" style={{ color: 'var(--ink-3)' }}>{(cov * 100).toFixed(0)}%</span>
                  )}
                </>
              );
              const style: React.CSSProperties = {
                width: c.w, flexShrink: 0,
                color: active ? 'var(--ink)' : 'var(--ink-3)',
                justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start',
              };
              const cls = 'px-2.5 py-2 text-[10px] uppercase tracking-[0.09em] flex items-center gap-1';
              return c.key ? (
                <button
                  key={c.id} onClick={() => onSort(c.key!)} className={`${cls} anim hover:opacity-70`}
                  style={style}
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  // Spelt out rather than left to the visible label: the header
                  // is a control, and "Brand" alone does not tell a screen-reader
                  // user that activating it re-sorts, nor which way it will go.
                  aria-label={
                    `Sort by ${c.label}` +
                    (active ? `, currently ${sortDir === 'asc' ? 'ascending' : 'descending'}` : '') +
                    (cov < 1 ? `. ${(cov * 100).toFixed(0)}% of these results publish it` : '')
                  }
                  title={cov < 1 ? `${(cov * 100).toFixed(0)}% of these results publish this` : undefined}>
                  {inner}
                </button>
              ) : (
                <span key={c.id} className={cls} style={style}>{inner}</span>
              );
            })}
          </div>

          <div ref={scrollRef} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
            className="scroll-thin" style={{ height: H, overflowY: 'auto', position: 'relative' }}>
            <div style={{ height: cards.length * ROW_H, position: 'relative' }}>
              <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
                {slice.map((c) => (
                  <div
                    key={c.offer_id}
                    onClick={() => onOpen(c)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(c); } }}
                    role="button" tabIndex={0}
                    className="flex rule-soft-b anim hover:bg-[var(--accent-bg)] cursor-pointer"
                    style={{ height: ROW_H }}
                  >
                    {cols.map((col) => (
                      <div key={col.id} className="px-2.5 text-[12px] flex items-center"
                        style={{
                          width: col.w, flexShrink: 0, minWidth: 0,
                          justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
                        }}>
                        {col.render(c)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
