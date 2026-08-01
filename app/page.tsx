'use client';

import React from 'react';
import type { SearchResponse, ProductCard as Card } from '@/lib/types';
import TopBar, { type Region } from '@/components/TopBar';
import FilterRail from '@/components/FilterRail';
import ProductCardView from '@/components/ProductCard';
import ResultsTable from '@/components/ResultsTable';
import DetailSheet from '@/components/DetailSheet';
import CompareTray from '@/components/CompareTray';
import LatencyHUD, { type Stage } from '@/components/LatencyHUD';
import {
  ResultsSkeleton, ZeroResult, NoDataYet, EmptyCategory, ErrorState, OfflineBanner, DegradedBanner,
} from '@/components/States';
import { rupees } from '@/components/primitives';

const DEBOUNCE_MS = 80;
/* No spinner under 150 ms — otherwise it is only ever a flash. */
const SPINNER_AFTER_MS = 150;

export default function Page() {
  const [meta, setMeta] = React.useState<any>(null);
  const [regionId, setRegionId] = React.useState('hyderabad');
  const [pincode, setPincode] = React.useState('500001');
  const [pincodeError, setPincodeError] = React.useState<string | null>(null);

  const [query, setQuery] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [category, setCategory] = React.useState<string | null>(null);
  // Drilling into one seller's stock — set by a card's "+N more from this seller".
  const [vendorFilter, setVendorFilter] = React.useState<{ id: string; name: string } | null>(null);
  const [sort, setSort] = React.useState('recommended');
  const [selections, setSelections] = React.useState<Record<string, string[]>>({});
  const [inStockOnly, setInStockOnly] = React.useState(false);
  const [view, setView] = React.useState<'cards' | 'table'>('cards');
  /** How many sellers to fetch. 24 is a page; the control below shows all. */
  const PAGE = 24;
  const [limit, setLimit] = React.useState(PAGE);
  /** A table column header. Drives the server sort, not a client reorder. */
  const [colSort, setColSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);

  const [data, setData] = React.useState<SearchResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showSpinner, setShowSpinner] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [offline, setOffline] = React.useState(false);

  const [openSku, setOpenSku] = React.useState<string | null>(null);
  // Which seller's card opened the sheet, so their row can be marked in the table.
  const [openVendor, setOpenVendor] = React.useState<string | null>(null);
  // And which listing — a seller can post the same product twice at two prices.
  const [openOffer, setOpenOffer] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<Card[]>([]);
  const [saved, setSaved] = React.useState<Card[]>([]);
  const [railCollapsed, setRailCollapsed] = React.useState(false);
  const [stages, setStages] = React.useState<Stage[]>([]);
  const [e2e, setE2e] = React.useState(0);

  const searchRef = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);
  const keystrokeAt = React.useRef<number>(0);

  React.useEffect(() => {
    fetch('/api/meta').then((r) => r.json()).then(setMeta).catch(() => setError('Could not load app metadata.'));
    const on = () => setOffline(false), off = () => setOffline(true);
    setOffline(!navigator.onLine);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  React.useEffect(() => {
    function openSkuEv(e: Event) { setOpenSku((e as CustomEvent).detail); }
    // Changing category clears the vendor drill-down as well as the facets.
    // Without this, switching category while drilled into one seller asks for
    // "water pipes from BigBMart" — a legitimate query with no answer, which
    // rendered as the no-data-collected state for a category that has 337
    // offers. Same reset the category chips already do.
    function setCatEv(e: Event) {
      setCategory((e as CustomEvent).detail);
      setSelections({});
      setVendorFilter(null);
    }
    window.addEventListener('buildo:open-sku', openSkuEv);
    window.addEventListener('buildo:set-category', setCatEv);
    return () => {
      window.removeEventListener('buildo:open-sku', openSkuEv);
      window.removeEventListener('buildo:set-category', setCatEv);
    };
  }, []);

  /* Instant as-you-type, 80 ms debounce, measured keystroke → painted. */
  React.useEffect(() => {
    keystrokeAt.current = performance.now();
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
        const t0 = performance.now();
        const r = await fetch(`/api/search?${params}`);
        const net = performance.now() - t0;
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
        requestAnimationFrame(() => {
          if (id !== seq.current) return;
          const total = performance.now() - keystrokeAt.current;
          setE2e(total);
          setStages([
            { label: 'debounce', ms: DEBOUNCE_MS, note: 'Counted inside the budget, not excluded from it.' },
            { label: 'query parse', ms: j.timings.parse ?? 0, note: 'Typed-constraint grammar. No model call.' },
            { label: 'store read', ms: j.timings.fetch ?? 0, note: 'In-process SQLite. No network hop.' },
            { label: 'retrieve (FTS5 + trigram)', ms: j.timings.retrieve ?? 0 },
            { label: 'filter + facet counts', ms: (j.timings.filter ?? 0) + (j.timings.facets ?? 0) },
            // No "diversity damping" here any more — one card per vendor made it
            // unreachable and it was removed. The disclosed parameters have to be
            // the applied ones.
            { label: 'rank + group by vendor', ms: j.timings.rank ?? 0, note: 'Nine features, four penalties, then one card per seller.' },
            { label: 'transport + serialise', ms: Math.max(0, net - (j.timings.total ?? 0)) },
            { label: 'react render + paint', ms: Math.max(0, total - DEBOUNCE_MS - net) },
          ]);
        });
      } catch (e) {
        if (id === seq.current) { setError(String((e as Error).message ?? e)); setData(null); }
      } finally {
        if (id === seq.current) { setLoading(false); setShowSpinner(false); clearTimeout(spin); }
      }
    }, DEBOUNCE_MS);

    return () => { clearTimeout(t); clearTimeout(spin); };
  }, [query, pincode, sort, category, selections, vendorFilter, colSort, limit]);

  /* A new query is a new result set, so it starts at one page again —
     otherwise "show all 141" silently applies to every later search. */
  React.useEffect(() => { setLimit(PAGE); }, [query, category, selections, vendorFilter, pincode]);

  React.useEffect(() => {
    if (!meta) return;
    const r = meta.regions.find((x: Region) => x.region_id === regionId);
    if (r && !pincodeInRegion(pincode, r)) setPincode(r.default_pincode);
  }, [regionId, meta]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleFacet(fid: string, value: string, single: boolean) {
    setSelections((s) => {
      const cur = s[fid] ?? [];
      const has = cur.some((v) => v.toLowerCase() === value.toLowerCase());
      const next = single ? (has ? [] : [value]) : has ? cur.filter((v) => v.toLowerCase() !== value.toLowerCase()) : [...cur, value];
      const out = { ...s, [fid]: next };
      if (!next.length) delete out[fid];
      return out;
    });
  }

  const results = React.useMemo(() => {
    let r = data?.results ?? [];
    if (inStockOnly) r = r.filter((c) => c.freshness_state !== 'EXPIRED');
    return r;
  }, [data, inStockOnly]);

  const regions: Region[] = meta?.regions ?? [];
  const catLabel = (c: string | null) => (c ? (meta?.category_labels?.[c] ?? c) : 'All categories');
  const noData = meta && !meta.last_run;

  return (
    <div className="min-h-screen">
      {offline && <OfflineBanner />}
      {meta?.degraded && !noData && <DegradedBanner lastRun={meta?.last_run?.finished_at ?? null} />}

      <TopBar
        regions={regions} regionId={regionId} pincode={pincode}
        onRegion={setRegionId} onPincode={setPincode}
        query={query} onQuery={setQuery} onSubmit={(q) => { setQuery(q); setSubmitted(q); }}
        searchRef={searchRef} pincodeError={pincodeError}
      />

      <main className="mx-auto max-w-[1680px] px-6 lg:px-10 pt-6 pb-32">
        {/* Category intent chips — tapping one is a navigation, not a filter. */}
        {!!data?.intent_chips?.length && (
          <div className="flex flex-wrap items-center gap-1.5 mb-5">
            <button onClick={() => { setCategory(null); setSelections({}); setVendorFilter(null); }} aria-pressed={category === null}
              className="chip anim px-2.5 h-8 text-[12.5px]">All</button>
            {data.intent_chips.map((c) => (
              <button key={c.category} onClick={() => { setCategory(c.category); setSelections({}); setVendorFilter(null); }}
                aria-pressed={category === c.category} className="chip anim px-2.5 h-8 text-[12.5px]">
                {c.label} <span className="tnum opacity-60 ml-0.5">{c.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex gap-8">
          <FilterRail
            facets={data?.facets ?? []} selections={selections}
            onToggle={toggleFacet} onClear={() => setSelections({})}
            collapsed={railCollapsed} onCollapse={setRailCollapsed}
            total={data?.total ?? 0}
          />

          <section className="flex-1 min-w-0">
            {/* One line of category truth — the basis, stated before any price. */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-3 rule-b mb-4">
              <div className="min-w-0">
                <h1 className="display text-[19px] leading-tight">
                  {vendorFilter ? vendorFilter.name : submitted || query ? <>“{query}”</> : catLabel(category)}
                  <span className="tnum text-[13px] ml-2.5" style={{ color: 'var(--ink-3)' }}>
                    {/* Sellers, not products — the list is one card per vendor,
                        except when drilled into one seller's stock. */}
                    {data ? `${data.total} ${vendorFilter ? 'items from this seller' : 'sellers'}` : ''}
                  </span>
                </h1>
                {vendorFilter ? (
                  <p className="text-[11.5px] mt-1" style={{ color: 'var(--ink-2)' }}>
                    Showing every matching item from this seller.{' '}
                    <button
                      onClick={() => setVendorFilter(null)}
                      className="anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                      style={{ color: 'var(--accent)' }}
                    >
                      back to all sellers
                    </button>
                  </p>
                ) : (
                  <p className="text-[11.5px] mt-1 max-w-[76ch]" style={{ color: 'var(--ink-3)' }}>
                    {data?.comparability_note}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--ink-2)' }}>
                  <input type="checkbox" checked={inStockOnly} onChange={() => setInStockOnly((v) => !v)}
                    className="accent-[var(--accent)]" style={{ width: 12, height: 12 }} />
                  quotable only
                </label>
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
                <div className="seg" role="group" aria-label="Result layout">
                  <button aria-pressed={view === 'cards'} onClick={() => setView('cards')}>Cards</button>
                  <button aria-pressed={view === 'table'} onClick={() => setView('table')}>Table</button>
                </div>
              </div>
            </div>

            {/* Rule 5(3)(f): the sort states what it sorted on, in plain language.
                When a column header is driving, `disclosure.sort` names the
                column — printing the dropdown's label here would disclose an
                order that is not the one applied. */}
            {data && (
              <p className="text-[11px] -mt-2 mb-4" style={{ color: 'var(--ink-3)' }}>
                Sorted on{' '}
                <strong style={{ color: 'var(--ink-2)' }}>
                  {colSort ? data.disclosure.sort : meta?.sorts?.[sort]?.label ?? sort}
                </strong>{' '}
                = {data.disclosure.explanation}
                {colSort && (
                  <button onClick={() => setColSort(null)}
                    className="ml-2 anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                    style={{ color: 'var(--accent)' }}>
                    back to {meta?.sorts?.[sort]?.label ?? sort}
                  </button>
                )}
              </p>
            )}

            {/* The government reference line — no competitor shows this. */}
            {data?.sor_anchor && (
              <div className="mb-4 px-3 py-2 text-[11.5px] flex items-start gap-2"
                style={{ border: '1px solid var(--rule)', borderRadius: '10px', background: 'rgba(22,20,18,.045)' }}>
                <span className="shrink-0 mt-[2px]" style={{ color: 'var(--ink-3)' }}>⌖</span>
                <span style={{ color: 'var(--ink-2)' }}>
                  <strong>Government reference</strong> — {data.sor_anchor.item}, {data.sor_anchor.state_code}{' '}
                  {data.sor_anchor.effective_period}.{' '}
                  <a href={data.sor_anchor.source_url} target="_blank" rel="noreferrer noopener"
                    className="underline decoration-dotted underline-offset-2">source</a>.
                  {data.sor_anchor.note && (
                    <span className="block mt-0.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>{data.sor_anchor.note}</span>
                  )}
                </span>
              </div>
            )}

            {error && <ErrorState message={error} onRetry={() => setQuery((q) => q + ' ')} />}
            {!error && noData && <NoDataYet />}
            {!error && !noData && showSpinner && !data && <ResultsSkeleton />}
            {!error && !noData && data?.zero_result && results.length === 0 && (
              <ZeroResult zero={data.zero_result} query={query} onSuggest={(q) => setQuery(q)} />
            )}
            {!error && !noData && data && !data.zero_result && results.length === 0 && (
              <EmptyCategory label={catLabel(category)} />
            )}

            {!error && results.length > 0 && view === 'table' && (
              <ResultsTable
                cards={results}
                category={category}
                sortKey={colSort?.key ?? null}
                sortDir={colSort?.dir ?? 'asc'}
                total={data?.total ?? results.length}
                // Same column twice flips direction; a new column starts ascending.
                onSort={(key) => setColSort((s) =>
                  s && s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })}
                onOpen={(c) => { setOpenSku(c.product_id); setOpenVendor(c.vendor_id); setOpenOffer(c.offer_id); }}
              />
            )}

            {!error && results.length > 0 && view === 'cards' && (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {results.map((c) => (
                  <ProductCardView
                    /* Keyed by OFFER. One product now appears once per seller,
                       so a product_id key duplicates across cards — React then
                       leaves stale cards mounted, which showed cement rows
                       under a TMT header. */
                    key={c.offer_id}
                    card={c}
                    onOpen={() => { setOpenSku(c.product_id); setOpenVendor(c.vendor_id); setOpenOffer(c.offer_id); }}
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
                <button
                  onClick={() => setLimit((n) => n + PAGE)}
                  disabled={loading}
                  className="chip anim px-3 h-8 text-[12.5px]"
                >
                  Show {Math.min(PAGE, data.total - results.length)} more
                </button>
                <button
                  onClick={() => setLimit(Math.min(500, data.total))}
                  disabled={loading}
                  className="chip anim px-3 h-8 text-[12.5px]"
                  style={{ color: 'var(--accent)' }}
                >
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
                style={{ border: '1px solid var(--rule)', borderRadius: '10px', background: 'rgba(22,20,18,.045)' }}>
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
      </main>

      <CompareTray
        items={compare}
        // Keyed by OFFER: the list is one card per seller, so two sellers of
        // the same product are two distinct compare items. Removing on
        // product_id removed both of them.
        onRemove={(id) => setCompare((s) => s.filter((x) => x.offer_id !== id))}
        onClear={() => setCompare([])}
        onOpen={(c) => { setOpenSku(c.product_id); setOpenVendor(c.vendor_id); setOpenOffer(c.offer_id); }}
      />

      {openSku && <DetailSheet productId={openSku} pincode={pincode} highlightVendorId={openVendor} highlightOfferId={openOffer}
        onClose={() => { setOpenSku(null); setOpenVendor(null); setOpenOffer(null); }} />}

      {process.env.NODE_ENV !== 'production' && stages.length > 0 && (
        <LatencyHUD stages={stages} total={e2e} />
      )}
    </div>
  );
}

function pincodeInRegion(p: string, r: Region): boolean {
  const n = Number(p);
  return n >= Number(r.pincode_from) && n <= Number(r.pincode_to);
}
