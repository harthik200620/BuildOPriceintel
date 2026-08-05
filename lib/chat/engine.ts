/**
 * The turn loop.
 *
 * Scope gate → tool loop → grounding validation → one silent repair → answer,
 * and a refusal at any point that fails. The ordering is the design: the
 * cheapest guard runs first, and nothing reaches the user that has not been
 * held against the facts the tools produced.
 *
 * The repair pass is worth its latency. Flash's grounding failures are
 * overwhelmingly one bad token in an otherwise correct answer — a rounded
 * price, a brand carried over from the previous turn — and handing it its own
 * violation list fixes most of them in one round. What survives two rounds is
 * not a formatting slip, and that turn degrades to an honest refusal.
 */

import { generate as defaultGenerate, hasKey, GeminiKeyMissing, type GeminiContent, type GenerateArgs, type GenerateResult } from './gemini';
import { SYSTEM_PROMPT, TOOL_SCHEMAS, WELCOME } from './prompt';
import { callTool, type ToolContext } from './tools';
import { FactLedger } from './ledger';
import { checkScope, validateAll, trimProse, type Violation } from './validator';
import { cacheGet, cacheSet } from './cache';
import { resolvePincode } from '../price';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface EngineInput {
  message: string;
  history: ChatMessage[];
  pincode: string;
}

export interface EngineTrace {
  scope: 'allowed' | 'blocked';
  tool_calls: Array<{ name: string; args: unknown; ok: boolean; ms: number }>;
  rounds: number;
  repaired: boolean;
  /** The draft was grounded but long, and was cut locally rather than re-asked. */
  trimmed?: boolean;
  violations: Violation[];
  ledger: { numbers: number; entities: number; sources: number };
  model_ms: number;
  total_ms: number;
  tokens: { prompt: number; output: number; thoughts: number; cached: number } | null;
  /** True when this whole turn came back from the answer cache and cost nothing. */
  cached?: boolean;
}

export interface EngineResult {
  reply: string;
  /** Structured payloads the panel renders: cards, tables, option chips. */
  ui: unknown[];
  sources: Array<{ label: string; url: string; fetched_at?: string; confidence?: string }>;
  /** Quick replies for the next turn — from the tools, not invented. */
  suggestions: string[];
  refused: boolean;
  trace: EngineTrace;
}

const MAX_TOOL_ROUNDS = 4;
const MAX_HISTORY_TURNS = 8;

/** A turn that ends here never reaches the model. */
function refusal(text: string, trace: Partial<EngineTrace>, t0: number): EngineResult {
  return {
    reply: text, ui: [], sources: [], suggestions: WELCOME.chips.slice(0, 3).map((c) => c.prompt),
    refused: true,
    trace: {
      scope: 'blocked', tool_calls: [], rounds: 0, repaired: false, violations: [],
      ledger: { numbers: 0, entities: 0, sources: 0 }, model_ms: 0, total_ms: Date.now() - t0,
      tokens: null, ...trace,
    },
  };
}

/**
 * The model, injectable.
 *
 * The one component here whose output cannot be asserted is the model, which
 * makes it the one that has to be substitutable — the guard rails are only
 * worth testing against a model that misbehaves on purpose, and a real key
 * returns a well-behaved answer that proves nothing. Production passes
 * nothing and gets Gemini.
 */
export interface EngineDeps {
  generate?: (a: GenerateArgs) => Promise<GenerateResult>;
  hasKey?: () => boolean;
}

