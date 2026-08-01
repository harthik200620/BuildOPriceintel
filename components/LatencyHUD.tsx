'use client';

import React from 'react';

export interface Stage { label: string; ms: number; note?: string }

/**
 * Dev-mode latency HUD — the live per-stage breakdown, so the budget is
 * visible while you use the app rather than only in the benchmark.
 *
 * The decomposition is honest: the 80 ms debounce is INSIDE the keystroke →
 * paint budget, not excluded from it.
 */
export default function LatencyHUD({ stages, total, budget = 200 }: { stages: Stage[]; total: number; budget?: number }) {
  const [open, setOpen] = React.useState(false);
  const over = total > budget;

  return (
    // Bottom-RIGHT: Next.js parks its dev indicator bottom-left.
    <div className="fixed bottom-3 right-3 z-[70] text-[11px]" style={{ fontFamily: 'var(--font-figure)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="anim flex items-center gap-2 px-2.5 h-7"
        style={{
          background: 'var(--glass)', WebkitBackdropFilter: 'blur(20px) saturate(1.7)',
          backdropFilter: 'blur(20px) saturate(1.7)',
          border: `1px solid ${over ? 'var(--accent)' : 'var(--glass-hair)'}`,
          borderRadius: '10px', color: over ? 'var(--accent)' : 'var(--ink-2)',
          boxShadow: 'var(--glass-shadow), inset 0 1px 0 var(--glass-border)',
        }}
        title="Keystroke → painted results. Click for the per-stage breakdown."
      >
        <span className="dot" style={{ background: over ? 'var(--accent)' : 'var(--fresh)' }} aria-hidden />
        {total.toFixed(0)} ms
        <span style={{ color: 'var(--ink-3)' }}>/ {budget}</span>
      </button>

      {open && (
        <div className="mt-1.5 p-3 w-[290px] fade-up glass">
          <div className="text-[10px] uppercase tracking-[0.11em] mb-2" style={{ color: 'var(--ink-3)' }}>
            keystroke → painted
          </div>
          {stages.map((s) => {
            const pct = total > 0 ? (s.ms / total) * 100 : 0;
            return (
              <div key={s.label} className="mb-1.5" title={s.note}>
                <div className="flex justify-between mb-0.5">
                  <span style={{ color: 'var(--ink-2)' }}>{s.label}</span>
                  <span className="tnum" style={{ color: 'var(--ink)' }}>{s.ms.toFixed(1)}</span>
                </div>
                <div style={{ height: 2, background: 'rgba(22,20,18,.10)' }}>
                  <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: 'var(--accent)', opacity: .65 }} />
                </div>
              </div>
            );
          })}
          <div className="mt-2 pt-2 rule-t flex justify-between">
            <span style={{ color: 'var(--ink-2)' }}>total</span>
            <span className="tnum" style={{ color: over ? 'var(--accent)' : 'var(--ink)' }}>{total.toFixed(1)} ms</span>
          </div>
          <p className="mt-2 text-[10px] leading-snug" style={{ color: 'var(--ink-3)' }}>
            The 80 ms debounce is counted inside this budget, not excluded from it.
          </p>
        </div>
      )}
    </div>
  );
}
