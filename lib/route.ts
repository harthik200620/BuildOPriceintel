/**
 * The URL grammar of the explorer. Pure, so it can be tested without a DOM.
 *
 *   /                 the catalogue
 *   /c/<slug>         one category: every seller in it, with the filter rail
 *   /search?q=…       a query across categories
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

export function parseLoc(pathname: string, search: string): Loc {
  const sp = new URLSearchParams(search);
  const segs = pathname.split('/').filter(Boolean);
  const q = sp.get('q') ?? '';
  let view: View;
  if (segs.length === 0) view = q ? { kind: 'search' } : { kind: 'home' };
  else if (segs.length === 1 && segs[0] === 'search') view = { kind: 'search' };
  else if (segs.length === 2 && segs[0] === 'c') {
    const e = catalogueBySlug(segs[1]);
    view = e ? { kind: 'category', entry: e } : { kind: 'missing' };
  } else view = { kind: 'missing' };

  const selections: Record<string, string[]> = {};
  for (const [k, v] of sp.entries()) if (k.startsWith('f.') && v) (selections[k.slice(2)] ??= []).push(v);
  return { view, q, sort: sp.get('sort') ?? DEFAULT_SORT, selections, sku: sp.get('sku') || null };
}

export function buildUrl(loc: Loc): string {
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
