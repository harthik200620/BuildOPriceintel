'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import type { Region } from './TopBar';
import { IconCheck, IconStorefront, IconClockCheck, IconPin } from './icons';

/**
 * The front door, and the only screen that asks for anything.
 *
 * ONE tree, two shapes. The obvious way to build this is a phone layout and a
 * desktop layout side by side with `lg:hidden` / `hidden lg:grid`, and it is
 * wrong: `display:none` still renders, so every button exists twice in the DOM
 * — two "Get started", two "Log in", a doubled trust list — and the WebGL mark
 * mounts a context on phones that never show it. So the controls are written
 * once and CSS moves them: stacked below 1024 px, split above it, with the
 * figure taking the left half and the way in the right.
 *
 * The figure is the only thing that genuinely differs, and it is swapped after
 * mount rather than in CSS: the stitched "b" that /logo shows is a WebGL
 * canvas, and it should exist only where it is visible. It is sewn in the
 * site's aqua rather than its own blue — that blue is drawn for a white sheet
 * and this ground is the deep.
 *
 * What this screen does not do is pretend there is an account. Nothing here is
 * behind a sign-in, so a form that took a password would have nowhere to send
 * it. The button the reference asks for is here; pressing it says so in one
 * line and points at the setting that is actually worth making — the pincode
 * every price on the site is landed at.
 */

const StitchCanvas = dynamic(() => import('./LogoStitchCanvas'), { ssr: false });

/** Aqua thread. --accent as a literal: the engine paints WebGL, not CSS. */
const THREAD = '#5ce1e6';

