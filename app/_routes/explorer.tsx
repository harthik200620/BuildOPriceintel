import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import Explorer from '@/components/Explorer';
import { buildMeta } from '@/lib/meta';
import { armNetworkGuard } from '@/lib/no-network';
import { catalogueBySlug } from '@/lib/catalogue';

/**
 * One tree, three views. The catalogue (/), a category (/c/cement) and a
 * search (/search?q=…) all render the same client Explorer: moving between
 * them is a pushState, not a remount, so the search field keeps focus, the
 * compare tray keeps its items and the assistant keeps its thread. The
 * server's job is to say which view the URL names, 404 the ones it does not,
 * and hand over the metadata already computed so the catalogue paints with
 * its counts in it.
 *
 * Two route files share this — app/page.tsx for "/" and app/[...slug]/page.tsx
 * for everything else — rather than one optional catch-all, because Turbopack
 * (16.2) panics computing the root endpoint's loader tree from [[...slug]]
 * and the dev client then reloads in a loop. Same tree either way.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

export type Search = Record<string, string | string[] | undefined>;

export function resolveRoute(slug: string[] | undefined) {
  const s = slug ?? [];
  if (s.length === 0) return { kind: 'home' as const };
  if (s.length === 1 && s[0] === 'search') return { kind: 'search' as const };
  // The mark. Same tree: the explorer renders the catalogue underneath and
  // the stitched "b" over it, so × and back land on a live page.
  if (s.length === 1 && s[0] === 'logo') return { kind: 'logo' as const };
  // The app flow. These name no listing of their own — the client resolves
  // what they show — so they are admitted by name and their content is the
  // explorer's business, exactly as /search is.
  if (s.length === 1 && s[0] === 'welcome') return { kind: 'welcome' as const };
  if (s.length === 1 && s[0] === 'categories') return { kind: 'categories' as const };
  if (s.length === 1 && s[0] === 'list') return { kind: 'list' as const };
  // A product id is not validated here: doing so would mean a DB read on every
  // crawl of a URL the client fetches anyway, and ProductPage already renders
  // "not in the catalogue" for an id that resolves to nothing.
  if (s.length === 2 && s[0] === 'p' && s[1]) return { kind: 'product' as const, productId: s[1] };
  if (s.length === 2 && s[0] === 'c') {
    const entry = catalogueBySlug(s[1]);
    if (entry) return { kind: 'category' as const, entry };
  }
  return null;
}

export function metadataFor(slug: string[] | undefined): Metadata {
  const route = resolveRoute(slug);
  if (!route) return { title: 'Not found — Build Objects' };
  if (route.kind === 'logo') return { title: 'Build Objects — the mark', robots: { index: false, follow: true } };
  if (route.kind === 'category') {
    const { label, tagline } = route.entry;
    return {
      title: `${label} prices in Hyderabad & Vijayawada — Build Objects`,
      description: `${label}: ${tagline}. Landed prices per unit, delivered to your pincode, from every seller we track — with the freshness of each price stated.`,
    };
  }
  if (route.kind === 'search') return { title: 'Search — Build Objects' };
  if (route.kind === 'welcome') return { title: 'Welcome — Build Objects', robots: { index: false, follow: true } };
  if (route.kind === 'categories') {
    return {
      title: 'Categories — Build Objects',
      description: 'Every construction material category we track in Hyderabad and Vijayawada, and the ones on the way.',
    };
  }
  // The estimate is one browser's own list; there is nothing here to index.
  if (route.kind === 'list') return { title: 'My estimate — Build Objects', robots: { index: false, follow: false } };
  if (route.kind === 'product') {
    return {
      title: 'Product details — Build Objects',
      description: 'Landed price, seller, certification and freshness for one product, delivered to your pincode.',
    };
  }
  return {
    title: 'Build Objects Price Intelligence',
    description:
      'Delivered, pincode-resolved, GST-stated, unit-normalised, timestamped prices for construction materials in Hyderabad and Vijayawada.',
  };
}

function toQueryString(sp: Search): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) out.append(k, x);
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export function ExplorerRoute({ slug, searchParams }: { slug: string[] | undefined; searchParams: Search }) {
  const route = resolveRoute(slug);
  if (!route) notFound();

  const path = '/' + (slug ?? []).join('/');
  const search = toQueryString(searchParams);
  // Through JSON once: guarantees the object crossing to the client is plain
  // data — the same shape /api/meta serves — and never a function or a Date.
  const meta = JSON.parse(JSON.stringify(buildMeta()));

  return (
    <Suspense>
      <Explorer initialMeta={meta} initialPath={path} initialSearch={search} />
    </Suspense>
  );
}
