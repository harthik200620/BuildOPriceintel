'use client';

import React from 'react';
import { Money, FreshnessDot, CertBadge, rupees } from './primitives';

/**
 * The docked assistant.
 *
 * Two things here are deliberate and both are about trust rather than polish:
 *
 *   Nothing streams token by token. The engine validates a whole draft before
 *   any of it is shown, so what streams is the WORK — "searching cement",
 *   "pricing 3 lines" — and the answer lands complete. A number that appears
 *   and then changes is worse than a number that arrives a second later.
 *
 *   Structured results are rendered as components, not as text the model wrote.
 *   The model never types a price: it calls a tool, the tool returns a card,
 *   and the card renders itself from the same primitives the search grid uses.
 *   So the ₹ in the panel and the ₹ in the results table are the same number by
 *   construction, and the model cannot typo one.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  ui?: any[];
  sources?: Array<{ label: string; url: string; fetched_at?: string; confidence?: string }>;
  suggestions?: string[];
  refused?: boolean;
  trace?: any;
  pending?: boolean;
}

interface Welcome {
  greeting: string;
  chips: Array<{ label: string; prompt: string }>;
  ready: boolean;
  model: string;
}

export default function ChatPanel({
  pincode, regionName, onApplySearch,
}: {
  pincode: string;
  regionName: string;
  /** Lets an answer push a query into the main grid behind the panel. */
  onApplySearch?: (q: string, category?: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [welcome, setWelcome] = React.useState<Welcome | null>(null);
  const [msgs, setMsgs] = React.useState<Msg[]>([]);
  const [input, setInput] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [stage, setStage] = React.useState<string | null>(null);
  const [toolLog, setToolLog] = React.useState<string[]>([]);
  const [showTrace, setShowTrace] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => {
    if (!open || welcome) return;
    fetch('/api/chat').then((r) => r.json()).then(setWelcome).catch(() => {});
  }, [open, welcome]);

  React.useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, stage, toolLog]);

  // A turn can outlive the panel — the stream loop keeps calling setState
  // after unmount otherwise. The controller was wired into fetch but nothing
  // ever pulled it.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  // Cmd/Ctrl-J opens it from anywhere; Escape closes.
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape' && open) setOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  async function send(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setErr(null);
    setInput('');
    setToolLog([]);
    setStage('thinking');
    setBusy(true);

    const history = msgs.filter((m) => !m.pending).map((m) => ({ role: m.role, content: m.content }));
    setMsgs((m) => [...m, { role: 'user', content: q }]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q, history, pincode }),
        signal: ac.signal,
      });

      if (!res.ok && res.headers.get('content-type')?.includes('json')) {
        const j = await res.json();
        setErr(j.message ?? 'The assistant is unavailable.');
        setBusy(false); setStage(null);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body.');
      const dec = new TextDecoder();
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const f of frames) {
          const ev = /^event: (.+)$/m.exec(f)?.[1];
          const dataLine = /^data: (.+)$/m.exec(f)?.[1];
          if (!ev || !dataLine) continue;
          const data = JSON.parse(dataLine);
          if (ev === 'status') setStage(data.stage);
          if (ev === 'tool') setToolLog((t) => [...t, TOOL_LABEL[data.name] ?? data.name]);
          if (ev === 'error') setErr(data.message);
          if (ev === 'message') {
            setMsgs((m) => [...m, {
              role: 'assistant', content: data.reply, ui: data.ui,
              sources: data.sources, suggestions: data.suggestions,
              refused: data.refused, trace: data.trace,
            }]);
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') setErr(String(e?.message ?? e));
    } finally {
      setBusy(false); setStage(null); setToolLog([]);
      abortRef.current = null;
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="anim lift fixed z-40 flex items-center gap-2 px-4 py-3"
        style={{
          right: 20, bottom: 20, borderRadius: 'var(--radius-pill)',
          background: 'var(--accent)', color: 'var(--on-bright)',
          boxShadow: 'var(--glass-shadow-lift)', border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 600, letterSpacing: '.01em',
        }}
        title="Ask the buying assistant  (⌘J)"
      >
        <BotIcon />
        Ask
      </button>
    );
  }

  return (
    <aside
      className="glass sheet-in fixed z-40 flex flex-col"
      style={{
        right: 16, bottom: 16, top: 76, width: 'min(430px, calc(100vw - 32px))',
        borderRadius: 'var(--radius)', border: '1px solid var(--glass-border)',
        boxShadow: 'var(--glass-shadow-lift)', overflow: 'hidden',
      }}
      aria-label="Buying assistant"
    >
      {/* header */}
      <header
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ background: 'var(--chrome)', borderBottom: '1px solid var(--rule)' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span style={{ color: 'var(--accent)' }}><BotIcon /></span>
          <div className="min-w-0">
            {/* The title voice, so the assistant reads as this product and not
                a widget bolted onto it. */}
            <div className="display text-[13.5px] truncate" style={{ color: 'var(--ink)' }}>
              Buying assistant
            </div>
            <div className="text-[10.5px] truncate" style={{ color: 'var(--ink-3)' }}>
              {regionName} · {pincode} · prices landed here
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {msgs.length > 0 && (
            <button
              type="button" onClick={() => { setMsgs([]); setErr(null); }}
              className="anim px-2 py-1 text-[11px]"
              style={{ color: 'var(--ink-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
              title="Clear the conversation"
            >clear</button>
          )}
          <button
            type="button" onClick={() => setOpen(false)}
            className="anim p-1.5" aria-label="Close assistant"
            style={{ color: 'var(--ink-2)', background: 'transparent', border: 'none', cursor: 'pointer', lineHeight: 0 }}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* thread */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-4 py-4" style={{ scrollbarWidth: 'thin' }}>
        {msgs.length === 0 && welcome && (
          <div className="fade-up">
            <p className="text-[13.5px] leading-[1.55] mb-3.5" style={{ color: 'var(--ink-2)' }}>
              {welcome.greeting}
            </p>
            {!welcome.ready && (
              <div
                className="mb-3.5 px-3 py-2.5 text-[11.5px] leading-[1.5]"
                style={{
                  color: 'var(--ageing)', background: 'color-mix(in srgb, var(--ageing) 12%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--ageing) 32%, transparent)', borderRadius: 10,
                }}
              >
                No Gemini API key configured. Add <code className="fig">GEMINI_API_KEY</code> to
                {' '}<code className="fig">.env.local</code> and restart the dev server.
              </div>
            )}
            <div className="text-[10px] uppercase tracking-[.09em] mb-2" style={{ color: 'var(--ink-3)' }}>
              Try one
            </div>
            <div className="flex flex-wrap gap-1.5">
              {welcome.chips.map((c) => (
                <button
                  key={c.label} type="button" className="chip anim text-left"
                  onClick={() => send(c.prompt)} disabled={!welcome.ready}
                >{c.label}</button>
              ))}
            </div>
          </div>
        )}

        {msgs.map((m, i) => (
          <MessageView
            key={i} msg={m} showTrace={showTrace}
            onSuggest={send} onApplySearch={onApplySearch}
          />
        ))}

        {busy && (
          <div className="fade-up flex flex-col gap-1.5 mb-3">
            <div className="flex items-center gap-2 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
              <Pulse />
              {stage === 'thinking' && toolLog.length === 0 ? 'reading your question' : 'working'}
            </div>
            {toolLog.map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px] pl-0.5" style={{ color: 'var(--ink-3)' }}>
                <span className="dot dot-green" aria-hidden />{t}
              </div>
            ))}
          </div>
        )}

        {err && (
          <div
            className="fade-up px-3 py-2.5 text-[12px] leading-[1.5] mb-3"
            style={{
              color: 'var(--ageing)', background: 'color-mix(in srgb, var(--ageing) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--ageing) 32%, transparent)', borderRadius: 10,
            }}
          >{err}</div>
        )}
      </div>

      {/* composer */}
      <div className="shrink-0 px-3 py-3" style={{ borderTop: '1px solid var(--rule)', background: 'var(--chrome)' }}>
        <form
          onSubmit={(e) => { e.preventDefault(); send(input); }}
          className="flex items-center gap-2"
        >
          <input
            ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a price, or how much you need…"
            className="field flex-1 text-[13px]"
            style={{ padding: '9px 12px', borderRadius: 10 }}
            disabled={busy || welcome?.ready === false}
            aria-label="Message"
          />
          <button
            type="submit" disabled={busy || !input.trim()}
            className="anim shrink-0 flex items-center justify-center"
            style={{
              width: 34, height: 34, borderRadius: 9, border: 'none',
              background: input.trim() && !busy ? 'var(--accent)' : 'var(--wash)',
              color: input.trim() && !busy ? 'var(--on-bright)' : 'var(--ink-3)',
              cursor: input.trim() && !busy ? 'pointer' : 'default', lineHeight: 0,
            }}
            aria-label="Send"
          >
            <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
              <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </button>
        </form>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[10px]" style={{ color: 'var(--ink-3)' }}>
            Every figure is checked against the catalogue before it is shown.
          </span>
          <button
            type="button" onClick={() => setShowTrace((s) => !s)}
            className="anim text-[10px]"
            style={{ color: showTrace ? 'var(--accent)' : 'var(--ink-3)', background: 'none', border: 'none', cursor: 'pointer' }}
          >{showTrace ? 'hide trace' : 'trace'}</button>
        </div>
      </div>
    </aside>
  );
}

