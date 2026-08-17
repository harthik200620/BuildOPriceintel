'use client';

import React from 'react';
import { CATALOGUE, unitSuffix, type CatalogueEntry } from '@/lib/catalogue';
import type { CategoryStat } from '@/lib/meta';
import { SLA_HOURS, CATEGORY_VOLATILITY, ageHours, humaniseAge } from '@/lib/freshness';
import { formatIST } from '@/lib/when';
import { rupees, UNIT_SPOKEN } from '@/components/primitives';
import {
  CategoryIcon, IconArrowRight, IconPin, IconClockCheck, IconStorefront, IconRankList,
} from '@/components/icons';

/**
 * The landing view. Reads as the catalogue: a heading, eight category cards,
 * and the four things every price on the site carries. Everything printed on a
 * live card is measured (lib/meta.ts categoryStats) — the seller count is the
 * same number the listing's heading will show, from the same rows. A
 * coming-soon card prints no figure at all.
 */
export default function Home({
  meta, regionId, regionName, hrefFor, onOpen,
}: {
  meta: any | null;
  regionId: string;
  regionName: string;
  hrefFor: (c: CatalogueEntry) => string;
  onOpen: (c: CatalogueEntry) => void;
}) {
  const region = meta?.regions?.find((r: any) => r.region_id === regionId);
  const stats: CategoryStat[] = region?.stats ?? [];

  // Relative ages are computed against meta.now — the server's clock at the
  // request — for both the server render and hydration, so the two agree to
  // the character. After mount the clock ticks forward once a minute.
  const [tick, setTick] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setTick(new Date());
    const id = setInterval(() => setTick(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = tick ?? (meta?.now ? new Date(meta.now) : new Date(0));
  const statFor = (id: string) => stats.find((s) => s.category === id) ?? null;
  const live = CATALOGUE.filter((c) => c.live).length;

  return (
    <div className="home fade-up">
      {/* ── the heading ──────────────────────────────────────────────────── */}
      <header className="text-center pt-6 sm:pt-8 lg:pt-9 pb-6 sm:pb-7">
        <p className="eyebrow">Explore</p>
        <h1 className="display home-title mt-2.5" style={{ textWrap: 'balance' }}>
          Product <span style={{ color: 'var(--accent-ink)' }}>categories</span>
        </h1>
        <p className="mx-auto mt-3 max-w-[58ch] text-[14.5px] sm:text-[15.5px] leading-relaxed" style={{ color: 'var(--ink-2)', textWrap: 'balance' }}>
          Landed prices for every step of your build — delivered to your pincode, GST stated, per unit.
        </p>
        <p className="mt-1.5 text-[12.5px] tnum" style={{ color: 'var(--ink-3)' }}>
          {live} categories tracked in {regionName} today · four more on the way
        </p>
      </header>

      {/* ── the catalogue ────────────────────────────────────────────────── */}
      <ul className="cat-grid" aria-label="Product categories">
        {CATALOGUE.filter((c) => c.live).map((c, i) => (
          <li key={c.id} className="min-w-0">
            <LiveCard entry={c} stat={statFor(c.id)} href={hrefFor(c)} onOpen={() => onOpen(c)} eager={i < 4} now={now} />
          </li>
        ))}
      </ul>
      {/* The four not yet tracked. Their own row so a phone can set them small:
          on a 390 px screen the live cards run full width and these run two
          across, which keeps every card on the page without four screens of
          cards that cannot be opened. */}
      <ul className="cat-grid cat-grid--soon" aria-label="Categories coming soon">
        {CATALOGUE.filter((c) => !c.live).map((c) => (
          <li key={c.id} className="min-w-0"><SoonCard entry={c} /></li>
        ))}
      </ul>

      {/* ── the trust bar ────────────────────────────────────────────────── */}
      <TrustBar meta={meta} />

      {/* ── the ground truth, stated ─────────────────────────────────────── */}
      <footer className="home-foot">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 justify-between">
          <p className="text-[12.5px] leading-relaxed max-w-[70ch]" style={{ color: 'var(--ink-3)' }}>
            Every figure is a price a seller published, landed at your pincode. Where a number is
            derived rather than quoted, it says so. Nothing on this site is invented.
          </p>
          <p className="text-[12px] tnum whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>
            {meta?.last_run?.finished_at
              ? <>Data refreshed {formatIST(meta.last_run.finished_at)} IST</>
              : <span className="skel inline-block h-3 w-40 align-middle" aria-hidden />}
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ── cards ───────────────────────────────────────────────────────────────── */

function LiveCard({
  entry, stat, href, onOpen, eager, now,
}: { entry: CatalogueEntry; stat: CategoryStat | null; href: string; onOpen: () => void; eager: boolean; now: Date }) {
  const suffix = unitSuffix(entry.unit);
  const spoken = entry.unit ? UNIT_SPOKEN[entry.unit] : '';

  // The card's freshness is the age of the newest price in the category, held
  // against the category's own SLA — cement is a 24 h commodity, pipes are a
  // week. The listing behind the card carries a dot per seller.
  let ageLabel: string | null = null;
  let ageTone: 'fresh' | 'ageing' | 'stale' = 'stale';
  if (stat?.seen_at && now.getTime() > 0) {
    const h = Math.max(0, ageHours(stat.seen_at, now));
    const sla = SLA_HOURS[CATEGORY_VOLATILITY[entry.id] ?? 'V0'] ?? 24;
    ageLabel = humaniseAge(h);
    ageTone = h <= sla ? 'fresh' : h <= sla * 2 ? 'ageing' : 'stale';
  }

  return (
    <a
      href={href}
      onClick={(e) => {
        // Plain left-click is a client-side navigation; a modified click or a
        // middle-click keeps its browser meaning (new tab), which the href
        // already serves.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen();
      }}
      className="cat-card lift group"
      title={entry.tagline}
      aria-label={
        stat
          ? `${entry.label}: ${stat.offers.toLocaleString('en-IN')} offers from ${stat.sellers.toLocaleString('en-IN')} sellers, from ${rupees(stat.lo_paise)} ${spoken}. Open the listing.`
          : `${entry.label}. Open the listing.`
      }
    >
      <div className="cat-photo">
        <img
          src={entry.image} alt="" aria-hidden draggable={false}
          loading={eager ? 'eager' : 'lazy'} decoding="async"
          fetchPriority={eager ? 'high' : 'auto'}
        />
        <span className="cat-photo-fade" aria-hidden />

        {ageLabel && (
          <span className={`cat-age cat-age--${ageTone}`} title={`Newest price in this category was seen ${ageLabel}`}>
            <span className="dot" aria-hidden />
            updated {ageLabel}
          </span>
        )}

        <div className="cat-data" aria-hidden>
          {stat ? (
            <>
              <span className="cat-from">
                <span className="cat-from-label">from</span>{' '}
                <span className="fig">{rupees(stat.lo_paise, stat.lo_paise < 10_000)}</span>
                <span className="cat-from-unit">{suffix}</span>
              </span>
              <span className="cat-counts tnum">
                {stat.offers.toLocaleString('en-IN')} offers · {stat.sellers.toLocaleString('en-IN')} sellers
              </span>
            </>
          ) : (
            <>
              <span className="skel h-4 w-24 inline-block" />
              <span className="skel h-3 w-28 inline-block" />
            </>
          )}
        </div>
      </div>

      <div className="cat-band">
        <span className="cat-icon"><CategoryIcon name={entry.icon} size={22} /></span>
        <span className="cat-name min-w-0 flex-1">{entry.label}</span>
        <span className="cat-arrow"><IconArrowRight size={20} strokeWidth={1.8} /></span>
      </div>
    </a>
  );
}

function SoonCard({ entry }: { entry: CatalogueEntry }) {
  return (
    <div
      className="cat-card cat-card--soon"
      aria-disabled="true"
      title={`${entry.tagline}. Not tracked yet — we never show a price we have not seen.`}
    >
      <div className="cat-photo">
        <img src={entry.image} alt="" aria-hidden draggable={false} loading="lazy" decoding="async" />
        <span className="cat-photo-fade" aria-hidden />
        <span className="cat-soon">Coming soon</span>
      </div>
      <div className="cat-band">
        <span className="cat-icon"><CategoryIcon name={entry.icon} size={22} /></span>
        <span className="cat-name min-w-0 flex-1">{entry.label}</span>
        <span className="cat-soon-mark">Soon</span>
      </div>
    </div>
  );
}

/* ── the trust bar ───────────────────────────────────────────────────────── */

function TrustBar({ meta }: { meta: any | null }) {
  const t = meta?.totals;
  const n = (v: number | undefined) => (typeof v === 'number' ? v.toLocaleString('en-IN') : null);
  const items = [
    {
      Icon: IconPin, title: 'Landed prices',
      body: 'Freight, GST and handling to your pincode, stated per unit.',
    },
    {
      Icon: IconClockCheck, title: 'Freshness declared',
      body: 'Every price shows when it was seen. A stale one says so.',
    },
    {
      Icon: IconStorefront, title: 'Sellers compared',
      body: t
        ? <>{n(t.sellers)} sellers · {n(t.offers)} live offers across Hyderabad and Vijayawada, one card per seller.</>
        : <span className="skel inline-block h-3 w-44 align-middle" aria-hidden />,
    },
    {
      Icon: IconRankList, title: 'Ranking disclosed',
      body: 'The sort names what it sorted on, in plain words.',
    },
  ];
  return (
    <section className="trust" aria-label="What every price here carries">
      <ul className="trust-list">
        {items.map(({ Icon, title, body }) => (
          <li key={title} className="trust-item">
            <span className="trust-icon"><Icon size={30} strokeWidth={1.4} /></span>
            <span className="min-w-0">
              <span className="trust-title">{title}</span>
              <span className="trust-body">{body}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
