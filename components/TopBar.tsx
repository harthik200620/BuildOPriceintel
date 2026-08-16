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
        background: 'var(--chrome)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
        backdropFilter: 'blur(20px) saturate(1.15)',
        borderBottom: '1px solid var(--glass-hair)',
        boxShadow: 'inset 0 1px 0 var(--glass-border)',
      }}
    >
      <div className="mx-auto max-w-[1680px] px-6 lg:px-10">
        <div className="flex items-center gap-6 h-[68px]">
          {/* Wordmark. The 'b' monogram, in the accent aqua, beside the name set
              in Audiowide — the title voice — with "Price Intelligence" as the
              sub-title in Encode Sans. The mark is a PNG lifted off its scan onto
              transparency (public/logo-mark.png), served at 2x for the 28 px slot
              so it stays crisp on a retina display. */}
          <a href="/" className="flex items-center gap-3 shrink-0 group" aria-label="Build Objects Price Intelligence, home">
            <img
              src="/logo-mark-128.png"
              width={28} height={28}
              alt=""
              aria-hidden
              className="shrink-0 select-none"
              style={{ imageRendering: 'auto', filter: 'drop-shadow(0 0 10px rgba(92,225,230,.28))' }}
              draggable={false}
            />
            <span className="flex items-baseline gap-2.5 leading-none">
              <span className="display text-[17px]" style={{ color: 'var(--ink)', letterSpacing: '.01em' }}>
                Build Objects
              </span>
              <span
                className="fig text-[10.5px] uppercase font-medium hidden sm:inline"
                style={{ color: 'var(--ink-3)', letterSpacing: '.16em' }}
              >
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
