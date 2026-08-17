/**
 * The catalogue as the home page presents it — one entry per category card.
 *
 * Two kinds of entry, and the difference is load-bearing:
 *
 *   live  — a category the collector actually tracks. It has a DB `id`
 *           (product.category), a canonical unit, a filter tree, and a real
 *           listing behind its card. Everything printed on the card comes from
 *           /api/meta at render time; nothing here is a number.
 *   soon  — a category the store does not hold yet. Its card is shown so the
 *           catalogue reads as a whole, and it is labelled "coming soon" and is
 *           not a link. It never shows a count, a price, or a seller. A card
 *           that invented "from ₹—" for a category with no offers would break
 *           the one rule this application is built on.
 *
 * The taglines are written from the filter trees in filters/*.json — the
 * families and grades named are the ones the catalogue actually contains.
 */

import { CANONICAL_UNITS, UNIT_LABEL, type CanonicalUnit } from './units';

export type CatalogueIcon =
  | 'cement' | 'tmt_steel' | 'bricks_blocks' | 'water_pipes'
  | 'aggregates' | 'sand' | 'rmc' | 'electricals';

export interface CatalogueEntry {
  /** DB category id for live entries; a stable key for coming-soon ones. */
  id: string;
  /** URL segment under /c/. */
  slug: string;
  /** Sentence-case label, identical to CATEGORY_LABEL for live entries. */
  label: string;
  /** One line under the name: what the category holds, in the buyer's terms. */
  tagline: string;
  /** Landed price is quoted per this unit. Null until the category is tracked. */
  unit: CanonicalUnit | null;
  image: string;
  icon: CatalogueIcon;
  live: boolean;
}

export const CATALOGUE: readonly CatalogueEntry[] = [
  {
    id: 'cement', slug: 'cement', label: 'Cement',
    tagline: 'OPC, PPC, PSC and white — 33, 43 and 53 grade',
    unit: 'bag', image: '/categories/cement.webp', icon: 'cement', live: true,
  },
  {
    id: 'tmt_steel', slug: 'tmt-steel', label: 'TMT steel',
    tagline: 'Fe 500, 500D, 550 and 550D — 8 to 25 mm',
    unit: 'kg', image: '/categories/tmt-steel.webp', icon: 'tmt_steel', live: true,
  },
  {
    id: 'bricks_blocks', slug: 'bricks-blocks', label: 'Bricks & blocks',
    tagline: 'Red clay, fly ash, AAC, CLC, concrete solid and hollow',
    unit: 'piece', image: '/categories/bricks-blocks.webp', icon: 'bricks_blocks', live: true,
  },
  {
    id: 'water_pipes', slug: 'water-pipes', label: 'Water pipes',
    tagline: 'CPVC, uPVC, SWR and HDPE — 15 to 110 mm bore',
    unit: 'running_metre', image: '/categories/water-pipes.webp', icon: 'water_pipes', live: true,
  },
  {
    id: 'aggregates', slug: 'aggregates', label: 'Aggregates',
    tagline: 'Crushed stone — 10, 20 and 40 mm metal',
    unit: null, image: '/categories/aggregates.webp', icon: 'aggregates', live: false,
  },
  {
    id: 'sand', slug: 'sand', label: 'Sand',
    tagline: 'River sand, M-sand and plastering sand',
    unit: null, image: '/categories/sand.webp', icon: 'sand', live: false,
  },
  {
    id: 'ready_mix_concrete', slug: 'ready-mix-concrete', label: 'Ready mix concrete',
    tagline: 'M20 to M40, delivered by transit mixer',
    unit: null, image: '/categories/ready-mix-concrete.webp', icon: 'rmc', live: false,
  },
  {
    id: 'electricals', slug: 'electricals', label: 'Electricals',
    tagline: 'House wires, switches, MCBs and distribution boards',
    unit: null, image: '/categories/electricals.webp', icon: 'electricals', live: false,
  },
] as const;

export const LIVE_CATALOGUE = CATALOGUE.filter((c) => c.live);

const BY_SLUG = new Map(CATALOGUE.map((c) => [c.slug, c]));
const BY_ID = new Map(CATALOGUE.map((c) => [c.id, c]));

/** Only live categories resolve from a URL — a coming-soon slug is a 404. */
export function catalogueBySlug(slug: string | null | undefined): CatalogueEntry | null {
  if (!slug) return null;
  const c = BY_SLUG.get(slug);
  return c && c.live ? c : null;
}

export function catalogueById(id: string | null | undefined): CatalogueEntry | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** "/bag", "/kg" — the suffix that follows a landed figure on a card. */
export function unitSuffix(unit: CanonicalUnit | null): string {
  if (!unit) return '';
  return UNIT_LABEL[unit] ?? `/${unit}`;
}

// A compile-time check that every live unit is one the price surface knows.
for (const c of CATALOGUE) {
  if (c.live && (!c.unit || !(CANONICAL_UNITS as readonly string[]).includes(c.unit))) {
    throw new Error(`catalogue: ${c.id} is live without a canonical unit`);
  }
}
