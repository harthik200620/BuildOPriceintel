'use client';

import React from 'react';
import type { FacetView } from '@/lib/types';
import { IconClose, IconFilter } from '@/components/icons';

interface FacetProps {
  facets: FacetView[];
  selections: Record<string, string[]>;
  onToggle: (facetId: string, value: string, single: boolean) => void;
}

/**
 * The facets themselves — shared by the desktop rail and the phone sheet, so a
 * filter behaves identically whichever surface it is on. The rail and the
 * sheet only differ in where they sit and how they close.
 */
export function FacetList({ facets, selections, onToggle }: FacetProps) {
  const [openMore, setOpenMore] = React.useState(false);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  const primary = facets.filter((f) => f.visibility === 'primary');
  // A conditional facet does not render before its parent value is chosen —
  // showing SDR-11 next to Class 4 lets a buyer express an impossible
  // requirement, and the panel let them.
  const conditional = facets.filter((f) => f.visibility === 'conditional' && f.active);
  const more = facets.filter((f) => f.visibility === 'more');

  const renderFacet = (f: FacetView, isConditional = false) => {
    const isOpen = open[f.facet_id] ?? f.default_open;
    const sel = selections[f.facet_id] ?? [];
    const anyLive = f.values.some((v) => v.count > 0);

    return (
      <section key={f.facet_id} className="py-3 rule-soft-b last:border-0">
        <button
          onClick={() => setOpen((o) => ({ ...o, [f.facet_id]: !isOpen }))}
          className="w-full flex items-baseline justify-between gap-2 text-left group"
          aria-expanded={isOpen}
        >
          <span className="flex items-baseline gap-1.5 min-w-0">
            <span className="text-[11px] uppercase tracking-[0.11em]" style={{ color: isConditional ? 'var(--accent)' : 'var(--ink-2)' }}>
              {f.label}
            </span>
            {sel.length > 0 && <span className="text-[10px] tnum" style={{ color: 'var(--accent)' }}>{sel.length}</span>}
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden className="shrink-0 anim"
            style={{ color: 'var(--ink-3)', transform: isOpen ? 'rotate(180deg)' : 'none' }}>
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        {isConditional && f.depends_on && (
          <p className="mt-1 text-[10px] italic" style={{ color: 'var(--ink-3)' }}>
            shown because {f.depends_on.facet.replace(/_/g, ' ')} = {f.depends_on.value}
          </p>
        )}
        {f.default_state === 'off' && isOpen && (
          <p className="mt-1 text-[10px]" style={{ color: 'var(--ink-3)' }}>
            Off by default — this labels, it never hides.
          </p>
        )}
        {f.needs_verification && isOpen && (
          <p className="mt-1.5 text-[10px] leading-snug px-1.5 py-1"
            style={{ color: 'var(--ageing)', border: '1px solid color-mix(in srgb, var(--ageing) 52%, transparent)' }}
            title={f.needs_verification}>
            ⚑ regulatory claim needs verification
          </p>
        )}

        {isOpen && (
          <ul className="mt-2 space-y-0.5">
            {f.values.map((v) => {
              const checked = sel.some((s) => s.toLowerCase() === v.label.toLowerCase());
              const single = f.control === 'radio';
              return (
                <li key={v.label}>
                  {/* min-h-8 rather than py-[3px]: on a phone this row is the
                      whole filter interaction and a 16 px box inside a 22 px
                      row was the smallest target on the page. */}
                  <label
                    className="facet-val flex items-center gap-2.5 py-[3px] min-h-8 cursor-pointer group"
                    data-disabled={v.disabled && !checked}
                    title={v.disabled && !checked ? 'No offers match this in your area right now' : undefined}
                  >
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={single ? f.facet_id : undefined}
                      checked={checked}
                      disabled={v.disabled && !checked}
                      onChange={() => onToggle(f.facet_id, v.label, single)}
                      className="check shrink-0"
                      style={single ? { borderRadius: '999px' } : undefined}
                    />
                    <span className="flex-1 min-w-0 text-[13px] leading-snug" style={{ color: checked ? 'var(--ink)' : 'var(--ink-2)' }}>
                      {v.label}
                      {v.sublabel && <span className="ml-1 text-[11px]" style={{ color: 'var(--ink-3)' }}>{v.sublabel}</span>}
                    </span>
                    {/* Counts animate with no layout shift — fixed-width column. */}
                    <span className="tnum text-[11px] w-8 text-right shrink-0 anim" style={{ color: 'var(--ink-3)' }}>
                      {v.count}
                    </span>
                  </label>
                </li>
              );
            })}
            {!anyLive && (
              <li className="text-[11px] italic pt-1" style={{ color: 'var(--ink-3)' }}>
                nothing in this category matches yet
              </li>
            )}
          </ul>
        )}
      </section>
    );
  };

  return (
    <>
      {conditional.map((f) => renderFacet(f, true))}
      {primary.map((f) => renderFacet(f))}

      {more.length > 0 && (
        <div className="pt-2">
          <button
            onClick={() => setOpenMore((v) => !v)}
            className="w-full text-left text-[11px] uppercase tracking-[0.11em] py-2 anim hover:opacity-70"
            style={{ color: 'var(--ink-3)' }}
            aria-expanded={openMore}
          >
            {openMore ? '− ' : '+ '}More filters ({more.length})
          </button>
          {openMore && <div>{more.map((f) => renderFacet(f))}</div>}
        </div>
      )}
    </>
  );
}

