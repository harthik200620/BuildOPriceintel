/**
 * The URL grammar of the explorer. Pure, so it can be tested without a DOM.
 *
 *   /                 the catalogue
 *   /welcome          the first run: the mark, what this is, and where to
 *                     deliver. Shown once — `prefs` remembers the pincode, and
 *                     a buyer who has one goes straight to the catalogue.
 *   /categories       every category as a list, live and coming-soon
 *   /c/<slug>         one category: every seller in it, with the filter rail
 *   /p/<product>      one seller's offer in full — the page the sheet used to
 *                     be. `?sku=` still opens the sheet over a listing; this is
 *                     the same product as a place of its own, which is what a
 *                     share, a back button and a deep link all want.
 *   /list             the estimate: what has been added, at what quantity
 *   /search?q=…       a query across categories
 *   /logo             the mark — the stitched "b" — laid over whatever view
 *                     was showing. It names no listing of its own, so it never
 *                     round-trips through buildUrl(); the explorer pushes it as
 *                     an entry of its own and back/× close it, like a sheet.
 *
 * Query, sort and facet selections ride in the query string, so a narrowed
 * listing is a link that can be sent and a back button that works. What stays
 * out of the URL is where the buyer is (region and pincode persist in
 * localStorage instead) and what they are comparing.
 */

import { catalogueBySlug, type CatalogueEntry } from './catalogue';

export type View =
  | { kind: 'home' }
  | { kind: 'welcome' }
  | { kind: 'categories' }
  | { kind: 'search' }
  | { kind: 'category'; entry: CatalogueEntry }
  | { kind: 'product'; productId: string }
  | { kind: 'list' }
  | { kind: 'logo' }
  | { kind: 'missing' };

export interface Loc {
  view: View;
  q: string;
  sort: string;
  selections: Record<string, string[]>;
  /** An open product sheet, so a product is a link and back closes it. */
  sku: string | null;
}

export const DEFAULT_SORT = 'recommended';

/** The mark's own URL. Pushed directly by the explorer, never built from a Loc. */
export const LOGO_PATH = '/logo';

/** The catalogue with nothing narrowed — what a hard-loaded /logo lays over. */
export const HOME_LOC: Loc = { view: { kind: 'home' }, q: '', sort: DEFAULT_SORT, selections: {}, sku: null };

/** What is on the page under the mark. /logo names no listing, so it is the
    pristine catalogue — a `?sku=` or `?q=` riding on /logo must not open a
    sheet or a search underneath the overlay. Any other Loc is itself. */
export const underlay = (l: Loc): Loc => (l.view.kind === 'logo' ? HOME_LOC : l);

export function parseLoc(pathname: string, search: string): Loc {
  const sp = new URLSearchParams(search);
  const segs = pathname.split('/').filter(Boolean);
  const q = sp.get('q') ?? '';
  let view: View;
  if (segs.length === 0) view = q ? { kind: 'search' } : { kind: 'home' };
  else if (segs.length === 1 && segs[0] === 'search') view = { kind: 'search' };
  else if (segs.length === 1 && segs[0] === 'logo') view = { kind: 'logo' };
  else if (segs.length === 1 && segs[0] === 'welcome') view = { kind: 'welcome' };
  else if (segs.length === 1 && segs[0] === 'categories') view = { kind: 'categories' };
  else if (segs.length === 1 && segs[0] === 'list') view = { kind: 'list' };
  else if (segs.length === 2 && segs[0] === 'p' && segs[1]) view = { kind: 'product', productId: decodeURIComponent(segs[1]) };
  else if (segs.length === 2 && segs[0] === 'c') {
    const e = catalogueBySlug(segs[1]);
    view = e ? { kind: 'category', entry: e } : { kind: 'missing' };
  } else view = { kind: 'missing' };

  const selections: Record<string, string[]> = {};
  for (const [k, v] of sp.entries()) if (k.startsWith('f.') && v) (selections[k.slice(2)] ??= []).push(v);
  return { view, q, sort: sp.get('sort') ?? DEFAULT_SORT, selections, sku: sp.get('sku') || null };
}

export function buildUrl(loc: Loc): string {
  // 'logo' deliberately falls through to '/': the mark is an overlay the
  // explorer pushes by hand (LOGO_PATH), never a view it writes from state.
  const path =
    loc.view.kind === 'search' ? '/search'
    : loc.view.kind === 'category' ? `/c/${loc.view.entry.slug}`
    : loc.view.kind === 'welcome' ? '/welcome'
    : loc.view.kind === 'categories' ? '/categories'
    : loc.view.kind === 'list' ? '/list'
    : loc.view.kind === 'product' ? `/p/${encodeURIComponent(loc.view.productId)}`
    : '/';
  const sp = new URLSearchParams();
  if (loc.q) sp.set('q', loc.q);
  if (loc.sort && loc.sort !== DEFAULT_SORT) sp.set('sort', loc.sort);
  for (const [f, vals] of Object.entries(loc.selections)) for (const v of vals) sp.append(`f.${f}`, v);
  if (loc.sku) sp.set('sku', loc.sku);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export const viewKey = (v: View) =>
  v.kind === 'category' ? `category:${v.entry.slug}`
  : v.kind === 'product' ? `product:${v.productId}`
  : v.kind;

/**
 * Which of the five tabs is lit. A product opened from a listing still belongs
 * to the shelf it was found on, so it holds "categories" rather than lighting
 * nothing — a tab bar that goes blank on the deepest screen reads as broken.
 */
export type Tab = 'home' | 'categories' | 'search' | 'list' | 'where';

export function tabOf(v: View): Tab | null {
  switch (v.kind) {
    case 'home': return 'home';
    case 'categories':
    case 'category':
    case 'product': return 'categories';
    case 'search': return 'search';
    case 'list': return 'list';
    default: return null;
  }
}
