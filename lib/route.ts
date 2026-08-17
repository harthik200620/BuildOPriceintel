/**
 * The URL grammar of the explorer. Pure, so it can be tested without a DOM.
 *
 *   /                 the catalogue
 *   /c/<slug>         one category: every seller in it, with the filter rail
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
  | { kind: 'search' }
  | { kind: 'category'; entry: CatalogueEntry }
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
    : '/';
  const sp = new URLSearchParams();
  if (loc.q) sp.set('q', loc.q);
  if (loc.sort && loc.sort !== DEFAULT_SORT) sp.set('sort', loc.sort);
  for (const [f, vals] of Object.entries(loc.selections)) for (const v of vals) sp.append(`f.${f}`, v);
  if (loc.sku) sp.set('sku', loc.sku);
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export const viewKey = (v: View) => (v.kind === 'category' ? `category:${v.entry.slug}` : v.kind);
