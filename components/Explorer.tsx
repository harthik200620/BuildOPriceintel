'use client';

import React from 'react';
import { COMPARABILITY_NOTE, type SearchResponse, type ProductCard as Card } from '@/lib/types';
import TopBar, { type Region } from '@/components/TopBar';
import FilterRail, { FilterSheet } from '@/components/FilterRail';
import ProductCardView from '@/components/ProductCard';
import ResultsTable from '@/components/ResultsTable';
import DetailSheet from '@/components/DetailSheet';
import CompareTray from '@/components/CompareTray';
import ChatPanel from '@/components/ChatPanel';
import Home from '@/components/Home';
import {
  ResultsSkeleton, ZeroResult, NoDataYet, EmptyCategory, ErrorState, OfflineBanner, DegradedBanner,
} from '@/components/States';
import { rupees, UNIT_SPOKEN } from '@/components/primitives';
import { LIVE_CATALOGUE, catalogueById, unitSuffix, type CatalogueEntry } from '@/lib/catalogue';
import { parseLoc, buildUrl, viewKey, type Loc } from '@/lib/route';
import { readWhere, writeWhere } from '@/lib/prefs';
import { CategoryIcon, IconChevronRight, IconFilter } from '@/components/icons';

const DEBOUNCE_MS = 80;
/* No spinner under 150 ms — otherwise it is only ever a flash. */
const SPINNER_AFTER_MS = 150;
/** How many sellers to fetch. 24 is a page; the control below shows all. */
const PAGE = 24;

/* The URL is the view — see lib/route.ts for the grammar. The explorer holds
   the parsed location as state, writes it back with pushState/replaceState,
   and re-parses on popstate. Nothing else moves the URL from outside. */

