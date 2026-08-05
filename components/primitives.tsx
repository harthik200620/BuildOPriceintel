'use client';

import React from 'react';

/* ── money ─────────────────────────────────────────────────────────────────
   Law 2, enforced by the type system rather than by review: this component
   cannot be called without a unit. There is deliberately no way to render a
   bare rupee figure in this application.
   ────────────────────────────────────────────────────────────────────────── */

export const UNIT_LABEL: Record<string, string> = {
  bag: '/bag', kg: '/kg', tonne: '/tonne', running_metre: '/metre', piece: '/piece',
  litre: '/litre', sqm: '/m²', cum: '/m³', cft: '/cft', brass: '/brass',
  box: '/box', coil: '/coil', length: '/length',
};
export const UNIT_SPOKEN: Record<string, string> = {
  bag: 'per bag', kg: 'per kilogram', tonne: 'per tonne', running_metre: 'per running metre',
  piece: 'per piece', litre: 'per litre', sqm: 'per square metre', cum: 'per cubic metre',
  cft: 'per cubic foot', brass: 'per brass', box: 'per box', coil: 'per coil', length: 'per length',
};

export function rupees(paise: number, decimals = true): string {
  const abs = Math.abs(paise);
  const r = Math.floor(abs / 100);
  const p = abs % 100;
  const s = String(r);
  const head = s.length > 3 ? s.slice(0, s.length - 3) : '';
  const tail = s.slice(-3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail : tail;
  return `${paise < 0 ? '−' : ''}₹${grouped}${decimals ? '.' + String(p).padStart(2, '0') : ''}`;
}

export function Money({
  paise, unit, size = 'md', stale = false, className = '', decimals = true, accent = false,
}: {
  paise: number; unit: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'hero';
  stale?: boolean; className?: string; decimals?: boolean; accent?: boolean;
}) {
  // The hero is set larger and on the display face — it is the one number the
  // whole card exists to deliver, and the one place colour carries meaning.
  const cls = {
    xs: 'text-[11px]', sm: 'text-[13px]', md: 'text-[15px]',
    lg: 'text-[19px]', hero: 'text-[38px] leading-[1.0]',
  }[size];
  return (
    <span
      // nowrap because the unit label offers a break opportunity after its
      // SOLIDUS, and the table cells this lands in have a hard `height: ROW_H`
      // with no overflow clip — a wrapped price paints over the row below
      // rather than being caught.
      className={`${accent ? 'hero-figure' : 'fig'} ${cls} ${stale ? 'price-stale' : ''} whitespace-nowrap ${className}`}
      // Every number is labelled with its unit for screen readers.
      aria-label={`${rupees(paise, decimals)} ${UNIT_SPOKEN[unit] ?? unit}`}
    >
      {rupees(paise, decimals)}
      {/* Pinned to 400 rather than inheriting the numerals' weight, so "/bag"
          sits under ₹286.20 instead of beside it. The number is the thing. */}
      <span className="opacity-55 ml-[1px]" style={{ fontSize: '0.62em', fontWeight: 400, letterSpacing: 0 }} aria-hidden>
        {UNIT_LABEL[unit] ?? `/${unit}`}
      </span>
    </span>
  );
}

/* ── freshness ─────────────────────────────────────────────────────────────
   Green under 24 h, amber under 72 h, grey beyond, with the exact verified
   time on hover. No state presents a stale price as current.
   ────────────────────────────────────────────────────────────────────────── */
export function FreshnessDot({
  dot, label, exact, className = '',
}: { dot: 'green' | 'amber' | 'grey'; label: string; exact?: string; className?: string }) {
  const title = exact
    ? `${label} — verified ${new Date(exact).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`
    : label;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} title={title}>
      <span className={`dot dot-${dot}`} aria-hidden />
      <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>{label}</span>
    </span>
  );
}

/* ── provenance ────────────────────────────────────────────────────────────
   A field with no provenance cannot render. TYPICAL carries a tooltip saying
   it is representative, not quoted.
   ────────────────────────────────────────────────────────────────────────── */