export async function runTurn(input: EngineInput, deps: EngineDeps = {}): Promise<EngineResult> {
  const generate = deps.generate ?? defaultGenerate;
  const keyPresent = deps.hasKey ?? hasKey;
  const t0 = Date.now();

  // ── 0. pincode → region. A price with no region is not a price. ──
  const dest = resolvePincode(input.pincode);
  if (!dest) {
    return refusal(
      `I do not have supply data for ${input.pincode}. This covers Hyderabad (500001–500100) and Vijayawada (520001–521456) — give me a pincode in one of those.`,
      { scope: 'blocked' }, t0,
    );
  }
  const ctx: ToolContext = { pincode: input.pincode, region_id: dest.region_id };

  // ── 1. scope gate, before any token is spent ──
  const scope = checkScope(input.message);
  if (!scope.allow) return refusal(scope.reply, { scope: 'blocked' }, t0);

  // ── 1b. the answer cache, after the gates and before the key check ──
  // After the gates because a cached answer to a blocked question would be a
  // way around them. Before the key check because a hit needs no model at all.
  // Keyed on SQLite's data_version, so a collection run invalidates everything
  // the moment it commits — there is no window where a stale price is served.
  const hit = cacheGet(input.message, input.pincode, input.history.length);
  if (hit) return { ...hit, trace: { ...hit.trace, total_ms: Date.now() - t0 } };

  if (!keyPresent()) throw new GeminiKeyMissing();

  // ── 2. tool loop ──
  const contents: GeminiContent[] = [];
  for (const m of input.history.slice(-MAX_HISTORY_TURNS * 2)) {
    contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] });
  }
  contents.push({ role: 'user', parts: [{ text: input.message }] });

  const ledger = new FactLedger();
  const ui: unknown[] = [];
  const toolTrace: EngineTrace['tool_calls'] = [];
  let modelMs = 0;
  let tokens: EngineTrace['tokens'] = null;
  let rounds = 0;
  let draft = '';

  for (; rounds < MAX_TOOL_ROUNDS; rounds++) {
    const r = await generate({
      system: SYSTEM_PROMPT,
      contents,
      tools: TOOL_SCHEMAS,
      toolMode: 'AUTO',
      // A little thinking helps pick between search_products and price_estimate;
      // none at all made it reach for search on quantity questions.
      thinkingBudget: rounds === 0 ? 512 : 0,
      maxOutputTokens: 1400,
    });
    modelMs += r.latency_ms;
    if (r.usage) tokens = r.usage;

    if (!r.ok) {
      const msg = r.error?.code === 'SAFETY_BLOCK'
        ? 'I cannot answer that one. Ask me about material prices or quantities.'
        : `The assistant is having trouble reaching its model right now (${r.error?.code ?? 'unknown'}). Try again in a moment.`;
      return refusal(msg, { scope: 'allowed', rounds, tool_calls: toolTrace, model_ms: modelMs }, t0);
    }

    if (!r.calls.length) { draft = r.text; break; }

    // Execute every requested call, then hand all results back at once.
    contents.push({ role: 'model', parts: r.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) });
    const responseParts = r.calls.map((c) => {
      const ts = Date.now();
      const out = callTool(c.name, c.args, ctx);
      toolTrace.push({ name: c.name, args: c.args, ok: out.ok, ms: Date.now() - ts });
      ledger.merge(out.ledger);
      if (out.ui) ui.push(out.ui);
      return { functionResponse: { name: c.name, response: { result: out.data } } };
    });
    contents.push({ role: 'user', parts: responseParts });
  }

  if (!draft) {
    return refusal(
      'I could not work that out. Try asking for one material at a time — a price, or a quantity for a specific job.',
      { scope: 'allowed', rounds, tool_calls: toolTrace, model_ms: modelMs }, t0,
    );
  }

  // ── 3. grounding ──
  const userText = [input.message, ...input.history.filter((m) => m.role === 'user').map((m) => m.content)].join('\n');
  const toolless = toolTrace.length === 0;

  let verdict = validateAll({ draft, ledger, userText, toolless });
  let repaired = false;
  let trimmed = false;

  // Grounded, just long. Cut it here — free, instant, and it cannot introduce a
  // claim the model might. The violation stays on the trace so the trim rate is
  // still visible.
  if (!verdict.pass && verdict.trimmable) {
    draft = trimProse(draft);
    trimmed = true;
    verdict = { ...verdict, pass: true, repairInstruction: null };
  }

  /** The tools found facts; the prose did not survive. Hand over the cards. */
  const giveUp = (violations: Violation[]): EngineResult => ({
    reply: honestFallback(ledger, toolTrace),
    ui, sources: ledger.sources, suggestions: suggestionsFrom(ui),
    refused: true,
    trace: {
      scope: 'allowed', tool_calls: toolTrace, rounds, repaired: true, trimmed,
      violations, ledger: ledger.size, model_ms: modelMs,
      total_ms: Date.now() - t0, tokens,
    },
  });

  if (!verdict.pass) {
    // One silent repair. The model sees its own violations and nothing else new.
    contents.push({ role: 'model', parts: [{ text: draft }] });
    contents.push({ role: 'user', parts: [{ text: verdict.repairInstruction! }] });

    // No `tools` on this call. It carried the full TOOL_SCHEMAS alongside
    // toolMode:'NONE' — roughly 1,400 tokens of function declarations the model
    // was forbidden from calling, paid on every repaired turn.
    const r2 = await generate({
      system: SYSTEM_PROMPT, contents, toolMode: 'NONE',
      thinkingBudget: 0, maxOutputTokens: 900, temperature: 0.1,
    });
    modelMs += r2.latency_ms;
    if (r2.usage) tokens = r2.usage;

    // The repair call itself failed — network, safety block, truncation. This
    // used to fall straight through and return `draft`: the ungrounded text
    // this entire path exists to stop, shipped with refused:false and then
    // written to the answer cache for every later asker.
    if (!r2.ok || !r2.text) return giveUp(verdict.violations);

    const v2 = validateAll({ draft: r2.text, ledger, userText, toolless });
    repaired = true;
    // Failed twice. Say what is actually known instead of guessing again.
    if (!v2.pass) return giveUp(v2.violations);
    draft = r2.text; verdict = v2;
  }

  const result: EngineResult = {
    reply: draft, ui, sources: ledger.sources, suggestions: suggestionsFrom(ui),
    refused: false,
    trace: {
      scope: 'allowed', tool_calls: toolTrace, rounds, repaired, trimmed,
      violations: verdict.violations, ledger: ledger.size, model_ms: modelMs,
      total_ms: Date.now() - t0, tokens, cached: false,
    },
  };
  cacheSet(input.message, input.pincode, input.history.length, result);
  return result;
}