export default function Welcome({
  regions, regionId, pincode, onRegion, onPincode, pincodeError, onStart,
}: {
  regions: Region[];
  regionId: string;
  pincode: string;
  onRegion: (r: string) => void;
  onPincode: (p: string) => void;
  pincodeError: string | null;
  onStart: () => void;
}) {
  const [asking, setAsking] = React.useState(false);
  const [noAccounts, setNoAccounts] = React.useState(false);
  const pinRef = React.useRef<HTMLInputElement | null>(null);
  const region = regions.find((r) => r.region_id === regionId);
  const ready = /^\d{6}$/.test(pincode) && !pincodeError;

  /* The split is a layout fact, so the canvas follows the same 1024 px the CSS
     uses. False until mounted, so the server and the first client render agree
     on the photograph and only the figure changes afterwards. */
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  React.useEffect(() => { if (asking) pinRef.current?.focus(); }, [asking]);

  const marks = [
    { Icon: IconCheck, label: 'Quality materials' },
    { Icon: IconStorefront, label: 'Trusted brands' },
    { Icon: IconClockCheck, label: 'Fresh prices' },
    { Icon: IconPin, label: 'Landed to you' },
  ];

  return (
    <div className="welcome-root fade-up">
      {/* ── the figure ───────────────────────────────────────────────────── */}
      <div className="welcome-figure">
        {wide ? (
          <>
            <div style={{ width: 'min(44vh, 400px)' }}>
              <StitchCanvas color={THREAD} />
            </div>
            <p className="text-[11px] uppercase mt-10" style={{ color: 'var(--ink-3)', letterSpacing: '.2em' }}>
              Build Objects · Price Intelligence
            </p>
          </>
        ) : (
          <>
            <img
              src="/logo-mark-128.png"
              width={56} height={56} alt="" aria-hidden
              className="select-none self-start"
              style={{ filter: 'drop-shadow(0 0 18px rgba(92,225,230,.30))' }}
              draggable={false}
            />
            {/* A photograph of the material, not a stock building: every image
                on this site was downloaded at collection time from a listing,
                and there is no rendered skyline among them. */}
            <div className="welcome-art">
              <img src="/categories/tmt-steel.webp" alt="" aria-hidden loading="eager" />
            </div>
          </>
        )}
      </div>

      {/* ── the way in ───────────────────────────────────────────────────── */}
      <div className="welcome-entry">
        <div className="w-full lg:max-w-[380px]">
          <p className="text-[11px] uppercase" style={{ color: 'var(--accent)', letterSpacing: '.22em' }}>
            Welcome to
          </p>
          <h1 className="display leading-[1.04] mt-2" style={{ fontSize: 'clamp(34px, 7vw, 52px)' }}>
            <span style={{ color: 'var(--ink)' }}>BUILD</span><br />
            <span style={{ color: 'var(--accent)' }}>OBJECTS</span>
          </h1>
          <p className="text-[13.5px] lg:text-[14.5px] leading-[1.55] mt-4 max-w-[38ch]" style={{ color: 'var(--ink-2)' }}>
            What construction materials actually cost in Hyderabad and Vijayawada — every
            price landed at your pincode, GST stated, per unit.
          </p>

          <div className="mt-6 lg:mt-8">
            {asking ? (
              <div className="glass-card p-4 fade-up" style={{ borderRadius: 'var(--radius-glass)' }}>
                <label className="text-[11px] uppercase block" style={{ color: 'var(--ink-3)', letterSpacing: '.14em' }}>
                  Deliver to
                </label>
                <div className="seg flex h-10 text-[13px] mt-2.5" role="group" aria-label="City">
                  {regions.map((r) => (
                    <button
                      key={r.region_id}
                      onClick={() => { onRegion(r.region_id); onPincode(r.default_pincode); }}
                      aria-pressed={regionId === r.region_id}
                      className="anim flex-1 h-full"
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
                <input
                  ref={pinRef}
                  value={pincode}
                  onChange={(e) => onPincode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === 'Enter' && ready) onStart(); }}
                  inputMode="numeric"
                  aria-label="Delivery pincode"
                  aria-invalid={!!pincodeError}
                  aria-describedby={pincodeError ? 'welcome-pin-err' : undefined}
                  placeholder="6-digit pincode"
                  className="field h-11 w-full px-3 text-[14px] fig mt-2"
                  style={pincodeError ? { borderColor: 'var(--accent)' } : undefined}
                />
                <p
                  id={pincodeError ? 'welcome-pin-err' : undefined}
                  role={pincodeError ? 'alert' : undefined}
                  className="text-[11.5px] mt-2"
                  style={{ color: pincodeError ? 'var(--accent)' : 'var(--ink-3)' }}
                >
                  {pincodeError ?? `${region?.name ?? 'This city'} — 500001 to 500100, 520001 to 521456.`}
                </p>
                <button onClick={onStart} disabled={!ready} className="btn-primary h-12 w-full text-[14px] mt-3">
                  See prices
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <button onClick={onStart} className="btn-primary h-12 w-full text-[14px]">
                  Get started
                </button>
                <button
                  onClick={() => setNoAccounts(true)}
                  aria-describedby={noAccounts ? 'welcome-no-accounts' : undefined}
                  className="btn-ghost h-12 w-full text-[14px]"
                >
                  Log in / Sign up
                </button>
                {noAccounts ? (
                  <p id="welcome-no-accounts" role="status" className="text-[11.5px] leading-[1.55] fade-up" style={{ color: 'var(--ink-3)' }}>
                    There are no accounts yet, and nothing here is behind one — prices are public
                    and your estimate is saved on this device.{' '}
                    <button
                      onClick={() => { setNoAccounts(false); setAsking(true); }}
                      className="anim underline decoration-dotted underline-offset-2"
                      style={{ color: 'var(--accent)' }}
                    >
                      Set your delivery pincode
                    </button>{' '}
                    instead — it is what every price here is landed at.
                  </p>
                ) : (
                  <button onClick={() => setAsking(true)} className="anim text-[12px] mt-1 mx-auto min-h-8" style={{ color: 'var(--ink-3)' }}>
                    or set your delivery pincode first
                  </button>
                )}
              </div>
            )}
          </div>

          <ul className="grid grid-cols-4 gap-2 mt-7 pt-5 rule-t">
            {marks.map(({ Icon, label }) => (
              <li key={label} className="flex flex-col items-center gap-1.5 text-center">
                <Icon size={20} style={{ color: 'var(--accent)' }} />
                <span className="text-[9.5px] leading-[1.25]" style={{ color: 'var(--ink-3)' }}>{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