// ─── message ─────────────────────────────────────────────────────────────────

const TOOL_LABEL: Record<string, string> = {
  get_catalogue_scope: 'checking what I cover',
  search_products: 'searching the catalogue',
  get_product_detail: 'reading the listing',
  rank_by_quality: 'ranking on quality',
  estimate_quantity: 'working out quantities',
  price_estimate: 'pricing the job',
  list_options: 'fetching the options',
  compare_products: 'comparing',
};

function MessageView({
  msg, showTrace, onSuggest, onApplySearch,
}: {
  msg: Msg; showTrace: boolean;
  onSuggest: (s: string) => void;
  onApplySearch?: (q: string, c?: string | null) => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="fade-up flex justify-end mb-3.5">
        <div
          className="text-[13px] leading-[1.5] px-3 py-2 max-w-[85%]"
          style={{
            background: 'var(--seg-on)', color: 'var(--ink)',
            borderRadius: '12px 12px 3px 12px',
          }}
        >{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="fade-up mb-4">
      <div
        className="text-[13px] leading-[1.6] whitespace-pre-wrap"
        style={{ color: msg.refused ? 'var(--ink-2)' : 'var(--ink)' }}
      >
        {msg.content}
      </div>

      {msg.ui?.map((block, i) => <UiBlock key={i} block={block} onApplySearch={onApplySearch} onSuggest={onSuggest} />)}

      {!!msg.sources?.length && <Sources sources={msg.sources} />}

      {!!msg.suggestions?.length && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {msg.suggestions.map((s) => (
            <button key={s} type="button" className="chip anim text-[11px]" onClick={() => onSuggest(s)}>{s}</button>
          ))}
        </div>
      )}

      {showTrace && msg.trace && <Trace trace={msg.trace} />}
    </div>
  );
}

