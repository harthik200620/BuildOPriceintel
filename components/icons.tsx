import React from 'react';
import type { CatalogueIcon } from '@/lib/catalogue';

/**
 * One line-icon family for the catalogue and the trust bar. Every glyph is
 * drawn on the same 24-unit grid at the same 1.6 stroke with round joins, in
 * currentColor, so the set reads as one hand whether it sits white in a card
 * band or aqua in the trust bar. Nothing here is imported from an icon pack:
 * a rebar bundle, a 50 kg bag and a pipe elbow are not in any of them.
 */

type P = React.SVGProps<SVGSVGElement> & { size?: number; strokeWidth?: number };

function Svg({ size = 22, strokeWidth = 1.6, children, ...rest }: P) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      aria-hidden focusable="false" {...rest}
    >
      {children}
    </svg>
  );
}

/* ── categories ─────────────────────────────────────────────────────────── */

/** A 50 kg bag: valve-top sack with the seam and the round brand mark. */
export const IconCement = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 5.5h11A1.5 1.5 0 0 1 19 7v12.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5V7a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M8 5.5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1.5M5 9.5h14" />
    <circle cx="12" cy="15" r="2.4" />
  </Svg>
);

/** Reinforcement — two bars over two, tied where they cross, as a mesh is laid. */
export const IconTmt = (p: P) => (
  <Svg {...p}>
    <path d="M8.5 3v18M15.5 3v18M3 8.5h18M3 15.5h18" strokeWidth={(p.strokeWidth ?? 1.6) + 0.3} />
    <path d="M7 7l3 3M14 7l3 3M7 14l3 3M14 14l3 3" strokeWidth={1.1} opacity=".75" />
  </Svg>
);

/** A running-bond wall — three courses, staggered. */
export const IconBricks = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="5.5" width="18" height="13" rx="1" />
    <path d="M3 10h18M3 14.2h18M9 5.5V10M15 5.5V10M6 10v4.2M12 10v4.2M18 10v4.2M9 14.2v4.3M15 14.2v4.3" />
  </Svg>
);

/** A pipe elbow — two walls of the bend and the socket ends. */
export const IconPipes = (p: P) => (
  <Svg {...p}>
    <path d="M4 5.5h6.5A6.5 6.5 0 0 1 17 12v6.5" />
    <path d="M4 10h6.5a2 2 0 0 1 2 2v6.5" />
    <path d="M3 4.5v6.5M11.5 19.5H18" />
  </Svg>
);

/** A heap of crushed stone. */
export const IconAggregates = (p: P) => (
  <Svg {...p}>
    <path d="M3 19.5h18" />
    <path d="M12 8.2 9.6 12.6l2.4 4.4 2.4-4.4z" />
    <path d="M6.6 13.4 4.6 17h4z M17.4 13.4l-2 3.6h4z" />
    <path d="M9.6 12.6 6.6 13.4M14.4 12.6l3 .8" />
  </Svg>
);

/** A mound of sand, sieved fine. */
export const IconSand = (p: P) => (
  <Svg {...p}>
    <path d="M2.5 18.5c3.2-4.6 6.3-9.3 9.5-11.5 3.2 2.2 6.3 6.9 9.5 11.5Z" />
    <path d="M9.5 15.2h.01M12.5 12.4h.01M14.6 15.6h.01M11.2 17h.01" strokeWidth={2.2} />
    <path d="M2 21h20" />
  </Svg>
);

/** A transit mixer. */
export const IconRmc = (p: P) => (
  <Svg {...p}>
    <path d="M3.5 13.5 5.2 7h6.6l1.7 6.5" />
    <path d="M2.5 13.5h12.5v3.2H2.5zM15 11.5h3.2l2.8 3.1v2.1H15z" />
    <circle cx="6.2" cy="18.3" r="1.7" /><circle cx="17.5" cy="18.3" r="1.7" />
    <path d="M6.6 10.5h4" />
  </Svg>
);

/** A bolt. */
export const IconElectricals = (p: P) => (
  <Svg {...p}>
    <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" />
  </Svg>
);

export const CATALOGUE_ICON: Record<CatalogueIcon, (p: P) => React.JSX.Element> = {
  cement: IconCement,
  tmt_steel: IconTmt,
  bricks_blocks: IconBricks,
  water_pipes: IconPipes,
  aggregates: IconAggregates,
  sand: IconSand,
  rmc: IconRmc,
  electricals: IconElectricals,
};

export function CategoryIcon({ name, ...p }: P & { name: CatalogueIcon }) {
  const C = CATALOGUE_ICON[name];
  return <C {...p} />;
}

/* ── the trust bar ──────────────────────────────────────────────────────── */

/** A pin — the price is landed where the pin is. */
export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M12 21.5s-6.5-5.6-6.5-10.9a6.5 6.5 0 0 1 13 0c0 5.3-6.5 10.9-6.5 10.9Z" />
    <circle cx="12" cy="10.6" r="2.4" />
  </Svg>
);

/** A clock with the tick — freshness stated, then checked. */
export const IconClockCheck = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5v4.8l3 1.8" />
    <path d="M17.5 17.5l1.4 1.4 3-3" />
  </Svg>
);

/** Sellers — a shopfront. */
export const IconStorefront = (p: P) => (
  <Svg {...p}>
    <path d="M4 10.5V20h16v-9.5" />
    <path d="M3 7.5 5 3.5h14l2 4a2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-5 0 2.5 2.5 0 0 1-3 0Z" />
    <path d="M9.5 20v-5.5h5V20" />
  </Svg>
);

/** A ranked list with its rule stated. */
export const IconRankList = (p: P) => (
  <Svg {...p}>
    <path d="M4 6.5h10M4 12h7.5M4 17.5h5" />
    <path d="M18 4.5v15M15 16.5l3 3 3-3" />
  </Svg>
);

/* ── chrome ─────────────────────────────────────────────────────────────── */

export const IconArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 12h15M13.5 6l6 6-6 6" />
  </Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);

export const IconFilter = (p: P) => (
  <Svg {...p}>
    <path d="M3 5.5h18M6.5 12h11M10 18.5h4" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Svg>
);
