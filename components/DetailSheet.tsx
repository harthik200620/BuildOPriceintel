'use client';

import React from 'react';
import type { OfferView } from '@/lib/types';
import { Money, FreshnessDot, CertBadge, ProvenanceBadge, EstimatedBadge, Hairline, rupees } from './primitives';
import VendorTable from './VendorTable';

/**
 * Click the card and now show everything. Nothing that was collected is hidden
 * here — the discipline lives on the card, not in the sheet.
 *
 * A side sheet on desktop so the result list stays in view; a full page on
 * mobile.
 */
/** "3 h ago". Relative, because an absolute UTC stamp reads as noise to a buyer. */
function relativeAge(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} d ago`;
}

/** Attribute keys read as prose rather than as column names. */
const ATTR_LABEL: Record<string, string> = {
  cement_type: 'Cement type', opc_grade: 'OPC grade', pack_size_kg: 'Pack size (kg)',
  diameter_mm: 'Diameter (mm)', kg_per_m: 'Mass per metre (kg)', rod_weight_kg: 'Rod weight (kg)',
  producer_type: 'Mill type', pipe_system: 'Pipe system', nominal_bore_mm: 'Nominal bore (mm)',
  length_m: 'Length (m)', sdr: 'SDR', pe_grade: 'PE grade', swr_type: 'SWR type',
  block_type: 'Block type', size_mm: 'Size (mm)', density_kg_m3: 'Density (kg/m³)',
  unit_volume_m3: 'Unit volume (m³)', compressive_strength_nmm2: 'Compressive strength (N/mm²)',
  country_of_origin: 'Country of origin', supply_type: 'Supply type', trade_type: 'Trade type',
  declared_brand: 'Brand, as the seller states it', standard_compliance: 'Standard',
  shelf_life: 'Shelf life', water_absorption: 'Water absorption', packaging_type: 'Packaging',
};

export default function DetailSheet({
  productId, pincode, onClose, highlightVendorId, highlightOfferId,
}: {
  productId: string;
  pincode: string;
  onClose: () => void;
  highlightVendorId?: string | null;
  /** The exact listing clicked. Its price is the one the card showed. */
  highlightOfferId?: string | null;
}) {
  const [data, setData] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [breakdown, setBreakdown] = React.useState<OfferView | null>(null);
  const [alertOn, setAlertOn] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let live = true;
    setData(null); setErr(null);
    const qs = new URLSearchParams({ pincode });
    if (highlightOfferId) qs.set('offer', highlightOfferId);
    fetch(`/api/sku/${productId}?${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => { if (live) setData(j); })
      .catch((e) => { if (live) setErr(String(e.message ?? e)); });
    return () => { live = false; };
  }, [productId, pincode, highlightOfferId]);

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const p = data?.product;
  const price = data?.price;
  const offers: OfferView[] = data?.offers ?? [];

  /**
   * A results card is ONE seller's offer, but this sheet is keyed by product —
   * so opening two different sellers' cards used to produce an identical sheet,
   * and the seller you actually clicked appeared only as a highlighted row far
   * down the vendor table. The sheet now leads with their offer and keeps the
   * product context beneath it.
   */
  const clicked: OfferView | null = React.useMemo(() => {
    // The server resolved the exact listing before the vendor roll-up. Falling
    // back to the vendor's row is only for an offer that has since gone
    // inactive, and it is a DIFFERENT listing — flagged below rather than
    // presented as the one that was clicked.
    if (data?.clicked_offer) return data.clicked_offer as OfferView;
    return highlightVendorId ? offers.find((o) => o.vendor.vendor_id === highlightVendorId) ?? null : null;
  }, [data, offers, highlightVendorId]);

  /** True when we are showing the seller's other listing, not the one clicked. */
  const substituted = !!clicked && !!highlightOfferId && clicked.offer_id !== highlightOfferId;

  /** Typed attributes, minus the nulls and the internal blob key. */
  const attrRows = React.useMemo(() => {
    const a = p?.attrs ?? {};
    return Object.entries(a).filter(
      ([k, v]) => k !== '_blob' && !k.startsWith('_') && v !== null && v !== undefined && v !== '',
    ) as Array<[string, unknown]>;
  }, [p]);

  /** Where this seller stands on price, which is the question the card raises. */
  const rankAmong = React.useMemo(() => {
    if (!clicked || offers.length < 2) return null;
    const sorted = [...offers].sort((a, b) => a.normalised_paise - b.normalised_paise);
    const n = sorted.findIndex((o) => o.offer_id === clicked.offer_id) + 1;
    return n > 0 ? { n, of: sorted.length } : null;
  }, [clicked, offers]);

  return (
    <>
      <div className="fixed inset-0 z-50" style={{ background: 'rgba(28,25,22,.22)', WebkitBackdropFilter: 'blur(2px)', backdropFilter: 'blur(2px)' }} onClick={onClose} aria-hidden />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={p?.title ?? 'Product detail'}
        className="fixed z-50 sheet-in scroll-thin outline-none
                   inset-0 md:inset-y-0 md:right-0 md:left-auto md:w-[min(1080px,88vw)]"
        style={{ background: 'var(--glass-strong)', WebkitBackdropFilter: 'blur(24px) saturate(1.5)', backdropFilter: 'blur(24px) saturate(1.5)', borderLeft: '1px solid var(--glass-hair)', boxShadow: 'var(--glass-shadow-lift)', overflowY: 'auto' }}
      >
        <header className="sticky top-0 z-20 px-6 md:px-8 py-3.5 rule-b flex items-center justify-between gap-4"
          style={{ background: 'rgba(255,255,255,.72)', WebkitBackdropFilter: 'blur(16px) saturate(1.4)', backdropFilter: 'blur(16px) saturate(1.4)', borderBottom: '1px solid var(--glass-hair)' }}>
          <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: 'var(--ink-3)' }}>
            {p?.category_label ?? 'Loading'} · full record
          </span>
          <button onClick={onClose} className="chip anim h-8 px-3 text-[12px]" aria-label="Close (Escape)">Close ✕</button>
        </header>

        {err && (
          <div className="p-8">
            <h2 className="display text-[20px] mb-2">That record could not be loaded</h2>
            <p className="text-[13px] mb-4" style={{ color: 'var(--ink-2)' }}>{err}</p>
            <button onClick={onClose} className="chip anim px-3 h-9 text-[13px]">Back to results</button>
          </div>
        )}

        {!data && !err && <SheetSkeleton />}

        {data && p && (
          <div className="px-6 md:px-8 pb-24">
            {/* ── the offer that was actually clicked ────────────────────── */}
            {clicked && (
              <section className="mt-6 p-5 corner-tick"
                style={{ background: 'var(--accent-bg)', border: '1px solid rgba(168,67,27,.22)', borderRadius: 'var(--radius)' }}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-[0.14em] mb-1" style={{ color: 'var(--accent-ink)' }}>
                      {substituted ? 'This seller’s current listing' : 'The offer you opened'}
                    </div>
                    {substituted && (
                      <p className="text-[11px] mb-1.5" style={{ color: 'var(--ageing)' }}>
                        The listing you clicked is no longer active. This is the same seller&apos;s cheapest
                        current listing for this product, at its own price.
                      </p>
                    )}
                    <h2 className="display text-[19px] leading-tight">{clicked.vendor.name}</h2>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                      {clicked.vendor.locality && <span>{clicked.vendor.locality}</span>}
                      <span>{clicked.platform}</span>
                      {clicked.vendor.rating != null && (
                        <span className="fig">{clicked.vendor.rating.toFixed(1)} ({clicked.vendor.review_count ?? 0})</span>
                      )}
                      <CertBadge state={clicked.cert_state} qco={p.qco_regulated} compact />
                    </div>
                    {/* The seller's own words, not our synthesised title. */}
                    {clicked.listing_title && (
                      <p className="mt-2 text-[12.5px] max-w-[46ch]" style={{ color: 'var(--ink-2)' }}>
                        “{clicked.listing_title}”
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <Money paise={clicked.normalised_paise} unit={price?.normalised_unit ?? p.unit_canonical} size="lg" accent />
                    <div className="text-[10.5px] mt-1 uppercase tracking-[.07em]" style={{ color: 'var(--ink-3)' }}>
                      delivered to your pincode
                    </div>
                    {rankAmong && (
                      <div className="text-[11.5px] mt-1.5" style={{ color: 'var(--ink-2)' }}>
                        {rankAmong.n === 1
                          ? 'the cheapest seller of this product here'
                          : <>#{rankAmong.n} of {rankAmong.of} sellers by delivered price</>}
                      </div>
                    )}
                  </div>
                </div>

                {/* Gap set inline: `gap-x-8` generated no CSS here (computed
                    column-gap stayed `normal`), so every cell ran into the next
                    — "AT YOUR SITEMOQ". The rest of this file styles inline
                    anyway; this is deterministic. */}
                <div className="mt-4 flex flex-wrap text-[12px]" style={{ columnGap: 30, rowGap: 10 }}>
                  <Fact label="Seller's price" value={`${rupees(clicked.base_paise)} / ${clicked.base_unit}`} />
                  <Fact label="GST" value={`${(clicked.gst_rate_bp / 100).toFixed(0)}% ${clicked.gst_treatment === 'INCL' ? 'included' : 'added'}`} />
                  <Fact label="Delivery + handling" value={rupees(clicked.freight_paise + clicked.handling_paise + clicked.loading_paise)} estimated
                    onClick={() => setBreakdown(clicked)} />
                  <Fact label="At your site" value={rupees(clicked.landed_paise)} />
                  <Fact label="MOQ" value={clicked.moq_qty != null ? `${clicked.moq_qty} ${clicked.moq_unit ?? ''}`.trim() : 'not stated'} />
                  <Fact label="Verified" value={relativeAge(clicked.fetched_at)} />
                </div>

                <a href={clicked.source_url} target="_blank" rel="noopener noreferrer"
                  className="mt-3 inline-block text-[12px] anim hover:opacity-70 underline decoration-dotted underline-offset-2"
                  style={{ color: 'var(--accent)' }}>
                  open this listing at {clicked.platform} ↗
                </a>
              </section>
            )}

            {/* ── identity ───────────────────────────────────────────────── */}
            <div className="pt-6 flex gap-5">
              {/* The sheet is "show everything", so pictures are picked here
                  rather than rotated at you — every one is a thumbnail you can
                  choose, each labelled with the listing it came from. */}
              <SheetGallery images={data.images ?? []} title={p.title} />
              <div className="min-w-0 flex-1">
                {p.brand && <div className="text-[11px] uppercase tracking-[0.14em] mb-1" style={{ color: 'var(--ink-3)' }}>{p.brand}</div>}
                <h1 className="display text-[24px] leading-[1.18]">{p.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                  <span>HSN {p.hsn}</span>
                  <span>GST {(p.gst_rate_bp / 100).toFixed(0)}%</span>
                  {p.cert_standards?.length > 0 && <span>{p.cert_standards.join(' · ')}</span>}
                  <span className="fig">{p.item_code.includes('UNRESOLVED') ? 'identity unresolved' : p.item_code}</span>
                </div>
              </div>
            </div>

            {/* ── price summary: floor / current / ceiling ────────────────── */}
            {price && (
              <section className="mt-6 p-5 corner-tick" style={{ background: 'var(--glass-quiet)', border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius)' }}>
                <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
                  <Stat label="Floor" sub="lowest delivered here" paise={price.floor_paise} unit={price.normalised_unit} />
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.12em] mb-1" style={{ color: 'var(--ink-3)' }}>Current</div>
                    <Money paise={price.normalised_paise} unit={price.normalised_unit} size="hero" accent />
                    <div className="text-[11px] mt-1" style={{ color: 'var(--ink-2)' }}>best delivered offer</div>
                  </div>
                  <Stat label="Ceiling" sub="highest delivered here" paise={price.ceiling_paise} unit={price.normalised_unit} />
                  <Stat label="Median" sub={`across ${price.offer_count} offers`} paise={price.median_paise} unit={price.normalised_unit} />
                </div>

                <Hairline className="my-4" />

                {/* Read top to bottom like a bill: seller's price first, then the total. */}
                <div className="grid sm:grid-cols-2 gap-x-10 gap-y-1.5 text-[12.5px]">
                  <Line label="Seller's price, ex-GST" paise={price.base_paise} />
                  <Line label={`GST @ ${(p.gst_rate_bp / 100).toFixed(0)}% (HSN ${p.hsn})`} paise={price.gst_paise} />
                  <Line label="Delivery to your pincode" paise={price.freight_paise} estimated />
                  <Line label="Handling" paise={price.handling_paise} estimated />
                  <Line label="Loading / unloading" paise={price.loading_paise} estimated />
                  <div className="sm:col-span-2 pt-2 mt-1 rule-t flex items-baseline justify-between">
                    <strong className="text-[13px]">What you pay, at your site</strong>
                    <Money paise={price.landed_paise} unit={price.normalised_unit} size="lg" />
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <FreshnessDot dot={price.freshness_dot} label={price.freshness_label} exact={price.freshness_exact} />
                  <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                    refresh window {price.sla_hours} h · reason code <span className="fig">{price.reason_code}</span>
                  </span>
                  {data.sor_anchor && (
                    <span className="text-[11px]" style={{ color: 'var(--ink-3)' }}>
                      · government reference:{' '}
                      <a className="underline decoration-dotted underline-offset-2" href={data.sor_anchor.source_url}
                        target="_blank" rel="noreferrer noopener" title={data.sor_anchor.note}>
                        {data.sor_anchor.state_code} {data.sor_anchor.effective_period}
                      </a>
                    </span>
                  )}
                </div>
              </section>
            )}

            {/* ── vendor table ───────────────────────────────────────────── */}
            <Section title="Every vendor" n={offers.length}>
              <VendorTable offers={offers} unit={price?.normalised_unit ?? p.unit_canonical} onBreakdown={setBreakdown} totalOffers={data?.total_offers} highlightVendorId={highlightVendorId} />
            </Section>

            {/* ── specification with provenance on every row ─────────────── */}
            <Section title="Specification" n={data.specs.length}>
              <p className="text-[11.5px] mb-2.5" style={{ color: 'var(--ink-3)' }}>
                Every row carries where the value came from. A field with no provenance does not render.
              </p>
              <div style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
                {data.specs.map((s: any, i: number) => (
                  <div key={s.field} className={`flex items-baseline gap-3 px-3 py-2 ${i ? 'rule-soft-b' : ''}`}
                    style={i === 0 ? undefined : { borderTop: '1px solid var(--rule-soft)', borderBottom: 'none' }}>
                    <span className="text-[12px] w-[190px] shrink-0" style={{ color: 'var(--ink-3)' }}>{s.label}</span>
                    <span className="text-[12.5px] flex-1 min-w-0" style={{ color: s.confidence === 'unknown' ? 'var(--ink-3)' : 'var(--ink)' }}>
                      {s.value}{s.unit ? <span className="opacity-60 ml-1">{s.unit}</span> : null}
                    </span>
                    <ProvenanceBadge confidence={s.confidence} derivation={s.derivation} sourceUrl={s.source_url} />
                    <a href={s.source_url} target="_blank" rel="noreferrer noopener"
                      className="anim hover:opacity-70 shrink-0" style={{ color: 'var(--ink-3)' }} aria-label="Open source">
                      <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden>
                        <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
                          fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                      </svg>
                    </a>
                  </div>
                ))}
              </div>
            </Section>

            {/* ── the typed attribute tuple ─────────────────────────────── */}
            {/* Fetched by /api/sku since this sheet was written and never
                rendered. It is the resolved, typed version of the spec rows
                above — what entity resolution actually decided. */}
            {attrRows.length > 0 && (
              <Section title="Resolved attributes" n={attrRows.length}>
                <p className="text-[11.5px] mb-2.5" style={{ color: 'var(--ink-3)' }}>
                  The typed tuple this product resolved to. These are what the filters and the price
                  comparison run on — the specification above is the seller&apos;s raw text.
                </p>
                <div className="grid sm:grid-cols-2 gap-x-6" style={{ border: '1px solid var(--rule)', borderRadius: '10px', padding: '4px 12px' }}>
                  {attrRows.map(([k, v]) => (
                    <div key={k} className="flex items-baseline gap-3 py-1.5 text-[12.5px]">
                      <span className="w-[150px] shrink-0" style={{ color: 'var(--ink-3)' }}>{ATTR_LABEL[k] ?? k.replace(/_/g, ' ')}</span>
                      <span className="fig min-w-0 truncate" style={{ color: 'var(--ink)' }}>{String(v)}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* ── datasheets ────────────────────────────────────────────── */}
            {/* Also fetched and never rendered. Scanned spec sheets are kept out
                of the photo gallery on purpose — a buyer looking at pictures
                expects the goods — but they belong somewhere, and this is it. */}
            {(data.datasheet_images?.length ?? 0) > 0 && (
              <Section title="Datasheets and spec sheets" n={data.datasheet_images.length}>
                <div className="flex flex-wrap gap-2">
                  {data.datasheet_images.map((d: any) => (
                    <a key={d.local_path} href={d.page_url ?? d.local_path} target="_blank" rel="noopener noreferrer"
                      className="anim hover:opacity-80" title={d.page_url ?? 'datasheet'}>
                      <img src={d.local_path} alt="Datasheet" width={72} height={72} loading="lazy"
                        style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--rule)' }} />
                    </a>
                  ))}
                </div>
              </Section>
            )}

            {/* ── price history ─────────────────────────────────────────── */}
            <Section title="Price history" n={data.history.length}>
              <PriceHistory points={data.history} unit={price?.normalised_unit ?? p.unit_canonical} />
              {/* A "tell me when this drops" checkbox used to sit here. It set
                  local state and nothing else — no alert was ever stored or
                  sent. A control that looks like it works and does not is worse
                  than an absent one, so it is gone rather than mocked. */}
            </Section>

            {/* ── certification block, always present ────────────────────── */}
            <Section title="Certification">
              <div className="p-4" style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
                {/* The clicked seller's state, not `offers[0]` — that is the
                    CHEAPEST seller, and showing their certification as though
                    it described the product misattributes one seller's
                    compliance to every other. */}
                <CertBadge state={clicked?.cert_state ?? offers[0]?.cert_state ?? 'NOT_DECLARED'} qco={p.qco_regulated} />
                {clicked && (
                  <p className="mt-1.5 text-[11px]" style={{ color: 'var(--ink-3)' }}>
                    This is <strong style={{ color: 'var(--ink-2)' }}>{clicked.vendor.name}</strong>&apos;s state.
                    Certification is per listing, not per product — the vendor table above shows each seller&apos;s.
                  </p>
                )}
                <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
                  {p.qco_regulated ? (
                    <>
                      A Quality Control Order makes a valid BIS licence a legal condition of sale in this category.
                      Where a seller's licence has positively expired, the offer is filtered out and the reason is
                      stated — no weight tuning, experiment or sponsored bid can bypass that.{' '}
                      <strong>A listing that simply does not publish its licence number is a different claim</strong>{' '}
                      and is listed, priced and ranked, with that fact stated.
                    </>
                  ) : (
                    <>
                      This category is not under a Quality Control Order. Certification labels here — it never hides.
                      Most of the Indian construction market is legal, everyday material carrying no BIS mark, and a
                      broad certification filter would delete half of it.
                    </>
                  )}
                </p>
                {p.qco_citation && (
                  <p className="mt-2 text-[11px] italic" style={{ color: 'var(--ink-3)' }}>{p.qco_citation}</p>
                )}
              </div>
            </Section>

            {/* ── substitutes ───────────────────────────────────────────── */}
            {data.substitutes.length > 0 && (
              <Section title="Substitutes and equivalents" n={data.substitutes.length}>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {data.substitutes.map((s: any) => {
                    const delta = price ? s.normalised_paise - price.normalised_paise : 0;
                    return (
                      <button key={s.product_id}
                        onClick={() => window.dispatchEvent(new CustomEvent('buildo:open-sku', { detail: s.product_id }))}
                        className="text-left p-3 anim hover:bg-[rgba(22,20,18,.045)]"
                        style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
                        <div className="text-[12.5px] truncate" style={{ color: 'var(--ink)' }}>{s.title}</div>
                        <div className="mt-1.5 flex items-baseline justify-between gap-2">
                          <Money paise={s.normalised_paise} unit={s.unit_canonical} size="sm" />
                          {delta !== 0 && (
                            <span className="fig text-[11px]" style={{ color: delta < 0 ? 'var(--fresh)' : 'var(--ink-3)' }}>
                              {delta < 0 ? '−' : '+'}{rupees(Math.abs(delta))}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Section>
            )}

            {/* ── sources ───────────────────────────────────────────────── */}
            <Section title="Sources" n={new Set(offers.map((o) => o.source_url)).size}>
              <ul className="space-y-1">
                {[...new Set(offers.map((o) => o.source_url))].map((u) => (
                  <li key={u}>
                    <a href={u} target="_blank" rel="noreferrer noopener"
                      className="text-[11.5px] anim hover:opacity-70 underline decoration-dotted underline-offset-2 break-all"
                      style={{ color: 'var(--ink-2)' }}>{u}</a>
                  </li>
                ))}
              </ul>
              {p.datasheet_url && (
                <a href={p.datasheet_url} target="_blank" rel="noreferrer noopener"
                  className="chip anim inline-flex items-center gap-1.5 px-3 h-8 text-[12px] mt-3">
                  Manufacturer datasheet
                </a>
              )}
            </Section>
          </div>
        )}
      </div>

      {breakdown && <BreakdownModal offer={breakdown} onClose={() => setBreakdown(null)} />}
    </>
  );
}

function Stat({ label, sub, paise, unit }: { label: string; sub: string; paise: number; unit: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.12em] mb-1" style={{ color: 'var(--ink-3)' }}>{label}</div>
      <Money paise={paise} unit={unit} size="lg" />
      <div className="text-[11px] mt-1" style={{ color: 'var(--ink-3)' }}>{sub}</div>
    </div>
  );
}

function Line({ label, paise, estimated }: { label: string; paise: number; estimated?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span style={{ color: 'var(--ink-2)' }}>
        {label}
        {estimated && <span className="prov ml-1.5">estimated</span>}
      </span>
      <span className="fig" style={{ color: 'var(--ink)' }}>{rupees(paise)}</span>
    </div>
  );
}

/**
 * One labelled figure in the clicked-offer block.
 *
 * Deliberately never a <button>, even when it has a click target. Wrapping the
 * whole cell in one nested a button inside a button — invalid HTML, a hydration
 * error, and worse than either: the browser's parser HOISTS the inner button
 * out of the outer one, which split each cell into two separate flex items and
 * collided the labels ("AT YOUR SITEMOQ"). The EstimatedBadge is the control.
 */
function Fact({
  label, value, estimated, onClick,
}: { label: string; value: string; estimated?: boolean; onClick?: () => void }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.1em] whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>{label}</div>
      <div className="fig text-[13px] mt-0.5 flex items-center gap-1.5 whitespace-nowrap" style={{ color: 'var(--ink)' }}>
        {value}
        {estimated && <EstimatedBadge onClick={onClick} />}
      </div>
    </div>
  );
}

function Section({ title, n, children }: { title: string; n?: number; children: React.ReactNode }) {
  return (
    <section className="mt-9">
      <h2 className="display text-[17px] mb-3 flex items-baseline gap-2">
        {title}
        {n !== undefined && <span className="tnum text-[12px]" style={{ color: 'var(--ink-3)' }}>{n}</span>}
      </h2>
      {children}
    </section>
  );
}

/** Delivery cost breakdown — the arithmetic, one tap from the figure. */
function BreakdownModal({ offer, onClose }: { offer: OfferView; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-6" style={{ background: 'rgba(28,25,22,.34)', WebkitBackdropFilter: 'blur(3px)', backdropFilter: 'blur(3px)' }}
      onClick={onClose} role="dialog" aria-modal="true" aria-label="Delivery cost breakdown">
      <div className="w-[min(560px,94vw)] p-5 fade-up corner-tick" onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--glass-strong)', border: '1px solid var(--rule)', borderRadius: '10px' }}>
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="display text-[17px]">How this delivery cost was computed</h3>
          <button onClick={onClose} className="chip anim h-7 px-2 text-[11px]">✕</button>
        </div>
        <p className="text-[11.5px] mb-3" style={{ color: 'var(--ink-3)' }}>
          {offer.vendor.name} → your pincode. Deterministic: the same inputs always give the same figure, so this
          number never changes when you reload.
        </p>
        <ol className="space-y-2">
          {offer.freight_breakdown.map((b, i) => (
            <li key={i} className="flex items-baseline gap-3 text-[12.5px]">
              <span className="tnum w-4 shrink-0" style={{ color: 'var(--ink-3)' }}>{i + 1}</span>
              <span className="flex-1">
                <span style={{ color: 'var(--ink)' }}>{b.step}</span>
                <span className="block text-[11.5px] leading-snug" style={{ color: 'var(--ink-3)' }}>{b.detail}</span>
              </span>
              {b.value && <span className="fig shrink-0" style={{ color: 'var(--ink)' }}>{b.value}</span>}
            </li>
          ))}
        </ol>
        <div className="mt-4 pt-3 rule-t flex items-baseline justify-between">
          <span className="text-[12.5px]" style={{ color: 'var(--ink-2)' }}>Freight + handling + loading</span>
          <span className="fig text-[15px]">{rupees(offer.freight_paise + offer.handling_paise + offer.loading_paise)}</span>
        </div>
        {offer.freight_basis === 'seeded_fallback' && (
          <p className="mt-3 text-[11px] leading-snug px-2 py-1.5"
            style={{ color: 'var(--ageing)', border: '1px solid color-mix(in srgb, var(--ageing) 40%, transparent)' }}>
            This seller's locality could not be geocoded, so the distance is derived from a hash of the seller id.
            It is stable on every reload — but it is an estimate of distance, not a measurement of it.
          </p>
        )}
      </div>
    </div>
  );
}

/** 90-day line with a shaded range band and an annotation on any >5% move. */
function PriceHistory({ points, unit }: { points: Array<{ observed_at: string; normalised_paise: number }>; unit: string }) {
  if (points.length < 2) {
    return (
      <div className="p-6 text-center" style={{ border: '1px solid var(--rule)', borderRadius: '10px' }}>
        <p className="text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
          Only one observation so far — history starts building from the first collection run.
        </p>
        <p className="text-[11px] mt-1" style={{ color: 'var(--ink-3)' }}>
          The daily job appends to <span className="fig">price_history</span> on every run.
        </p>
      </div>
    );
  }
  const W = 640, H = 150, pad = 28;
  const vals = points.map((p) => p.normalised_paise);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - lo) / span) * (H - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.normalised_paise).toFixed(1)}`).join(' ');

  return (
    <div style={{ border: '1px solid var(--rule)', borderRadius: '10px' }} className="p-3 x-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={`Price history, ${points.length} observations, from ${rupees(lo)} to ${rupees(hi)} per ${unit}`}>
        <rect x={pad} y={pad} width={W - pad * 2} height={H - pad * 2} fill="rgba(22,20,18,.045)" opacity=".55" />
        <path d={`${d} L${x(points.length - 1)},${H - pad} L${x(0)},${H - pad} Z`} fill="var(--accent)" opacity=".07" />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.4" />
        {points.map((p, i) => (
          <circle key={i} cx={x(i)} cy={y(p.normalised_paise)} r="2" fill="var(--accent)" />
        ))}
        <text x={pad} y={pad - 8} fontSize="10" fill="var(--ink-3)">{rupees(hi)}</text>
        <text x={pad} y={H - pad + 14} fontSize="10" fill="var(--ink-3)">{rupees(lo)}</text>
      </svg>
    </div>
  );
}

function SheetSkeleton() {
  return (
    <div className="px-6 md:px-8 pt-6 pb-24">
      <div className="flex gap-5">
        <div className="skel w-[110px] h-[110px]" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="skel h-3 w-24" />
          <div className="skel h-6 w-3/5" />
          <div className="skel h-3 w-2/5" />
        </div>
      </div>
      <div className="skel h-[186px] mt-6" />
      <div className="skel h-4 w-32 mt-9" />
      <div className="skel h-[240px] mt-3" />
      <div className="skel h-4 w-32 mt-9" />
      <div className="skel h-[180px] mt-3" />
    </div>
  );
}

/**
 * The sheet's picture picker.
 *
 * Deliberately not the card's auto-rotation: on a card, motion earns attention
 * for a thing you are scanning past; in the sheet you have already stopped, and
 * taking control away from someone who is reading would be worse than useless.
 * So: one large frame, thumbnails beneath, each naming the listing it came from.
 */
function SheetGallery({ images, title }: { images: Array<{ local_path: string; page_url: string | null }>; title: string }) {
  const [i, setI] = React.useState(0);
  const [broken, setBroken] = React.useState<Set<string>>(() => new Set());
  const live = images.filter((x) => !broken.has(x.local_path));
  const cur = live[Math.min(i, live.length - 1)];

  return (
    <div className="shrink-0">
      <div
        className="w-[110px] h-[110px] grid place-items-center overflow-hidden corner-tick"
        style={{ background: 'var(--glass-quiet)', border: '1px solid var(--glass-hair)', borderRadius: 'var(--radius)' }}
      >
        {cur ? (
          <img
            src={cur.local_path} alt={title} className="w-full h-full object-cover"
            onError={() => setBroken((s) => new Set(s).add(cur.local_path))}
          />
        ) : (
          <svg width="44" height="44" viewBox="0 0 24 24" aria-hidden style={{ color: 'var(--ink-3)', opacity: .45 }}>
            <rect x="3" y="7" width="18" height="12" fill="none" stroke="currentColor" strokeWidth="1" />
            <path d="M3 11h18M8 7v12" stroke="currentColor" strokeWidth="1" />
          </svg>
        )}
      </div>

      {live.length > 1 && (
        <div className="flex gap-1 mt-1.5 flex-wrap" style={{ maxWidth: 110 }}>
          {live.slice(0, 8).map((im, n) => (
            <button
              key={im.local_path}
              onClick={() => setI(n)}
              aria-label={`Picture ${n + 1} of ${live.length}`}
              aria-current={n === i}
              title={im.page_url ? `From the listing at ${im.page_url}` : undefined}
              className="anim overflow-hidden"
              style={{
                width: 24, height: 24, borderRadius: 5,
                border: `1px solid ${n === i ? 'var(--accent)' : 'var(--glass-hair)'}`,
                opacity: n === i ? 1 : .7,
              }}
            >
              <img src={im.local_path} alt="" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