// ─── rendered tool output ────────────────────────────────────────────────────

function UiBlock({
  block, onApplySearch, onSuggest,
}: { block: any; onApplySearch?: (q: string, c?: string | null) => void; onSuggest: (s: string) => void }) {
  if (!block?.kind) return null;

  if (block.kind === 'products') {
    return (
      <div className="mt-2.5 flex flex-col gap-1.5">
        {block.cards.slice(0, 4).map((c: any) => (
          <button
            key={c.offer_id ?? c.product_id} type="button"
            onClick={() => onApplySearch?.(c.title, c.category)}
            className="glass-card anim lift text-left w-full px-3 py-2.5"
            style={{ border: '1px solid var(--glass-hair)', borderRadius: 11, cursor: 'pointer' }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] leading-[1.35] truncate" style={{ color: 'var(--ink)' }}>{c.title}</div>
                <div className="text-[10.5px] mt-1 truncate" style={{ color: 'var(--ink-3)' }}>
                  {c.best_vendor}{c.vendor_locality ? ` · ${c.vendor_locality}` : ''}
                </div>
              </div>
              <div className="text-right shrink-0">
                <Money paise={c.normalised_paise} unit={c.unit_canonical} size="sm" stale={c.freshness_dot === 'grey'} />
                <div className="mt-1 flex justify-end">
                  <FreshnessDot dot={c.freshness_dot} label={c.freshness_label} />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              {c.cert_state && <CertBadge state={c.cert_state} qco={c.qco_regulated} compact />}
              <span className="text-[10px]" style={{ color: 'var(--ink-3)' }}>
                {c.vendor_count} seller{c.vendor_count === 1 ? '' : 's'} · range {rupees(c.floor_paise, false)}–{rupees(c.ceiling_paise, false)}
              </span>
            </div>
          </button>
        ))}
      </div>
    );
  }

  if (block.kind === 'options') {
    return (
      <div className="mt-2.5 flex flex-col gap-1">
        {block.options.map((o: any) => (
          <button
            key={o.id} type="button" onClick={() => onSuggest(o.label)}
            className="glass-card anim text-left px-3 py-2"
            style={{ border: '1px solid var(--glass-hair)', borderRadius: 9, cursor: 'pointer' }}
          >
            <div className="text-[12px]" style={{ color: 'var(--ink)' }}>{o.label}</div>
            {o.note && <div className="text-[10.5px] mt-0.5 leading-[1.4]" style={{ color: 'var(--ink-3)' }}>{o.note}</div>}
          </button>
        ))}
      </div>
    );
  }

  if (block.kind === 'slot_prompt') {
    return (
      <div className="mt-2.5 flex flex-col gap-1.5">
        {block.missing.map((m: any, i: number) => (
          <div key={i}>
            <div className="text-[12px] leading-[1.5] mb-1.5" style={{ color: 'var(--ink-2)' }}>{m.question}</div>
            {!!m.options?.length && (
              <div className="flex flex-wrap gap-1.5">
                {m.options.map((o: string) => (
                  <button key={o} type="button" className="chip anim text-[11px]" onClick={() => onSuggest(o)}>{o}</button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }

  if (block.kind === 'estimate' || block.kind === 'priced_estimate') {
    return <EstimateBlock block={block} />;
  }

  if (block.kind === 'quality_ranking') return <QualityBlock block={block} />;
  if (block.kind === 'masonry_guide') return <MasonryBlock block={block} />;

  if (block.kind === 'product_detail') {
    return (
      <div className="glass-card mt-2.5 overflow-hidden" style={{ border: '1px solid var(--glass-hair)', borderRadius: 11 }}>
        <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rule-soft)' }}>
          <div className="text-[11.5px]" style={{ color: 'var(--ink)' }}>{block.title}</div>
          <div className="text-[10px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
            {block.total_vendors} seller{block.total_vendors === 1 ? '' : 's'} · {block.total_offers} listing{block.total_offers === 1 ? '' : 's'}
          </div>
        </div>
        <table className="w-full text-[11px]">
          <tbody>
            {block.vendors.map((v: any, i: number) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                <td className="px-3 py-1.5" style={{ color: 'var(--ink-2)' }}>
                  {v.vendor}
                  {v.locality && <span className="block text-[10px]" style={{ color: 'var(--ink-3)' }}>{v.locality}</span>}
                </td>
                <td className="px-2 py-1.5 text-right fig whitespace-nowrap" style={{ color: 'var(--ink)' }}>{v.per_unit}</td>
                <td className="px-3 py-1.5 text-right text-[10px] whitespace-nowrap" style={{ color: 'var(--ink-3)' }}>
                  {v.lead_time_days != null ? `${v.lead_time_days} d` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (block.kind === 'compare') {
    return (
      <div className="glass-card mt-2.5 overflow-hidden" style={{ border: '1px solid var(--glass-hair)', borderRadius: 11 }}>
        <table className="w-full text-[11.5px]">
          <tbody>
            {block.products.map((p: any, i: number) => (
              <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
                <td className="px-3 py-2" style={{ color: 'var(--ink)' }}>
                  {p.title}
                  <span className="block text-[10px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    {p.vendor ?? '—'} · {p.vendors} seller{p.vendors === 1 ? '' : 's'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right fig whitespace-nowrap" style={{ color: 'var(--ink)' }}>
                  {p.best ?? '—'}
                  <span className="opacity-55 ml-1" style={{ fontSize: '.85em' }}>/{p.unit}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {block.note && (
          <div className="px-3 py-2 text-[10.5px] leading-[1.45]" style={{ color: 'var(--ageing)', borderTop: '1px solid var(--rule-soft)' }}>
            {block.note}
          </div>
        )}
      </div>
    );
  }

  return null;
}

/**
 * The "best cement" answer.
 *
 * Rendered here rather than left to the model's prose because the honest parts
 * — how much of the catalogue actually declared a grade, and which listings
 * were excluded for contradicting their own standard — are exactly the parts a
 * model summarising in two sentences would drop.
 */
/**
 * What gets rendered when a ranking would be a lie.
 *
 * Deliberately NOT a ranked table with a disclaimer under it — the numbered
 * column is what people read, and a "1" beside a row is a claim no matter what
 * the footnote says. This lists types, not places, and the standard sits next
 * to each one because that is the part the catalogue cannot give you and the
 * published standard can.
 */
function MasonryBlock({ block }: { block: any }) {
  const [openWhy, setOpenWhy] = React.useState(false);
  const rows = block.for_duty?.length ? block.for_duty : block.types;
  return (
    <div className="glass-card mt-2.5 overflow-hidden" style={{ border: '1px solid var(--glass-hair)', borderRadius: 11 }}>
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rule-soft)' }}>
        <div className="text-[10px] uppercase tracking-[.08em]" style={{ color: 'var(--ink-3)' }}>
          {block.category} — by type
        </div>
        {block.duty && (
          <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--ink-2)' }}>{block.duty}</div>
        )}
      </div>

      <table className="w-full text-[11.5px]">
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.type} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--ink)' }}>
                {r.type}
                {r.standard && (
                  <span className="block text-[10px] mt-0.5 fig" style={{ color: 'var(--accent)' }}>{r.standard}</span>
                )}
                {r.sellers != null && (
                  <span className="block text-[10px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    {r.sellers} sellers · {r.listings} listings
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-right fig whitespace-nowrap align-top" style={{ color: 'var(--ink)' }}>
                {r.median}
                {r.range && (
                  <span className="block text-[9.5px] mt-0.5 opacity-60" style={{ fontFamily: 'var(--font-ui)' }}>
                    {r.range}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!!block.honesty?.length && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--rule-soft)' }}>
          <button onClick={() => setOpenWhy((v) => !v)} className="text-[10.5px] anim hover:opacity-70"
            style={{ color: 'var(--ink-3)' }} aria-expanded={openWhy}>
            {openWhy ? 'Hide' : 'Why I did not rank these'} {openWhy ? '▾' : '▸'}
          </button>
          {openWhy && (
            <ul className="mt-1.5 space-y-1.5">
              {block.honesty.map((h: string, i: number) => (
                <li key={i} className="text-[10.5px] leading-[1.45]" style={{ color: 'var(--ink-2)' }}>{h}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function QualityBlock({ block }: { block: any }) {
  const [openWhy, setOpenWhy] = React.useState(false);
  return (
    <div className="glass-card mt-2.5 overflow-hidden" style={{ border: '1px solid var(--glass-hair)', borderRadius: 11 }}>
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rule-soft)' }}>
        <div className="text-[10px] uppercase tracking-[.08em]" style={{ color: 'var(--ink-3)' }}>
          {block.category} — ranked
        </div>
      </div>

      <table className="w-full text-[11.5px]">
        <tbody>
          {block.ranked.map((r: any, i: number) => (
            <tr key={r.product_id} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
              <td className="px-3 py-2" style={{ color: 'var(--ink-3)', width: 18 }}>{i + 1}</td>
              <td className="px-1 py-2" style={{ color: 'var(--ink)' }}>
                {r.title}
                <span className="block text-[10px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                  {r.declared_grade ?? 'grade not declared'} · {r.certification} · {r.vendors_carrying} sellers
                </span>
              </td>
              <td className="px-3 py-2 text-right fig whitespace-nowrap align-top" style={{ color: 'var(--ink)' }}>
                {r.price}
                <span className="block text-[9.5px] mt-0.5 opacity-60" style={{ fontFamily: 'var(--font-ui)' }}>
                  {r.price_rank}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {!!block.by_application?.length && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--rule-soft)' }}>
          <div className="text-[10px] uppercase tracking-[.08em] mb-1.5" style={{ color: 'var(--ink-3)' }}>
            Best for what you are pouring
          </div>
          {block.by_application.map((g: any, i: number) => (
            <div key={i} className="mb-1.5 last:mb-0">
              <div className="text-[11px]" style={{ color: 'var(--ink)' }}>
                {g.best.title} <span className="fig" style={{ color: 'var(--accent-ink)' }}>{g.best.price}</span>
              </div>
              <div className="text-[10px] leading-[1.45]" style={{ color: 'var(--ink-3)' }}>{g.why}</div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button" onClick={() => setOpenWhy((o) => !o)}
        className="anim w-full px-3 py-2 text-left text-[10.5px]"
        style={{ borderTop: '1px solid var(--rule-soft)', color: 'var(--ink-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        {openWhy ? '− hide how this was ranked' : '+ how this was ranked, and what it cannot tell you'}
      </button>

      {openWhy && (
        <div className="px-3 pb-3 pt-1" style={{ background: 'var(--wash)' }}>
          <div className="text-[10.5px] leading-[1.5] mb-2" style={{ color: 'var(--ink-2)' }}>{block.rubric}</div>
          {block.honesty.map((h: string, i: number) => (
            <div key={i} className="text-[10px] leading-[1.5] mb-1.5" style={{ color: 'var(--ageing)' }}>{h}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function EstimateBlock({ block }: { block: any }) {
  const [openWork, setOpenWork] = React.useState(false);
  const est = block.estimate;
  const priced: any[] | null = block.lines ?? null;

  return (
    <div
      className="glass-card mt-2.5 overflow-hidden"
      style={{ border: '1px solid var(--glass-hair)', borderRadius: 11 }}
    >
      <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--rule-soft)' }}>
        <div className="text-[11.5px]" style={{ color: 'var(--ink-2)' }}>{est.headline}</div>
      </div>

      <table className="w-full text-[11.5px]">
        <tbody>
          {(priced ?? est.lines).map((l: any, i: number) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--rule-soft)' }}>
              <td className="px-3 py-2 align-top" style={{ color: 'var(--ink)' }}>
                {l.material}
                {l.band && (
                  <span className="block text-[10px] mt-0.5" style={{ color: 'var(--ageing)' }}>
                    a band, not a figure — your bar schedule decides
                  </span>
                )}
                {!l.priced && priced && (
                  <span className="block text-[10px] mt-0.5" style={{ color: 'var(--ink-3)' }}>{l.reason}</span>
                )}
              </td>
              {/*
                A priced line and an unpriced line both carry `band`, and they
                are NOT the same shape: the estimator's is {low, high} numbers,
                the priced one is {low_total, high_total} already-formatted
                rupee strings. Reading .low off the priced shape rendered
                "NaN–NaN kg" for exactly the case bands exist for — steel.
              */}
              <td className="px-2 py-2 text-right fig whitespace-nowrap align-top" style={{ color: 'var(--ink)' }}>
                {!priced && l.band
                  ? `${Math.ceil(l.band.low)}–${Math.ceil(l.band.high)}`
                  : (l.buy_qty ?? l.qty)}
                <span className="opacity-55 ml-1" style={{ fontSize: '.85em' }}>{l.unit}</span>
              </td>
              {priced && (
                <td className="px-3 py-2 text-right fig whitespace-nowrap align-top"
                  style={{ color: l.priced ? 'var(--ink)' : 'var(--ink-3)' }}>
                  {!l.priced ? '—'
                    : l.band ? `${l.band.low_total}–${l.band.high_total}`
                    : l.line_total}
                </td>
              )}
            </tr>
          ))}
          {priced && block.subtotal && (
            <tr>
              <td className="px-3 py-2 text-[11px]" style={{ color: 'var(--ink-3)' }} colSpan={2}>
                subtotal, {block.lines_priced} of {block.lines_total} lines priced
              </td>
              <td className="px-3 py-2 text-right fig" style={{ color: 'var(--accent)' }}>
                {block.subtotal}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {!!est.assumptions?.length && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--rule-soft)' }}>
          {est.assumptions.map((a: any, i: number) => (
            <div key={i} className="text-[10.5px] leading-[1.45]" style={{ color: 'var(--ink-3)' }}>
              Assumed <span style={{ color: 'var(--ink-2)' }}>{a.value}</span> — {a.because}
            </div>
          ))}
        </div>
      )}

      {!!est.caveats?.length && (
        <div className="px-3 py-2" style={{ borderTop: '1px solid var(--rule-soft)' }}>
          {est.caveats.map((c: string, i: number) => (
            <div key={i} className="text-[10.5px] leading-[1.45]" style={{ color: 'var(--ageing)' }}>{c}</div>
          ))}
        </div>
      )}

      <button
        type="button" onClick={() => setOpenWork((o) => !o)}
        className="anim w-full px-3 py-2 text-left text-[10.5px]"
        style={{ borderTop: '1px solid var(--rule-soft)', color: 'var(--ink-3)', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        {openWork ? '− hide the working' : '+ show the working'}
      </button>

      {openWork && (
        <div className="px-3 pb-3" style={{ background: 'var(--wash)' }}>
          {est.steps.map((s: any, i: number) => (
            <div key={i} className="py-1" style={{ borderBottom: i < est.steps.length - 1 ? '1px solid var(--rule-soft)' : 'none' }}>
              <div className="text-[10px]" style={{ color: 'var(--ink-3)' }}>{s.label}</div>
              <div className="text-[10.5px] fig leading-[1.4]" style={{ color: 'var(--ink-2)' }}>
                {s.expression} = <span style={{ color: 'var(--ink)' }}>{s.result}</span>
              </div>
            </div>
          ))}
          <div className="mt-2 pt-2" style={{ borderTop: '1px solid var(--rule)' }}>
            <div className="text-[10px] uppercase tracking-[.08em] mb-1" style={{ color: 'var(--ink-3)' }}>Coefficients</div>
            {est.coefficients.map((c: any, i: number) => (
              <div key={i} className="text-[10px] leading-[1.5] mb-1" style={{ color: 'var(--ink-3)' }}>
                <span style={{ color: 'var(--ink-2)' }}>{c.label}</span>
                {' = '}
                <span className="fig">{c.value ?? `${c.low}–${c.high}`} {c.unit}</span>
                {' · '}
                <span className="prov" style={{ fontSize: 9 }}>{c.confidence}</span>
                {' '}{c.citation}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Sources({ sources }: { sources: Array<{ label: string; url: string; fetched_at?: string; confidence?: string }> }) {
  const [open, setOpen] = React.useState(false);
  const uniq = sources.slice(0, 8);
  return (
    <div className="mt-2">
      <button
        type="button" onClick={() => setOpen((o) => !o)}
        className="anim text-[10px]"
        style={{ color: 'var(--ink-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        {open ? '− sources' : `+ ${uniq.length} source${uniq.length === 1 ? '' : 's'}`}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-1">
          {uniq.map((s, i) => (
            <a
              key={i} href={s.url} target="_blank" rel="noopener noreferrer"
              className="anim text-[10.5px] leading-[1.4] truncate hover:opacity-70"
              style={{ color: 'var(--accent-ink)' }}
              title={s.url}
            >
              {i + 1}. {s.label}
              {s.confidence && <span className="ml-1" style={{ color: 'var(--ink-3)' }}>· {s.confidence.toLowerCase()}</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Trace({ trace }: { trace: any }) {
  return (
    <div
      className="mt-2 px-2.5 py-2 text-[10px] leading-[1.5] fig"
      style={{ background: 'var(--wash)', border: '1px solid var(--rule-soft)', borderRadius: 8, color: 'var(--ink-3)' }}
    >
      <div>scope {trace.scope} · rounds {trace.rounds} · repaired {String(trace.repaired)}</div>
      <div>ledger {trace.ledger.numbers}n / {trace.ledger.entities}e / {trace.ledger.sources}s</div>
      <div>model {Math.round(trace.model_ms)} ms · total {Math.round(trace.total_ms)} ms
        {trace.tokens && ` · ${trace.tokens.prompt}+${trace.tokens.output} tok`}</div>
      {trace.tool_calls.map((c: any, i: number) => (
        <div key={i}>{c.ok ? '✓' : '✗'} {c.name} {Math.round(c.ms)} ms</div>
      ))}
      {!!trace.violations?.length && (
        <div style={{ color: 'var(--ageing)' }}>
          {trace.violations.length} violation{trace.violations.length === 1 ? '' : 's'}:
          {' '}{trace.violations.map((v: any) => v.token).join(', ')}
        </div>
      )}
    </div>
  );
}

function Pulse() {
  return (
    <span className="inline-flex gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 4, height: 4, borderRadius: '50%', background: 'var(--accent)',
            animation: `pulse-dot 1.1s ${i * 0.14}s ease-in-out infinite`,
          }}
        />
      ))}
      <style>{`@keyframes pulse-dot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}`}</style>
    </span>
  );
}

function BotIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="2.5" y="5" width="11" height="8" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5V2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="2" r="1.1" fill="currentColor" />
      <circle cx="6" cy="9" r=".9" fill="currentColor" />
      <circle cx="10" cy="9" r=".9" fill="currentColor" />
    </svg>
  );
}