/** The desktop rail. Sticky beside the results; a chip when collapsed. */
export default function FilterRail({
  facets, selections, onToggle, onClear, collapsed, onCollapse, total,
}: FacetProps & {
  onClear: () => void;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  total: number;
}) {
  const activeCount = Object.values(selections).flat().length;

  if (collapsed) {
    return (
      <button
        onClick={() => onCollapse(false)}
        className="chip anim sticky top-[84px] h-9 px-3 text-[12px] hidden lg:flex items-center gap-2 self-start"
        aria-label="Show filters"
      >
        <IconFilter size={13} />
        Filters{activeCount ? ` (${activeCount})` : ''}
      </button>
    );
  }

  return (
    <aside className="w-[280px] shrink-0 hidden lg:block">
      <div className="sticky top-[84px] max-h-[calc(100vh-104px)] overflow-y-auto scroll-thin glass-card px-4 py-3">
        <div className="flex items-baseline justify-between pb-2 rule-b">
          <h2 className="display text-[15px]">Narrow by</h2>
          <div className="flex items-center gap-2">
            {activeCount > 0 && (
              <button onClick={onClear} className="text-[11px] anim hover:opacity-70" style={{ color: 'var(--accent)' }}>
                clear {activeCount}
              </button>
            )}
            <button onClick={() => onCollapse(true)} className="anim hover:opacity-70" aria-label="Hide filters"
              style={{ color: 'var(--ink-3)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden>
                <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        {/* Sellers, matching the heading above the results and the counts
            below. This read "offers" while the number handed to it was the
            seller count and the facets underneath counted listings — three
            units on one screen, none of which agreed. */}
        <p className="pt-1.5 pb-1 text-[11px] tnum" style={{ color: 'var(--ink-3)' }}>on {total} products</p>

        <FacetList facets={facets} selections={selections} onToggle={onToggle} />
      </div>
    </aside>
  );
}

/**
 * The same facets on a phone, as a bottom sheet. Below `lg` the rail does not
 * render at all, which left a phone with no way to narrow 232 products — the
 * one screen where narrowing matters most.
 */
export function FilterSheet({
  open, onClose, facets, selections, onToggle, onClear, total, loading,
}: FacetProps & {
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  total: number;
  loading: boolean;
}) {
  const activeCount = Object.values(selections).flat().length;
  const panel = React.useRef<HTMLDivElement>(null);

  // Escape closes; the page behind does not scroll while the sheet is up.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Move focus into the sheet so a keyboard user is not left behind it.
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>('button, input')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Filters">
      <button className="absolute inset-0 w-full h-full" style={{ background: 'var(--scrim)' }}
        onClick={onClose} aria-label="Close filters" tabIndex={-1} />
      <div ref={panel} className="sheet-up absolute inset-x-0 bottom-0 max-h-[86vh] flex flex-col glass-strong"
        style={{ borderRadius: '18px 18px 0 0', borderBottom: 0 }}>
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2.5 rule-b">
          <div className="flex items-baseline gap-2">
            <h2 className="display text-[15px]">Narrow by</h2>
            <span className="text-[11px] tnum" style={{ color: 'var(--ink-3)' }}>on {total} products</span>
          </div>
          <div className="flex items-center gap-3">
            {activeCount > 0 && (
              <button onClick={onClear} className="text-[12px] anim hover:opacity-70" style={{ color: 'var(--accent)' }}>
                clear {activeCount}
              </button>
            )}
            <button onClick={onClose} aria-label="Close filters" className="anim hover:opacity-70 -mr-1 p-1" style={{ color: 'var(--ink-2)' }}>
              <IconClose size={18} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto scroll-thin px-4 flex-1 min-h-0">
          <FacetList facets={facets} selections={selections} onToggle={onToggle} />
        </div>
        <div className="px-4 py-3 rule-t" style={{ background: 'var(--wash-strong)' }}>
          <button onClick={onClose} className="btn-primary w-full h-11 text-[14px]" disabled={loading}>
            {loading ? 'Updating…' : `Show ${total.toLocaleString('en-IN')} ${total === 1 ? 'product' : 'products'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