export function ProvenanceBadge({
  confidence, derivation, sourceUrl,
}: { confidence: string; derivation?: string | null; sourceUrl?: string }) {
  const map: Record<string, { text: string; cls: string; tip: string }> = {
    quoted: { text: 'quoted', cls: '', tip: 'Published by the source.' },
    derived: {
      text: 'derived', cls: 'prov-derived',
      tip: derivation ? `Computed: ${derivation}` : 'Computed from other captured fields.',
    },
    typical: {
      text: 'typical', cls: 'prov-typical',
      tip: derivation
        ? `Representative, not quoted by this seller. ${derivation}`
        : 'A representative value for this brand or category — not quoted by this seller.',
    },
    unknown: { text: 'not published', cls: 'prov-unknown', tip: 'Not published by the seller.' },
  };
  const m = map[confidence] ?? map.unknown;
  return (
    <span className={`prov ${m.cls}`} title={m.tip + (sourceUrl ? `\nSource: ${sourceUrl}` : '')}>
      {m.text}
    </span>
  );
}

/* ── certification ─────────────────────────────────────────────────────────
   Three honest states, never collapsed into pass/fail. A blank must never
   read as a failure.
   ────────────────────────────────────────────────────────────────────────── */
export function CertBadge({ state, qco, compact = false }: { state: string; qco?: boolean; compact?: boolean }) {
  const map: Record<string, { label: string; short: string; tone: string; tip: string }> = {
    CERTIFIED: {
      label: 'BIS certified', short: 'BIS', tone: 'ok',
      tip: 'A BIS licence number was captured from the source for this listing.',
    },
    BRAND_LICENSED: {
      label: 'BIS-licensed brand', short: 'BIS*', tone: 'soft',
      tip: 'The manufacturer holds a BIS licence for this standard, but this listing does not quote the licence number. That is a different claim from "certified" and is not treated as one.',
    },
    NOT_DECLARED: {
      label: 'No BIS mark declared', short: '—', tone: 'muted',
      tip: 'The seller has not provided a BIS licence. The product is listed, priced and ranked; the fact is simply stated.',
    },
    NOT_APPLICABLE: {
      label: 'BIS not applicable', short: 'n/a', tone: 'muted',
      tip: 'No BIS standard applies to this product. Neutral — local kiln bricks are legal, ordinary material.',
    },
    EXPIRED: {
      label: 'BIS licence expired', short: '!', tone: 'warn',
      tip: qco
        ? 'This category requires a valid BIS licence by law and this one has expired, so the offer cannot be sold.'
        : 'The licence on file has expired. The offer stays listed with the fact stated.',
    },
  };
  const m = map[state] ?? map.NOT_DECLARED;
  const color = m.tone === 'ok' ? 'var(--fresh)' : m.tone === 'warn' ? 'var(--accent)'
    : m.tone === 'soft' ? 'var(--ink-2)' : 'var(--ink-3)';
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] tracking-[.06em] uppercase px-2 py-[3px]"
      style={{
        color,
        // Higher than the light theme's 8/26. A mix toward `transparent` lands
        // on whatever is behind it, and on this ground an 8% wash is not there.
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        borderRadius: 'var(--radius-pill)',
      }}
      title={m.tip}
    >
      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
        <path d="M6 1l4 1.6v3.1c0 2.4-1.6 4.2-4 5.3-2.4-1.1-4-2.9-4-5.3V2.6z"
          fill="none" stroke="currentColor" strokeWidth="1.1" />
      </svg>
      {compact ? m.short : m.label}
    </span>
  );
}

/* ── estimated badge ───────────────────────────────────────────────────────
   Every delivery figure carries this, with a one-tap breakdown.
   ────────────────────────────────────────────────────────────────────────── */
export function EstimatedBadge({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="prov anim hover:opacity-70"
      title="Delivery is computed by the freight model, not quoted by the seller. Tap for the arithmetic."
    >
      estimated
    </button>
  );
}

export function Hairline({ className = '' }: { className?: string }) {
  return <div className={`h-px w-full ${className}`} style={{ background: 'var(--rule)' }} aria-hidden />;
}

/** The corner tick — a survey mark. Used sparingly, on the sheet and the tray. */
export function CornerTicks() {
  return <span className="corner-tick absolute inset-0 pointer-events-none" aria-hidden />;
}
