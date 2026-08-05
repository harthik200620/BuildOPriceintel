'use client';

import React from 'react';
import type { FacetView } from '@/lib/types';

export default function FilterRail({
  facets, selections, onToggle, onClear, collapsed, onCollapse, total,
}: {
  facets: FacetView[];
  selections: Record<string, string[]>;
  onToggle: (facetId: string, value: string, single: boolean) => void;
  onClear: () => void;
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  total: number;
}) {
  const [openMore, setOpenMore] = React.useState(false);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});

  const primary = facets.filter((f) => f.visibility === 'primary');
  // A conditional facet does not render before its parent value is chosen —
  // showing SDR-11 next to Class 4 lets a buyer express an impossible
  // requirement, and the panel let them.
  const conditional = facets.filter((f) => f.visibility === 'conditional' && f.active);
  const more = facets.filter((f) => f.visibility === 'more');
  const activeCount = Object.values(selections).flat().length;

  if (collapsed) {
    return (
      <button
        onClick={() => onCollapse(false)}
        className="chip anim sticky top-[84px] h-9 px-3 text-[12px] flex items-center gap-2 self-start"
        aria-label="Show filters"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden>
          <path d="M3 5h18M6 12h12M10 19h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        Filters{activeCount ? ` (${activeCount})` : ''}
      </button>
    );
  }

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
                  <label
                    className="facet-val flex items-baseline gap-2 py-[3px] cursor-pointer group"
                    data-disabled={v.disabled && !checked}
                    title={v.disabled && !checked ? 'No offers match this in your area right now' : undefined}
                  >
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={single ? f.facet_id : undefined}
                      checked={checked}
                      disabled={v.disabled && !checked}
                      onChange={() => onToggle(f.facet_id, v.label, single)}
                      className="mt-[3px] shrink-0 accent-[var(--accent)]"
                      style={{ width: 12, height: 12 }}
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
        {/* Offers, not products. Every count in this rail counts sellers'
            listings, because that is what the results list is made of. */}
        <p className="pt-1.5 pb-1 text-[11px] tnum" style={{ color: 'var(--ink-3)' }}>on {total} offers</p>

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
      </div>
    </aside>
  );
}
