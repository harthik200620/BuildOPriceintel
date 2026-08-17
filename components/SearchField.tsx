'use client';

import React from 'react';
import { Money } from './primitives';
import { DAMPED } from './CardGallery';

interface Suggestion {
  products: Array<{ product_id: string; title: string; brand: string | null; category: string; unit_canonical: string; image_url: string | null; normalised_paise: number; offer_count: number }>;
  intent: Array<{ category: string; label: string; count: number }>;
  trending: string[];
  parsed: {
    category: string | null;
    constraints: Record<string, string | number>;
    matched_vocabulary: Array<{ term: string; means: string; script: string }>;
    correction: { from: string; to: string } | null;
    unit_bearing: boolean;
  };
}

const RECENT_KEY = 'buildobjects-recent';

export default function SearchField({
  value, onChange, onSubmit, pincode, inputRef,
}: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void;
  pincode: string; inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [sug, setSug] = React.useState<Suggestion | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);
  const [active, setActive] = React.useState(-1);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const seq = React.useRef(0);
  /**
   * The hint has three widths, because the field has three.
   *
   * The long form is a tour of what the query grammar understands, and it is
   * 497 px of type. Measured, the field is 600 px at 1440, 184 px at 1024 and
   * absent below 768 — so one breakpoint was never enough: a tablet was being
   * shown a hint two and a half times the width of the box holding it, and cut
   * it mid-word. Each tier below is a string that fits the field it appears in.
   */
  const [tier, setTier] = React.useState<'phone' | 'mid' | 'wide'>('wide');

  React.useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')); } catch { /* first run */ }
    const phone = window.matchMedia('(max-width: 767px)');
    const wide = window.matchMedia('(min-width: 1180px)');
    const apply = () => setTier(phone.matches ? 'phone' : wide.matches ? 'wide' : 'mid');
    apply();
    phone.addEventListener('change', apply);
    wide.addEventListener('change', apply);
    return () => { phone.removeEventListener('change', apply); wide.removeEventListener('change', apply); };
  }, []);
  const narrow = tier === 'phone';

  /* ⌘K / Ctrl+K focuses the field from anywhere. */
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inputRef]);

  React.useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  /* 80 ms debounce. Deliberately no spinner: the request lands in single-digit
     milliseconds off a local file, so a spinner would only ever be a flash. */
  React.useEffect(() => {
    if (!value.trim()) { setSug(null); return; }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/suggest?q=${encodeURIComponent(value)}&pincode=${pincode}`);
        const j = await r.json();
        if (id === seq.current) setSug(j);
      } catch { /* the dropdown is an enhancement; the field still submits */ }
    }, 80);
    return () => clearTimeout(t);
  }, [value, pincode]);

  function commit(q: string) {
    const next = [q, ...recent.filter((r) => r !== q)].slice(0, 6);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    onSubmit(q);
    setOpen(false);
    inputRef.current?.blur();
  }

  const rows: Array<{ kind: 'product' | 'intent' | 'text'; key: string; value: string }> = [];
  if (sug) {
    for (const i of sug.intent) rows.push({ kind: 'intent', key: i.category, value: i.label });
    for (const p of sug.products) rows.push({ kind: 'product', key: p.product_id, value: p.title });
  }
  if (!value.trim()) {
    for (const r of recent) rows.push({ kind: 'text', key: `r:${r}`, value: r });
    for (const t of sug?.trending ?? []) rows.push({ kind: 'text', key: `t:${t}`, value: t });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); setOpen(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r?.kind === 'product') { window.dispatchEvent(new CustomEvent('buildobjects:open-sku', { detail: r.key })); setOpen(false); }
      else commit(r ? r.value : value);
    }
  }

  return (
    <div ref={boxRef} className="relative flex-1 max-w-[720px]">
      <div className="relative">
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden
          className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--ink-3)' }}>
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M16.5 16.5 L21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls="buildobjects-suggest"
          aria-autocomplete="list"
          aria-label="Search construction materials"
          placeholder={
            tier === 'phone' ? 'Search…'
            : tier === 'mid' ? 'Search materials…'
            : 'Try “53 grade cement”, “8mm tmt”, “4 inch cpvc”, “sariya rate”, “ఇటుక”'
          }
          className="field w-full h-9 pl-9 pr-3 md:pr-16 text-[14px]"
        />
        {/* A keyboard hint has no reader on a phone; it goes with the width. */}
        <kbd
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] px-1.5 py-0.5 pointer-events-none tnum hidden md:inline-block"
          style={{ color: 'var(--ink-3)', border: '1px solid var(--rule)', borderRadius: '10px' }}
        >
          ⌘K
        </kbd>
      </div>

      {open && (rows.length > 0 || sug?.parsed?.correction) && (
        <div
          id="buildobjects-suggest"
          role="listbox"
          className="absolute left-0 right-0 top-full mt-1.5 z-50 fade-up scroll-thin"
          style={{
            background: 'var(--chrome)', WebkitBackdropFilter: 'blur(20px) saturate(1.15)', backdropFilter: 'blur(20px) saturate(1.15)',
            border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius)',
            boxShadow: 'var(--glass-shadow-lift), inset 0 1px 0 var(--glass-border)',
            maxHeight: '68vh', overflowY: 'auto',
          }}
        >
          {/* Corrections are shown, never applied silently. */}
          {sug?.parsed?.correction && (
            <div className="px-3.5 py-2 rule-b text-[12px]" style={{ color: 'var(--ink-2)' }}>
              Showing results for <strong style={{ color: 'var(--accent)' }}>{sug.parsed.correction.to}</strong>
              {' '}— search instead for <em>{sug.parsed.correction.from}</em>
            </div>
          )}

          {/* Trade and multilingual terms, glossed so the buyer sees what we read. */}
          {!!sug?.parsed?.matched_vocabulary?.length && (
            <div className="px-3.5 py-2 rule-b text-[12px]" style={{ color: 'var(--ink-2)' }}>
              {sug.parsed.matched_vocabulary.map((v) => (
                <span key={v.term} className="mr-3">
                  <span style={{ color: 'var(--ink)' }}>{v.term}</span> → {v.means}
                </span>
              ))}
            </div>
          )}

          {/* Typed constraints the grammar extracted — never a text match. */}
          {sug?.parsed?.unit_bearing && Object.keys(sug.parsed.constraints).filter((k) => !k.startsWith('_')).length > 0 && (
            <div className="px-3.5 py-2 rule-b text-[11px] flex flex-wrap gap-1.5 items-center">
              <span style={{ color: 'var(--ink-3)' }}>read as</span>
              {Object.entries(sug.parsed.constraints).filter(([k]) => !k.startsWith('_')).map(([k, v]) => (
                <span key={k} className="chip px-1.5 py-0.5 text-[11px] fig">{k.replace(/_/g, ' ')} = {String(v)}</span>
              ))}
              {sug.parsed.constraints._inch_source && (
                <span className="text-[11px]" style={{ color: 'var(--ink-3)' }} title="The inch→mm mapping is a table, not arithmetic: 1″ CPVC is 25 mm nominal but 4″ SWR is 110 mm OD.">
                  ({String(sug.parsed.constraints._inch_source)})
                </span>
              )}
            </div>
          )}

          {!!sug?.intent?.length && (
            <div className="px-3.5 py-2.5 rule-b">
              <div className="text-[10px] uppercase tracking-[0.12em] mb-1.5" style={{ color: 'var(--ink-3)' }}>Category</div>
              <div className="flex flex-wrap gap-1.5">
                {sug.intent.map((i, n) => (
                  <button
                    key={i.category}
                    onMouseEnter={() => setActive(n)}
                    onClick={() => { window.dispatchEvent(new CustomEvent('buildobjects:set-category', { detail: i.category })); setOpen(false); }}
                    className="chip anim px-2 py-1 text-[12px]"
                    aria-selected={active === n}
                    role="option"
                  >
                    {i.label} <span className="tnum opacity-60">{i.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!!sug?.products?.length && (
            <div className="py-1">
              <div className="px-3.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-3)' }}>Products</div>
              {sug.products.map((p, n) => {
                const idx = (sug.intent?.length ?? 0) + n;
                return (
                  <button
                    key={p.product_id}
                    role="option"
                    aria-selected={active === idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => { window.dispatchEvent(new CustomEvent('buildobjects:open-sku', { detail: p.product_id })); setOpen(false); }}
                    className="w-full flex items-center gap-3 px-3.5 py-2 text-left anim"
                    style={active === idx ? { background: 'var(--wash)' } : undefined}
                  >
                    <span className="w-8 h-8 shrink-0 grid place-items-center overflow-hidden"
                      style={{ background: 'var(--wash)', border: '1px solid var(--rule)' }}>
                      {p.image_url
                        ? <img src={p.image_url} alt="" className="w-full h-full object-cover" loading="lazy" style={{ filter: DAMPED }} />
                        : <span className="text-[9px]" style={{ color: 'var(--ink-3)' }}>—</span>}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] truncate" style={{ color: 'var(--ink)' }}>{p.title}</span>
                      <span className="block text-[11px]" style={{ color: 'var(--ink-3)' }}>
                        {p.offer_count} {p.offer_count === 1 ? 'offer' : 'offers'}
                      </span>
                    </span>
                    {/* Live in-zone price preview, from the same local store. */}
                    <Money paise={p.normalised_paise} unit={p.unit_canonical} size="sm" />
                  </button>
                );
              })}
            </div>
          )}

          {!value.trim() && !!recent.length && (
            <div className="py-1 rule-t">
              <div className="px-3.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-3)' }}>Recent</div>
              {recent.map((r) => (
                <button key={r} onClick={() => { onChange(r); commit(r); }}
                  className="w-full text-left px-3.5 py-1.5 text-[13px] anim hover:opacity-70">{r}</button>
              ))}
            </div>
          )}

          {!value.trim() && !!sug?.trending?.length && (
            <div className="py-1 rule-t">
              <div className="px-3.5 pt-1.5 pb-1 text-[10px] uppercase tracking-[0.12em]" style={{ color: 'var(--ink-3)' }}>Trending here</div>
              {sug.trending.map((t) => (
                <button key={t} onClick={() => { onChange(t); commit(t); }}
                  className="w-full text-left px-3.5 py-1.5 text-[13px] anim hover:opacity-70">{t}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
