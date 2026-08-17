'use client';

import React from 'react';
import SearchField from './SearchField';
import { IconPin, IconBag, IconSparkle } from './icons';

export interface Region {
  region_id: string; name: string; state_code: string;
  pincode_from: string; pincode_to: string; default_pincode: string;
}

export default function TopBar({
  regions, regionId, pincode, onRegion, onPincode,
  query, onQuery, onSubmit, searchRef, pincodeError, onHome, atHome,
  onLogo, onLogoHover, logoRef, listCount, onList, onAsk, phoneHidden,
}: {
  regions: Region[]; regionId: string; pincode: string;
  onRegion: (r: string) => void; onPincode: (p: string) => void;
  query: string; onQuery: (q: string) => void; onSubmit: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  pincodeError: string | null;
  onHome: () => void;
  atHome: boolean;
  /** The "b" opens the mark's page (/logo); onLogoHover warms its chunk. */
  onLogo: () => void;
  onLogoHover: () => void;
  logoRef: React.RefObject<HTMLAnchorElement | null>;
  /** Lines on the estimate. */
  listCount: number;
  onList: () => void;
  /** The assistant. It has no floating button below 768 px — see ChatPanel. */
  onAsk: () => void;
  /** True on the views that render their own app bar below 768 px. */
  phoneHidden?: boolean;
}) {
  const [whereOpen, setWhereOpen] = React.useState(false);
  const region = regions.find((r) => r.region_id === regionId);

  const regionSeg = (
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
  );

  const pinField = (
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
  );

  return (
    <header
      /* On the screens that carry an app bar, this one is desktop-only: two
         stacked bars is 120 px of chrome on an 844 px screen, and the estimate
         badge appeared three times on the same view. */
      className={phoneHidden ? 'sticky top-0 z-40 hidden md:block' : 'sticky top-0 z-40'}
      style={{
        background: 'var(--chrome)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
        backdropFilter: 'blur(20px) saturate(1.15)',
        borderBottom: '1px solid var(--glass-hair)',
        boxShadow: 'inset 0 1px 0 var(--glass-border)',
      }}
    >
      <div className="mx-auto max-w-[1680px] px-4 sm:px-6 lg:px-10">
        {/* gap-1 below sm, not gap-3: the bar now carries the mark, the
            wordmark, the assistant, the estimate and the pincode, and at 390 px
            four 12 px gaps were the 3 px that pushed the row past the
            viewport. */}
        <div className="flex items-center gap-1 sm:gap-6 h-[64px] sm:h-[68px]">
          {/* Wordmark, in two links. The 'b' monogram, in the accent aqua, opens
              the mark's own page — the stitched "b" at /logo — and the name set
              in Audiowide (the title voice, with "Price Intelligence" as the
              sub-title in Encode Sans) is the way home. The mark is a PNG lifted
              off its scan onto transparency (public/logo-mark.png), served at
              128 px for the 28 px slot so it stays crisp on any display. */}
          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0 min-w-0">
            <a
              ref={logoRef}
              href="/logo"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onLogo();
              }}
              onPointerEnter={onLogoHover}
              onFocus={onLogoHover}
              /* The glyph is 28 px; the target around it is 40. Measured, this
                 and the wordmark beside it were the only controls on a phone
                 under the 32 px floor. */
              className="grid place-items-center shrink-0 rounded-md w-10 h-10 -ml-1"
              aria-label="The Build Objects mark"
            >
              <img
                src="/logo-mark-128.png"
                width={28} height={28}
                alt=""
                aria-hidden
                className="shrink-0 select-none"
                style={{ imageRendering: 'auto', filter: 'drop-shadow(0 0 10px rgba(92,225,230,.28))' }}
                draggable={false}
              />
            </a>
            <a
              href="/"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                onHome();
              }}
              className="flex items-baseline gap-2.5 leading-none group h-10 self-center"
              style={{ alignItems: 'center' }}
              aria-label="Build Objects Price Intelligence, home"
              aria-current={atHome ? 'page' : undefined}
            >
              <span className="display text-[16px] sm:text-[17px] whitespace-nowrap" style={{ color: 'var(--ink)', letterSpacing: '.01em' }}>
                Build Objects
              </span>
              <span
                className="fig text-[10.5px] uppercase font-medium hidden md:inline"
                style={{ color: 'var(--ink-3)', letterSpacing: '.16em' }}
              >
                Price Intelligence
              </span>
            </a>
          </div>

          {/* The field is desktop-only. At 390 px it was left with 43 px of
              usable width — narrower than the word "Search", so the hint was
              cut on every phone. Below 768 px it renders full-width in the body
              of the home screen and behind the Search tab instead. */}
          <div className="hidden md:flex flex-1 min-w-0">
            <SearchField
              value={query} onChange={onQuery} onSubmit={onSubmit}
              pincode={pincode} inputRef={searchRef}
            />
          </div>
          <span className="flex-1 md:hidden" />

          <div className="hidden md:flex items-center gap-3 shrink-0">
            {regionSeg}
            {pinField}
          </div>

          {/* The assistant and the estimate, on a phone. The assistant has no
              floating button at this width — the tab bar owns that corner.

              The `md:hidden` sits on this wrapper rather than on the buttons:
              `.icon-btn` sets `display: grid` from plain CSS, and Tailwind's
              utilities live in a cascade layer, so an unlayered rule beats
              them. The buttons stayed 40 px wide at 1024 px and took 80 px out
              of the search field, which is what left it 56 px of usable width
              on a tablet. */}
          <div className="md:hidden flex items-center gap-1 shrink-0">
            <button onClick={onAsk} className="icon-btn anim" aria-label="Ask the buying assistant">
              <IconSparkle size={19} />
            </button>
            <button onClick={onList} className="icon-btn anim" aria-label={`The estimate, ${listCount} ${listCount === 1 ? 'line' : 'lines'}`}>
              <IconBag size={20} />
              {listCount > 0 && <span className="badge" aria-hidden>{listCount > 99 ? '99+' : listCount}</span>}
            </button>
          </div>

          {/* On a phone the same two controls fold behind one pill that names
              where the buyer is — every price on the page is landed there, so
              it has to be changeable from every page, not only the wide ones. */}
          <div className="md:hidden relative shrink-0">
            <button
              onClick={() => setWhereOpen((v) => !v)}
              className="chip anim h-9 pl-2 pr-2.5 text-[12px] inline-flex items-center gap-1.5"
              aria-haspopup="dialog" aria-expanded={whereOpen}
              aria-label={`Delivering to ${region?.name ?? regionId} ${pincode}. Change.`}
            >
              <IconPin size={14} />
              <span className="fig">{pincode || '——'}</span>
            </button>
            {whereOpen && (
              <>
                <button className="fixed inset-0 z-40 cursor-default" aria-label="Close" tabIndex={-1} onClick={() => setWhereOpen(false)} />
                <div role="dialog" aria-label="Where to deliver" className="fade-up absolute right-0 top-full mt-2 z-50 glass-strong p-3 flex flex-col gap-2.5 min-w-[240px]">
                  <span className="text-[11px] uppercase tracking-[.11em]" style={{ color: 'var(--ink-3)' }}>Deliver to</span>
                  {regionSeg}
                  {pinField}
                  <button onClick={() => setWhereOpen(false)} className="btn-primary h-9 text-[13px] mt-0.5">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
