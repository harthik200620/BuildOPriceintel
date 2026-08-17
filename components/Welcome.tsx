'use client';

import React from 'react';
import type { Region } from './TopBar';
import { IconCheck, IconStorefront, IconClockCheck, IconPin } from './icons';

/**
 * The first screen, and the only one that asks for anything.
 *
 * It asks for one thing — where to deliver — because that is the single input
 * every figure on this site depends on: a price here is landed at a pincode,
 * inclusive of freight and GST, and without one there is no price to show. So
 * the second action is not "sign up", it is the pincode, and the buyer who
 * gives it never sees this screen again.
 *
 * There is no account, and this screen does not pretend there is. Nothing is
 * saved anywhere but this browser, and nothing is behind a login, so a sign-in
 * button would be a door onto a wall.
 */
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
  const pinRef = React.useRef<HTMLInputElement | null>(null);
  const region = regions.find((r) => r.region_id === regionId);
  const ready = /^\d{6}$/.test(pincode) && !pincodeError;

  React.useEffect(() => { if (asking) pinRef.current?.focus(); }, [asking]);

  const marks = [
    { Icon: IconCheck, label: 'Quality materials' },
    { Icon: IconStorefront, label: 'Trusted brands' },
    { Icon: IconClockCheck, label: 'Fresh prices' },
    { Icon: IconPin, label: 'Landed to you' },
  ];

  return (
    <div className="welcome fade-up">
      <img
        src="/logo-mark-128.png"
        width={56} height={56} alt="" aria-hidden
        className="select-none"
        style={{ filter: 'drop-shadow(0 0 18px rgba(92,225,230,.30))' }}
        draggable={false}
      />

      <p className="text-[11px] uppercase mt-6" style={{ color: 'var(--accent)', letterSpacing: '.22em' }}>
        Welcome to
      </p>
      <h1 className="display leading-[1.04] mt-2" style={{ fontSize: 'clamp(34px, 11vw, 46px)' }}>
        <span style={{ color: 'var(--ink)' }}>BUILD</span><br />
        <span style={{ color: 'var(--accent)' }}>OBJECTS</span>
      </h1>
      <p className="text-[13.5px] leading-[1.55] mt-4 max-w-[34ch]" style={{ color: 'var(--ink-2)' }}>
        What construction materials actually cost in Hyderabad and Vijayawada — every
        price landed at your pincode, GST stated, per unit.
      </p>

      <div className="welcome-art">
        {/* A photograph of the material, not a stock building: every image on
            this site was downloaded at collection time from a listing, and
            there is no rendered skyline among them. */}
        <img src="/categories/tmt-steel.webp" alt="" aria-hidden loading="eager" />
      </div>

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
          <button onClick={() => setAsking(true)} className="btn-ghost h-12 w-full text-[14px]">
            Set delivery pincode
          </button>
        </div>
      )}

      <ul className="grid grid-cols-4 gap-2 mt-7 pt-5 rule-t">
        {marks.map(({ Icon, label }) => (
          <li key={label} className="flex flex-col items-center gap-1.5 text-center">
            <Icon size={20} style={{ color: 'var(--accent)' }} />
            <span className="text-[9.5px] leading-[1.25]" style={{ color: 'var(--ink-3)' }}>{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