export default function Explorer({
  initialMeta, initialPath, initialSearch,
}: {
  initialMeta: any | null;
  initialPath: string;
  initialSearch: string;
}) {
  const [meta, setMeta] = React.useState<any>(initialMeta);
  const [regionId, setRegionId] = React.useState('hyderabad');
  const [pincode, setPincode] = React.useState('500001');
  const [pincodeError, setPincodeError] = React.useState<string | null>(null);

  const [loc, setLoc] = React.useState<Loc>(() => parseLoc(initialPath, initialSearch));
  const { view, q: query, sort, selections } = loc;
  const category = view.kind === 'category' ? view.entry.id : null;
  const entry = view.kind === 'category' ? view.entry : null;

  // Drilling into one seller's stock — set by a card's "+N more from this seller".
  const [vendorFilter, setVendorFilter] = React.useState<{ id: string; name: string } | null>(null);
  const [inStockOnly, setInStockOnly] = React.useState(false);
  const [layout, setLayout] = React.useState<'cards' | 'table'>('cards');
  const [limit, setLimit] = React.useState(PAGE);
  /** A table column header. Drives the server sort, not a client reorder. */
  const [colSort, setColSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const [data, setData] = React.useState<SearchResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showSpinner, setShowSpinner] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [offline, setOffline] = React.useState(false);

  // The open product sheet is the URL's `sku` — a product is a link, and on a
  // phone the back button closes it.
  const openSku = loc.sku;
  const sheetPushed = React.useRef(false);
  // Which seller's card opened the sheet, so their row can be marked in the table.
  const [openVendor, setOpenVendor] = React.useState<string | null>(null);
  // And which listing — a seller can post the same product twice at two prices.
  const [openOffer, setOpenOffer] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<Card[]>([]);
  const [saved, setSaved] = React.useState<Card[]>([]);
  const [railCollapsed, setRailCollapsed] = React.useState(false);
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);

  /* ── navigation ─────────────────────────────────────────────────────── */

  const navigate = React.useCallback((next: Loc, mode: 'push' | 'replace', scrollTop = true) => {
    setLoc(next);
    if (typeof window === 'undefined') return;
    const url = buildUrl(next);
    const here = window.location.pathname + window.location.search;
    // A push to the URL already shown would only stack a duplicate entry.
    if (mode === 'push' && url !== here) {
      window.history.pushState(null, '', url);
      if (scrollTop) window.scrollTo({ top: 0 });
    } else if (url !== here) {
      window.history.replaceState(null, '', url);
    }
  }, []);

  // Back and forward. Nothing else moves the URL from outside: every link in
  // this tree goes through navigate(), and a full load re-parses on mount.
  React.useEffect(() => {
    const onPop = () => {
      const next = parseLoc(window.location.pathname, window.location.search);
      if (!next.sku) sheetPushed.current = false;
      setLoc(next);
    };
    window.addEventListener('popstate', onPop);
    // The URL can move before this listener exists — a back press during a
    // slow hydration, say. The server rendered the URL it was asked for; if
    // the address bar now says something else, the address bar is right.
    const here = parseLoc(window.location.pathname, window.location.search);
    setLoc((cur) => (buildUrl(cur) === buildUrl(here) ? cur : here));
    // A marker for tests and tooling: the tree is live from here on.
    document.documentElement.dataset.hydrated = '1';
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** Open a product sheet: a history entry of its own, so back closes it and
      the URL can be sent. Closing from the sheet's own control walks back over
      that entry when it exists, and otherwise just drops the parameter. */
  const openSheet = React.useCallback((productId: string) => {
    if (loc.sku === productId) return;
    sheetPushed.current = true;
    navigate({ ...loc, sku: productId }, 'push', false);
  }, [loc, navigate]);

  const closeSheet = React.useCallback(() => {
    setOpenVendor(null); setOpenOffer(null);
    if (sheetPushed.current && window.history.length > 1) {
      sheetPushed.current = false;
      window.history.back();
    } else {
      navigate({ ...loc, sku: null }, 'replace', false);
    }
  }, [loc, navigate]);

  const leaveListing = React.useCallback(() => {
    setVendorFilter(null);
    setColSort(null);
    setSheetOpen(false);
  }, []);

  const goHome = React.useCallback(() => {
    leaveListing();
    navigate({ view: { kind: 'home' }, q: '', sort: 'recommended', selections: {}, sku: null }, 'push');
  }, [navigate, leaveListing]);

  const openCategory = React.useCallback((e: CatalogueEntry, keepQuery = false) => {
    leaveListing();
    navigate({ view: { kind: 'category', entry: e }, q: keepQuery ? loc.q : '', sort: 'recommended', selections: {}, sku: null }, 'push');
  }, [navigate, leaveListing, loc.q]);

  const searchEverywhere = React.useCallback((q: string) => {
    leaveListing();
    navigate({ view: { kind: 'search' }, q, sort: 'recommended', selections: {}, sku: null }, 'push');
  }, [navigate, leaveListing]);

  /** Typing. The first character on the catalogue is a navigation into search;
      after that the field edits the URL in place. Inside a category the query
      narrows that category. */
  const setQuery = React.useCallback((q: string) => {
    if (view.kind === 'home' || view.kind === 'missing') {
      if (!q) return;
      navigate({ view: { kind: 'search' }, q, sort: 'recommended', selections: {}, sku: null }, 'push');
      return;
    }
    navigate({ ...loc, q }, 'replace');
  }, [view.kind, loc, navigate]);

  const setSort = React.useCallback((s: string) => navigate({ ...loc, sort: s }, 'replace'), [loc, navigate]);

  const toggleFacet = React.useCallback((fid: string, value: string, single: boolean) => {
    const cur = loc.selections[fid] ?? [];
    const has = cur.some((v) => v.toLowerCase() === value.toLowerCase());
    const next = single ? (has ? [] : [value]) : has ? cur.filter((v) => v.toLowerCase() !== value.toLowerCase()) : [...cur, value];
    const out = { ...loc.selections, [fid]: next };
    if (!next.length) delete out[fid];
    navigate({ ...loc, selections: out }, 'replace');
  }, [loc, navigate]);

  const clearFacets = React.useCallback(() => navigate({ ...loc, selections: {} }, 'replace'), [loc, navigate]);

  /* ── where the buyer is ─────────────────────────────────────────────── */

  React.useEffect(() => {
    const w = readWhere();
    if (w) { setRegionId(w.regionId); setPincode(w.pincode); }
    if (!meta) fetch('/api/meta').then((r) => r.json()).then(setMeta).catch(() => setError('Could not load app metadata.'));
    const on = () => setOffline(false), off = () => setOffline(true);
    setOffline(!navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (/^\d{6}$/.test(pincode)) writeWhere({ regionId, pincode });
  }, [regionId, pincode]);

  React.useEffect(() => {
    if (!meta) return;
    const r = meta.regions.find((x: Region) => x.region_id === regionId);
    if (r && !pincodeInRegion(pincode, r)) setPincode(r.default_pincode);
  }, [regionId, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── events from the sheet and the search dropdown ──────────────────── */

  React.useEffect(() => {
    function openSkuEv(e: Event) { openSheet((e as CustomEvent).detail); }
    // The suggest dropdown's category intents: keep the typed words, move into
    // the category. Changing category clears the vendor drill-down as well as
    // the facets — "water pipes from BigBMart" is a legitimate query with no
    // answer, which rendered as the no-data-collected state for a category
    // that has 337 offers.
    function setCatEv(e: Event) {
      const c = catalogueById((e as CustomEvent).detail);
      if (c && c.live) openCategory(c, true);
    }
    window.addEventListener('buildobjects:open-sku', openSkuEv);
    window.addEventListener('buildobjects:set-category', setCatEv);
    return () => {
      window.removeEventListener('buildobjects:open-sku', openSkuEv);
      window.removeEventListener('buildobjects:set-category', setCatEv);
    };
  }, [openCategory, openSheet]);

  /* ── the fetch ──────────────────────────────────────────────────────── */

  const listing = view.kind === 'category' || view.kind === 'search';

  /* Instant as-you-type, 80 ms debounce. */
  React.useEffect(() => {
    if (!listing) return;
    const id = ++seq.current;
    setLoading(true);
    const spin = setTimeout(() => { if (id === seq.current) setShowSpinner(true); }, SPINNER_AFTER_MS);

    const t = setTimeout(async () => {
      const params = new URLSearchParams({ q: query, pincode, sort, limit: String(limit) });
      if (category) params.set('category', category);
      if (vendorFilter) params.set('vendor_id', vendorFilter.id);
      // A column header sorts server-side, over every matching result. Sorting
      // the rows already on screen would only reorder the page.
      if (colSort) { params.set('col', colSort.key); params.set('dir', colSort.dir); }
      for (const [fid, vals] of Object.entries(selections)) for (const v of vals) params.append(`f.${fid}`, v);
      try {
        const r = await fetch(`/api/search?${params}`);
        if (id !== seq.current) return;
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.message ?? `HTTP ${r.status}`);
          setData(null);
          if (r.status === 404) setPincodeError('not serviced');
          return;
        }
        setPincodeError(null);
        const j: SearchResponse = await r.json();
        setData(j); setError(null);
      } catch (e) {
        if (id === seq.current) { setError(String((e as Error).message ?? e)); setData(null); }
      } finally {
        if (id === seq.current) { setLoading(false); setShowSpinner(false); clearTimeout(spin); }
      }
    }, DEBOUNCE_MS);

    return () => { clearTimeout(t); clearTimeout(spin); };
  }, [listing, query, pincode, sort, category, selections, vendorFilter, colSort, limit]);

  /* A new query is a new result set, so it starts at one page again —
     otherwise "show all 141" silently applies to every later search. */
  React.useEffect(() => { setLimit(PAGE); }, [query, category, selections, vendorFilter, pincode]);

  // Arriving in a different view by back/forward clears what belonged to the
  // last one, the same as arriving by click.
  const vk = viewKey(view);
  const lastVk = React.useRef(vk);
  React.useEffect(() => {
    if (lastVk.current !== vk) { lastVk.current = vk; leaveListing(); }
  }, [vk, leaveListing]);

  /* ── the document title follows the view ────────────────────────────── */
  const regionName = meta?.regions?.find((r: Region) => r.region_id === regionId)?.name ?? 'Hyderabad';
  React.useEffect(() => {
    document.title =
      view.kind === 'category' ? `${view.entry.label} prices in ${regionName} — Build Objects`
      : view.kind === 'search' ? (query ? `“${query}” — Build Objects` : 'Search — Build Objects')
      : view.kind === 'missing' ? 'Not found — Build Objects'
      : 'Build Objects Price Intelligence — construction material prices, Hyderabad & Vijayawada';
  }, [view, query, regionName]);

  /* ── derived ────────────────────────────────────────────────────────── */

  const results = React.useMemo(() => {
    let r = data?.results ?? [];
    if (inStockOnly) r = r.filter((c) => c.freshness_state !== 'EXPIRED');
    return r;
  }, [data, inStockOnly]);

  const regions: Region[] = meta?.regions ?? [];
  const catLabel = (c: string | null) => (c ? (meta?.category_labels?.[c] ?? c) : 'All categories');
  /* What the listing prints before its first fetch lands. Everything here is
     known from meta or is a constant, and it is the SAME text the fetch will
     confirm — so nothing under it moves when the data arrives. Measured: the
     phone listing shifted 0.15 CLS before this. */
  const regionMeta = meta?.regions?.find((r: any) => r.region_id === regionId);
  const sorAnchor = data ? data.sor_anchor : (entry ? regionMeta?.sor?.[entry.id] ?? null : null);
  const catStat = entry ? (regionMeta?.stats?.find((s: any) => s.category === entry.id) ?? null) : null;
  const sortExplain = data ? data.disclosure.explanation : meta?.sorts?.[sort]?.explain;
  const countSlot = (label: string) => (
    data
      ? `${data.total.toLocaleString('en-IN')} ${label}`
      : <span className="skel inline-block h-3 w-16 align-middle" aria-hidden />
  );
  const noData = meta && !meta.last_run;
  const activeFacets = Object.values(selections).flat().length;
  const openCard = (c: Card) => { setOpenVendor(c.vendor_id); setOpenOffer(c.offer_id); openSheet(c.product_id); };

  return (
    <div className="min-h-screen flex flex-col">
      {offline && <OfflineBanner />}
      {meta?.degraded && !noData && <DegradedBanner lastRun={meta?.last_run?.finished_at ?? null} />}

      <TopBar
        regions={regions} regionId={regionId} pincode={pincode}
        onRegion={setRegionId} onPincode={setPincode}
        query={query} onQuery={setQuery} onSubmit={setQuery}
        searchRef={searchRef} pincodeError={pincodeError}
        onHome={goHome}
        atHome={view.kind === 'home'}
      />

      <main className="mx-auto w-full max-w-[1680px] px-5 sm:px-6 lg:px-10 pt-5 sm:pt-6 pb-32 flex-1">
        {view.kind === 'home' && (
          <Home
            meta={meta} regionId={regionId} regionName={regionName}
            hrefFor={(c) => `/c/${c.slug}`}
            onOpen={(c) => openCategory(c)}
          />
        )}

        {view.kind === 'missing' && (
          <div className="mx-auto max-w-[56ch] text-center pt-16 fade-up">
            <p className="eyebrow">Not found</p>
            <h1 className="display text-[26px] mt-2">There is no page here.</h1>
            <p className="mt-3 text-[14px]" style={{ color: 'var(--ink-2)' }}>
              The catalogue is one click away, and every category in it is a real listing.
            </p>
            <button onClick={goHome} className="btn-primary mt-6 h-10 px-5 text-[13.5px]">Back to the catalogue</button>
          </div>
        )}

        {listing && (
          <>
            {/* ── the header of a listing ─────────────────────────────── */}
            {entry ? (
              <div className="mb-4 fade-up">
                <nav aria-label="Breadcrumb" className="crumbs">
                  <a href="/" onClick={(e) => { e.preventDefault(); goHome(); }}>Home</a>
                  <IconChevronRight size={12} />
                  <span aria-current="page">{entry.label}</span>
                </nav>

                <div className="flex items-start gap-3.5 mt-3">
                  <span className="cat-head-icon" aria-hidden><CategoryIcon name={entry.icon} size={24} /></span>
                  <div className="min-w-0 flex-1">
                    <h1 className="display text-[22px] sm:text-[26px] leading-tight flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {vendorFilter
                        ? vendorFilter.name
                        : query
                          ? <>“{query}” <span className="text-[15px]" style={{ color: 'var(--ink-2)' }}>in {entry.label}</span></>
                          : entry.label}
                      <span className="fig text-[13px] font-medium" style={{ color: 'var(--ink-3)' }}>
                        {/* Sellers, not products — the list is one card per vendor,
                            except when drilled into one seller's stock. */}
                        {countSlot(vendorFilter ? 'items from this seller' : data?.total === 1 ? 'seller' : 'sellers')}
                      </span>
                    </h1>
                    {vendorFilter ? (
                      <p className="text-[12px] mt-1" style={{ color: 'var(--ink-2)' }}>
                        Showing every matching item from this seller.{' '}
                        <button onClick={() => setVendorFilter(null)}
                          className="anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                          style={{ color: 'var(--accent)' }}>
                          back to all sellers
                        </button>
                      </p>
                    ) : (
                      <p className="text-[12.5px] mt-1 max-w-[80ch]" style={{ color: 'var(--ink-2)' }}>
                        {entry.tagline}
                        {entry.unit && <> · landed {UNIT_SPOKEN[entry.unit]}, delivered to {pincode}</>}
                        {query && (
                          <>
                            {' · '}
                            <button onClick={() => searchEverywhere(query)}
                              className="anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                              style={{ color: 'var(--accent)' }}>
                              search all categories
                            </button>
                          </>
                        )}
                      </p>
                    )}
                    {/* Where the market sits, from meta — the same rows the card
                        used, so the two never disagree. The typical figure is
                        the one to compare a city on; the lowest is one seller. */}
                    {!vendorFilter && !query && catStat && (
                      <p className="text-[12px] mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5" style={{ color: 'var(--ink-2)' }}>
                        {catStat.median_paise != null && catStat.lo_paise != null ? (
                          <>
                            <span>typical <span className="fig font-semibold" style={{ color: 'var(--ink)' }}>{rupees(catStat.median_paise, catStat.median_paise < 10_000)}</span><span style={{ color: 'var(--ink-3)' }}>{unitSuffix(entry.unit)}</span></span>
                            <span>from <span className="fig font-semibold" style={{ color: 'var(--ink)' }}>{rupees(catStat.lo_paise, catStat.lo_paise < 10_000)}</span><span style={{ color: 'var(--ink-3)' }}>{unitSuffix(entry.unit)}</span></span>
                          </>
                        ) : (
                          <span>no current price — every offer here is past its refresh window</span>
                        )}
                        <span className="tnum" style={{ color: 'var(--ink-3)' }}>
                          {catStat.quotable.toLocaleString('en-IN')} current of {catStat.offers.toLocaleString('en-IN')} offers · {catStat.sellers.toLocaleString('en-IN')} sellers in {regionName}
                        </span>
                      </p>
                    )}
                    {!vendorFilter && (
                      <p className="text-[11.5px] mt-1 max-w-[80ch]" style={{ color: 'var(--ink-3)' }}>{data?.comparability_note ?? COMPARABILITY_NOTE}</p>
                    )}
                  </div>
                </div>

                {/* Sideways: the other live categories, one tap away. */}
                <div className="cat-strip mt-4" role="navigation" aria-label="Categories">
                  {LIVE_CATALOGUE.map((c) => (
                    <a
                      key={c.id} href={`/c/${c.slug}`}
                      aria-current={c.id === entry.id ? 'page' : undefined}
                      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); if (c.id !== entry.id) openCategory(c); }}
                      className="cat-strip-item anim"
                    >
                      <CategoryIcon name={c.icon} size={16} />
                      <span>{c.label}</span>
                    </a>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mb-4 fade-up">
                <nav aria-label="Breadcrumb" className="crumbs">
                  <a href="/" onClick={(e) => { e.preventDefault(); goHome(); }}>Home</a>
                  <IconChevronRight size={12} />
                  <span aria-current="page">Search</span>
                </nav>
                <h1 className="display text-[22px] sm:text-[26px] leading-tight mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {vendorFilter ? vendorFilter.name : query ? <>“{query}”</> : 'All sellers, all categories'}
                  <span className="fig text-[13px] font-medium" style={{ color: 'var(--ink-3)' }}>
                    {countSlot(vendorFilter ? 'items from this seller' : 'sellers')}
                  </span>
                </h1>
                {vendorFilter ? (
                  <p className="text-[12px] mt-1" style={{ color: 'var(--ink-2)' }}>
                    Showing every matching item from this seller.{' '}
                    <button onClick={() => setVendorFilter(null)}
                      className="anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                      style={{ color: 'var(--accent)' }}>
                      back to all sellers
                    </button>
                  </p>
                ) : (
                  <p className="text-[11.5px] mt-1 max-w-[80ch]" style={{ color: 'var(--ink-3)' }}>{data?.comparability_note ?? COMPARABILITY_NOTE}</p>
                )}

                {/* Category intent chips — tapping one is a navigation, not a filter. */}
                {!!data?.intent_chips?.length && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-3.5">
                    <span className="chip px-2.5 h-8 text-[12.5px] inline-flex items-center" aria-current="page">All</span>
                    {data.intent_chips.map((c) => {
                      const e = catalogueById(c.category);
                      return (
                        <button key={c.category} onClick={() => e && openCategory(e, true)} disabled={!e}
                          className="chip anim px-2.5 h-8 text-[12.5px] inline-flex items-center gap-1.5">
                          {e && <CategoryIcon name={e.icon} size={14} />}
                          {c.label} <span className="tnum" style={{ color: 'var(--ink-3)' }}>{c.count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-8">
              <FilterRail
                facets={data?.facets ?? []} selections={selections}
                onToggle={toggleFacet} onClear={clearFacets}
                collapsed={railCollapsed} onCollapse={setRailCollapsed}
                total={data?.total ?? 0}
              />

              <section className="flex-1 min-w-0" aria-labelledby="results-heading">
                {/* The rail's "Narrow by" is the page's h2 on a wide screen; on a
                    phone it does not render and the cards' h3s would hang off
                    the h1. This heading keeps the outline whole either way. */}
                <h2 id="results-heading" className="sr-only">
                  {vendorFilter ? 'Items from this seller' : 'Sellers'}
                </h2>
                {/* ── the toolbar ───────────────────────────────────────── */}
                <div className="flex flex-wrap items-center gap-2 pb-3 rule-b mb-3">
                  {/* Filters, on a phone. The rail is desktop-only. */}
                  {(entry || !!data?.facets?.length) && (
                    <button onClick={() => setSheetOpen(true)} disabled={!data?.facets?.length}
                      className="chip anim h-8 px-3 text-[12.5px] inline-flex items-center gap-1.5 lg:hidden"
                      aria-haspopup="dialog" aria-expanded={sheetOpen}>
                      <IconFilter size={13} />
                      Filters{activeFacets ? <span className="tnum" style={{ color: 'var(--accent)' }}>{activeFacets}</span> : null}
                    </button>
                  )}
                  <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--ink-2)' }}>
                    <input type="checkbox" checked={inStockOnly} onChange={() => setInStockOnly((v) => !v)}
                      className="accent-[var(--accent)]" style={{ width: 12, height: 12 }} />
                    quotable only
                  </label>
                  <span className="flex-1" />
                  <select
                    value={sort}
                    onChange={(e) => {
                      // Choosing a named sort clears any column sort — two orders
                      // cannot both be in force, and the disclosure names one.
                      setColSort(null);
                      setSort(e.target.value);
                    }}
                    className="field h-8 px-2 text-[12.5px]" aria-label="Sort results">
                    {Object.entries(meta?.sorts ?? {}).map(([k, v]: any) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                  <div className="seg flex h-8 text-[12.5px]" role="group" aria-label="Result layout">
                    <button className="anim px-3 h-full" aria-pressed={layout === 'cards'} onClick={() => setLayout('cards')}>Cards</button>
                    <button className="anim px-3 h-full" aria-pressed={layout === 'table'} onClick={() => setLayout('table')}>Table</button>
                  </div>
                </div>

                {/* Rule 5(3)(f): the sort states what it sorted on, in plain language.
                    When a column header is driving, `disclosure.sort` names the
                    column — printing the dropdown's label here would disclose an
                    order that is not the one applied. */}
                {sortExplain && (
                  <p className="text-[11px] -mt-1 mb-4" style={{ color: 'var(--ink-3)' }}>
                    Sorted on{' '}
                    <strong style={{ color: 'var(--ink-2)' }}>
                      {colSort && data ? data.disclosure.sort : meta?.sorts?.[sort]?.label ?? sort}
                    </strong>{' '}
                    = {sortExplain}
                    {colSort && (
                      <button onClick={() => setColSort(null)}
                        className="ml-2 anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                        style={{ color: 'var(--accent)' }}>
                        back to {meta?.sorts?.[sort]?.label ?? sort}
                      </button>
                    )}
                  </p>
                )}

                {/* Active facets, as removable chips — visible whether or not the rail is. */}
                {activeFacets > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 mb-4">
                    {Object.entries(selections).flatMap(([fid, vals]) => vals.map((v) => (
                      <button key={`${fid}:${v}`} onClick={() => toggleFacet(fid, v, false)}
                        className="chip anim h-7 px-2.5 text-[12px] inline-flex items-center gap-1.5"
                        aria-label={`Remove filter ${v}`}>
                        {v}
                        <span aria-hidden style={{ color: 'var(--ink-3)' }}>×</span>
                      </button>
                    )))}
                    <button onClick={clearFacets} className="text-[12px] anim hover:opacity-70 ml-1" style={{ color: 'var(--accent)' }}>
                      clear all
                    </button>
                  </div>
                )}

                {/* The government reference line — no competitor shows this. */}
                {sorAnchor && (
                  <div className="mb-4 px-3 py-2 text-[11.5px] flex items-start gap-2"
                    style={{ border: '1px solid var(--rule)', borderRadius: '10px', background: 'var(--wash)' }}>
                    <span className="shrink-0 mt-[2px]" style={{ color: 'var(--ink-3)' }}>⌖</span>
                    <span style={{ color: 'var(--ink-2)' }}>
                      <strong>Government reference</strong> — {sorAnchor.item}, {sorAnchor.state_code}{' '}
                      {sorAnchor.effective_period}.{' '}
                      <a href={sorAnchor.source_url} target="_blank" rel="noreferrer noopener"
                        className="underline decoration-dotted underline-offset-2">source</a>.
                      {sorAnchor.note && (
                        <span className="block mt-0.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>{sorAnchor.note}</span>
                      )}
                    </span>
                  </div>
                )}

                {error && <ErrorState message={error} onRetry={() => setQuery(query + ' ')} />}
                {!error && noData && <NoDataYet />}
                {!error && !noData && showSpinner && !data && <ResultsSkeleton />}
                {!error && !noData && data?.zero_result && results.length === 0 && (
                  <ZeroResult zero={data.zero_result} query={query} onSuggest={(q) => setQuery(q)} />
                )}
                {!error && !noData && data && !data.zero_result && results.length === 0 && (
                  <EmptyCategory label={catLabel(category)} />
                )}

                {!error && results.length > 0 && layout === 'table' && (
                  <ResultsTable
                    cards={results}
                    category={category}
                    sortKey={colSort?.key ?? null}
                    sortDir={colSort?.dir ?? 'asc'}
                    total={data?.total ?? results.length}
                    // Same column twice flips direction; a new column starts ascending.
                    onSort={(key) => setColSort((s) =>
                      s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
                    onOpen={openCard}
                  />
                )}

                {!error && results.length > 0 && layout === 'cards' && (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {results.map((c) => (
                      <ProductCardView
                        /* Keyed by OFFER. One product now appears once per seller,
                           so a product_id key duplicates across cards — React then
                           leaves stale cards mounted, which showed cement rows
                           under a TMT header. */
                        key={c.offer_id}
                        card={c}
                        onOpen={() => openCard(c)}
                        onShowVendor={() => setVendorFilter({ id: c.vendor_id, name: c.best_vendor })}
                        compared={compare.some((x) => x.offer_id === c.offer_id)}
                        onCompare={() => setCompare((s) =>
                          s.some((x) => x.offer_id === c.offer_id)
                            ? s.filter((x) => x.offer_id !== c.offer_id)
                            : [...s, c])}
                        saved={saved.some((x) => x.offer_id === c.offer_id)}
                        onSave={() => setSaved((s) =>
                          s.some((x) => x.offer_id === c.offer_id)
                            ? s.filter((x) => x.offer_id !== c.offer_id)
                            : [...s, c])}
                      />
                    ))}
                  </div>
                )}

                {/* The list used to stop dead at 24 with nothing to click, which
                    hid 117 of the 141 sellers on a cement search without saying so.
                    The table is virtualised, so "show all" there is cheap; the card
                    grid renders every one, which is why the count is stated up
                    front rather than after the click. */}
                {!error && data && results.length > 0 && data.total > results.length && (
                  <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                    <span className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                      Showing <span className="fig" style={{ color: 'var(--ink-2)' }}>{results.length}</span> of{' '}
                      <span className="fig" style={{ color: 'var(--ink-2)' }}>{data.total}</span>{' '}
                      {vendorFilter ? 'items from this seller' : 'sellers'}
                    </span>
                    <button onClick={() => setLimit((n) => n + PAGE)} disabled={loading} className="chip anim px-3 h-8 text-[12.5px]">
                      Show {Math.min(PAGE, data.total - results.length)} more
                    </button>
                    <button onClick={() => setLimit(Math.min(500, data.total))} disabled={loading}
                      className="chip anim px-3 h-8 text-[12.5px]" style={{ color: 'var(--accent)' }}>
                      Show all {Math.min(500, data.total)}
                      {data.total > 500 && <span style={{ color: 'var(--ink-3)' }}> (of {data.total})</span>}
                    </button>
                  </div>
                )}

                {/* Everything asked for is on screen — say so, rather than leaving
                    the reader to wonder whether the list simply stopped. */}
                {!error && data && results.length > 0 && data.total <= results.length && data.total > PAGE && (
                  <p className="mt-5 text-center text-[12px]" style={{ color: 'var(--ink-3)' }}>
                    All <span className="fig">{data.total}</span> {vendorFilter ? 'items' : 'sellers'} shown.
                  </p>
                )}

                {saved.length > 0 && (
                  <div className="mt-6 px-3.5 py-3 flex items-center justify-between gap-4"
                    style={{ border: '1px solid var(--rule)', borderRadius: '10px', background: 'var(--wash)' }}>
                    <span className="text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
                      <strong style={{ color: 'var(--ink)' }}>My list</strong> — {saved.length}{' '}
                      {saved.length === 1 ? 'item' : 'items'}, one unit of each
                    </span>
                    <span className="flex items-center gap-3">
                      <span className="fig text-[15px]">
                        {rupees(saved.reduce((s, c) => s + c.normalised_paise, 0))}
                      </span>
                      <button onClick={() => setSaved([])} className="text-[11.5px] anim hover:opacity-70"
                        style={{ color: 'var(--ink-3)' }}>clear</button>
                    </span>
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </main>

      {listing && (
        <FilterSheet
          open={sheetOpen} onClose={() => setSheetOpen(false)}
          facets={data?.facets ?? []} selections={selections}
          onToggle={toggleFacet} onClear={clearFacets}
          total={data?.total ?? 0} loading={loading}
        />
      )}

      <CompareTray
        items={compare}
        // Keyed by OFFER: the list is one card per seller, so two sellers of
        // the same product are two distinct compare items. Removing on
        // product_id removed both of them.
        onRemove={(id) => setCompare((s) => s.filter((x) => x.offer_id !== id))}
        onClear={() => setCompare([])}
        onOpen={openCard}
      />

      {openSku && <DetailSheet productId={openSku} pincode={pincode} highlightVendorId={openVendor} highlightOfferId={openOffer}
        onClose={closeSheet} />}

      {/*
        The assistant, docked. It shares the page's pincode so a price it
        quotes and a price the grid shows are landed at the same place —
        two surfaces disagreeing about a rupee figure is the failure this
        whole application is built to avoid, and a chat bubble with its own
        idea of "here" would reintroduce it.
      */}
      <ChatPanel
        pincode={pincode}
        regionName={regionName}
        onApplySearch={(q) => searchEverywhere(q)}
      />
    </div>
  );
}

function pincodeInRegion(p: string, r: Region): boolean {
  const n = Number(p);
  return n >= Number(r.pincode_from) && n <= Number(r.pincode_to);
}
