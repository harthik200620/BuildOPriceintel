'use client';

import React from 'react';
import SearchField from './SearchField';

export interface Region {
  region_id: string; name: string; state_code: string;
  pincode_from: string; pincode_to: string; default_pincode: string;
}

export default function TopBar({
  regions, regionId, pincode, onRegion, onPincode,
  query, onQuery, onSubmit, searchRef, pincodeError,
}: {
  regions: Region[]; regionId: string; pincode: string;
  onRegion: (r: string) => void; onPincode: (p: string) => void;
  query: string; onQuery: (q: string) => void; onSubmit: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  pincodeError: string | null;
}) {
  return (
    <header
      className="sticky top-0 z-40"
      style={{
        background: 'rgba(255,255,255,.58)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.7)',
        backdropFilter: 'blur(20px) saturate(1.7)',
        borderBottom: '1px solid var(--glass-hair)',
        boxShadow: 'inset 0 1px 0 var(--glass-border)',
      }}
    >
      <div className="mx-auto max-w-[1680px] px-6 lg:px-10">
        <div className="flex items-center gap-6 h-[68px]">
          {/* Wordmark — the plot square, drawn once */}
          <a href="/" className="flex items-center gap-2.5 shrink-0 group" aria-label="BuildO Price Intelligence, home">
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="shrink-0">
              <rect x="2.5" y="2.5" width="19" height="19" fill="none" stroke="var(--ink)" strokeWidth="1.2" />
              <path d="M2.5 15.5 L12 8 L21.5 15.5" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
              <circle cx="12" cy="8" r="1.1" fill="var(--accent)" />
            </svg>
            <span className="display text-[19px] tracking-tight" style={{ color: 'var(--ink)' }}>
              BuildO
              <span className="ml-1.5 text-[11px] uppercase tracking-[0.14em] align-middle" style={{ color: 'var(--ink-3)' }}>
                Price Intelligence
              </span>
            </span>
          </a>

          <SearchField
            value={query} onChange={onQuery} onSubmit={onSubmit}
            pincode={pincode} inputRef={searchRef}
          />

          <div className="hidden md:flex items-center gap-3 shrink-0">
            <div className="seg flex h-9 text-[13px]" role="group" aria-label="Region">
              {regions.map((r) => (
                <button
                  key={r.region_id}
                  onClick={() => { onRegion(r.region_id); onPincode(r.default_pincode); }}
                  aria-pressed={regionId === r.region_id}
                  className="anim px-3.5 h-full"
                >
                  {r.name}
                </button>
              ))}
            </div>

            <div className="relative">
              <input
                value={pincode}
                onChange={(e) => onPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                aria-label="Delivery pincode"
                aria-invalid={!!pincodeError}
                className="field h-9 w-[92px] px-2.5 text-[13px] fig"
                style={pincodeError ? { borderColor: 'var(--accent)' } : undefined}
                placeholder="pincode"
              />
              {pincodeError && (
                <span
                  role="alert"
                  className="absolute left-0 top-full mt-1 text-[11px] whitespace-nowrap z-10 px-2 py-1"
                  style={{ color: 'var(--accent)', background: 'var(--glass-strong)', border: '1px solid var(--glass-hair)', borderRadius: '8px', backdropFilter: 'blur(12px)' }}
                >
                  {pincodeError}
                </span>
              )}
            </div>

          </div>
        </div>
      </div>
    </header>
  );
}
