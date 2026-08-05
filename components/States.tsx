'use client';

import React from 'react';

/**
 * Every state is designed. Two outcomes are forbidden anywhere in this app: a
 * blank page, and a wrong price shown as right.
 */

/** Skeletons match the final card layout exactly, so nothing jumps on load. */
export function CardSkeleton() {
  return (
    <div className="p-4 pb-3" style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
      <div className="flex gap-3.5">
        <div className="skel w-[56px] h-[56px] shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="skel h-2 w-16" />
          <div className="skel h-3.5 w-full" />
          <div className="skel h-3.5 w-3/5" />
          <div className="flex gap-1 pt-0.5">
            <div className="skel h-4 w-12" /><div className="skel h-4 w-14" />
          </div>
        </div>
      </div>
      <div className="mt-3.5 flex items-end justify-between">
        <div className="space-y-1.5"><div className="skel h-7 w-32" /><div className="skel h-2.5 w-40" /></div>
        <div className="skel h-6 w-14" />
      </div>
      <div className="mt-3 pt-2.5 rule-t flex justify-between">
        <div className="skel h-2.5 w-28" /><div className="skel h-2.5 w-14" />
      </div>
      <div className="mt-2 flex justify-between"><div className="skel h-2.5 w-20" /><div className="skel h-2.5 w-24" /></div>
    </div>
  );
}

export function ResultsSkeleton({ n = 9 }: { n?: number }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading results">
      {Array.from({ length: n }, (_, i) => <CardSkeleton key={i} />)}
    </div>
  );
}

function Frame({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="py-16 px-6 text-center max-w-[560px] mx-auto fade-up">
      <div className="mx-auto mb-4 w-12 h-12 grid place-items-center blueprint corner-tick"
        style={{ border: '1px solid var(--rule)', color: 'var(--ink-3)' }}>
        {icon}
      </div>
      <h2 className="display text-[20px] mb-2">{title}</h2>
      <div className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>{children}</div>
    </div>
  );
}

/** Zero results is never a dead end — the relax ladder has already run. */
export function ZeroResult({
  zero, query, onSuggest,
}: {
  zero: { reason: string; relaxed: string[]; suggestions: string[]; nearest_category: string | null };
  query: string;
  onSuggest: (q: string) => void;
}) {
  return (
    <div className="py-10 px-6 max-w-[620px] mx-auto fade-up">
      <h2 className="display text-[20px] mb-2">Nothing matched “{query}” exactly</h2>
      <p className="text-[13px] leading-relaxed mb-4" style={{ color: 'var(--ink-2)' }}>{zero.reason}</p>
      {zero.relaxed.length > 0 && (
        <p className="text-[12px] mb-4" style={{ color: 'var(--ink-3)' }}>
          Relaxed, least selective first: {zero.relaxed.join(' → ')}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {zero.suggestions.map((s) => (
          <button key={s} onClick={() => onSuggest(s)} className="chip anim px-2.5 h-8 text-[12.5px]">{s}</button>
        ))}
      </div>
      <div className="p-3.5" style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
        <p className="text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
          Still not here? <strong>Request this item</strong> — the query goes to the demand log, which is what
          drives catalogue expansion. Zero-result rate is tracked as an SLO, not ignored.
        </p>
      </div>
    </div>
  );
}

export function NoDataYet() {
  return (
    <Frame
      title="No collection run has completed yet"
      icon={<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="M4 7h16M4 12h16M4 17h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>}
    >
      <p>
        The price surface is empty because the collector has not finished a run on this machine.
      </p>
      <p className="mt-2">
        Run <code className="fig px-1.5 py-0.5" style={{ background: 'var(--wash)' }}>npm run collect</code> to
        populate it, then reload.
      </p>
    </Frame>
  );
}

export function EmptyCategory({ label }: { label: string }) {
  return (
    <Frame
      title={`No ${label} collected for this city yet`}
      icon={<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><rect x="4" y="6" width="16" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M4 10h16" stroke="currentColor" strokeWidth="1.4" /></svg>}
    >
      <p>Every source for this category and city either returned nothing or refused the collector. The collection
        log records which, and roughly how much supply sits behind each block.</p>
    </Frame>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Frame
      title="That search could not be completed"
      icon={<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden><path d="M12 8v5M12 16.5v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>}
    >
      <p className="fig text-[12px] mb-4" style={{ color: 'var(--ink-3)' }}>{message}</p>
      <button onClick={onRetry} className="chip anim px-3.5 h-9 text-[13px]">Try again</button>
    </Frame>
  );
}

export function OfflineBanner() {
  return (
    <div className="px-3 py-2 text-[12px] flex items-center gap-2"
      style={{ background: 'var(--accent-bg)', borderBottom: '1px solid var(--rule)', color: 'var(--accent-ink)' }}
      role="status">
      <span className="dot" style={{ background: 'var(--accent)' }} aria-hidden />
      You are offline — but the prices below are served from this machine, so search still works. Only the
      source links need a connection.
    </div>
  );
}

/** A failed refresh degrades freshness visibly. It never blanks the page. */
export function DegradedBanner({ lastRun }: { lastRun: string | null }) {
  return (
    <div className="px-3 py-2 text-[12px] flex items-center gap-2"
      style={{ background: 'color-mix(in srgb, var(--ageing) 20%, transparent)', borderBottom: '1px solid var(--rule)', color: 'var(--ink-2)' }}
      role="status">
      <span className="dot dot-amber" aria-hidden />
      The last refresh did not complete{lastRun ? ` (last good run ${new Date(lastRun).toLocaleString('en-IN')})` : ''}.
      Previous prices are intact and are ageing — freshness below is marked accordingly.
    </div>
  );
}