/**
 * What to say when the model could not be made to stay grounded.
 *
 * Not an apology and not a blank — the tools DID return facts, so the turn
 * hands those over directly and drops the prose that failed. The user gets the
 * cards; only the sentence around them is lost.
 */
function honestFallback(ledger: FactLedger, calls: EngineTrace['tool_calls']): string {
  if (!calls.length) {
    return 'I do not have that. I cover cement, TMT steel, water pipes, and bricks and blocks in Hyderabad and Vijayawada.';
  }
  if (ledger.isEmpty) {
    return 'Nothing in the catalogue matched that. Try naming the material — cement, TMT steel, pipe, or brick.';
  }
  return 'Straight from the catalogue below — I could not write a summary I trusted.';
}

/** Follow-ups drawn from what the tools actually returned. */
function suggestionsFrom(ui: unknown[]): string[] {
  const out: string[] = [];
  for (const u of ui as Array<{ kind?: string }>) {
    if (u?.kind === 'products') out.push('Who else sells it?', 'Show me the cheapest');
    if (u?.kind === 'estimate') out.push('What will that cost?');
    if (u?.kind === 'priced_estimate') out.push('Can I get it cheaper?', 'Who delivers fastest?');
    if (u?.kind === 'quality_ranking') out.push('What does that one cost?', 'Rank by price instead');
  }
  return [...new Set(out)].slice(0, 3);
}

export { WELCOME };
