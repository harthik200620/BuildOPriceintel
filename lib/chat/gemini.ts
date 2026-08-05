/**
 * Gemini 2.5 Flash, over raw HTTP.
 *
 * No SDK: the surface used here is four fields wide, and a dependency that
 * wraps it would need updating on its own schedule while adding nothing this
 * file does not already do. The failure modes it handles — 429 with a
 * Retry-After, 503 on a cold model, a MAX_TOKENS finish that truncates a tool
 * call, a safety block with no candidate at all — are the ones that decide
 * whether the assistant is reliable, and each is handled explicitly rather
 * than surfacing as `undefined is not an object`.
 */

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface GenerateArgs {
  system: string;
  contents: GeminiContent[];
  tools?: FunctionDeclaration[];
  /** AUTO lets the model answer directly; ANY forces a tool call. */
  toolMode?: 'AUTO' | 'ANY' | 'NONE';
  temperature?: number;
  maxOutputTokens?: number;
  /** 0 disables thinking. Tool selection is better with a little; prose needs none. */
  thinkingBudget?: number;
  signal?: AbortSignal;
}

export interface GenerateResult {
  ok: boolean;
  text: string;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  finishReason: string | null;
  /** Set when the model produced nothing usable, with why. */
  error: { code: string; message: string; retryable: boolean } | null;
  usage: { prompt: number; output: number; thoughts: number; cached: number } | null;
  latency_ms: number;
}

export class GeminiKeyMissing extends Error {
  constructor() {
    super(
      'GEMINI_API_KEY is not set. Add it to .env.local as GEMINI_API_KEY=... and restart the dev server.',
    );
    this.name = 'GeminiKeyMissing';
  }
}

export function hasKey(): boolean {
  return !!(process.env.GEMINI_API_KEY ?? '').trim();
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

export async function generate(a: GenerateArgs): Promise<GenerateResult> {
  const key = (process.env.GEMINI_API_KEY ?? '').trim();
  if (!key) throw new GeminiKeyMissing();

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: a.system }] },
    contents: a.contents,
    generationConfig: {
      temperature: a.temperature ?? 0.2,
      maxOutputTokens: a.maxOutputTokens ?? 1200,
      topP: 0.9,
      // 2.5-series knob. 0 = off. Kept low: this assistant's hard problems are
      // in the tools and the validator, not in the model's deliberation, and
      // every thinking token is latency the user waits through.
      thinkingConfig: { thinkingBudget: a.thinkingBudget ?? 0 },
    },
    // The defaults block some construction vocabulary as "dangerous" —
    // demolition, blasting agents in a quarry context. BLOCK_ONLY_HIGH keeps
    // the genuine refusals (which UNSAFE_PATTERNS in validator.ts catches
    // first anyway) without dropping a legitimate question about aggregate.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  if (a.tools?.length) {
    body.tools = [{ functionDeclarations: a.tools }];
    body.toolConfig = { functionCallingConfig: { mode: a.toolMode ?? 'AUTO' } };
  }

  const url = `${ENDPOINT}/${GEMINI_MODEL}:generateContent`;
  const t0 = Date.now();
  let lastErr: GenerateResult['error'] = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: a.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        return { ok: false, text: '', calls: [], finishReason: null, usage: null, latency_ms: Date.now() - t0,
          error: { code: 'ABORTED', message: 'Request cancelled.', retryable: false } };
      }
      lastErr = { code: 'NETWORK', message: String(e?.message ?? e), retryable: true };
      if (attempt < MAX_ATTEMPTS) { await sleep(backoff(attempt)); continue; }
      break;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const retryable = RETRYABLE_STATUS.has(res.status);
      lastErr = {
        code: `HTTP_${res.status}`,
        message: res.status === 400 && /API key/i.test(detail)
          ? 'The Gemini API key was rejected. Check GEMINI_API_KEY in .env.local.'
          : summarise(detail) || res.statusText,
        retryable,
      };
      if (retryable && attempt < MAX_ATTEMPTS) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      break;
    }

    const json: any = await res.json().catch(() => null);
    if (!json) { lastErr = { code: 'BAD_JSON', message: 'The model returned a body that is not JSON.', retryable: true }; continue; }

    // Prompt-level block: no candidates at all.
    if (json.promptFeedback?.blockReason) {
      return {
        ok: false, text: '', calls: [], finishReason: 'BLOCKED', usage: usageOf(json), latency_ms: Date.now() - t0,
        error: { code: 'SAFETY_BLOCK', message: `The model declined this input (${json.promptFeedback.blockReason}).`, retryable: false },
      };
    }

    const cand = json.candidates?.[0];
    if (!cand) { lastErr = { code: 'NO_CANDIDATE', message: 'The model returned no candidate.', retryable: true }; continue; }

    const parts: GeminiPart[] = cand.content?.parts ?? [];
    const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
    const calls = parts.filter((p) => p.functionCall).map((p) => ({
      name: p.functionCall!.name,
      args: (p.functionCall!.args ?? {}) as Record<string, unknown>,
    }));
    const finishReason = cand.finishReason ?? null;

    // A MAX_TOKENS finish mid-tool-call yields a malformed call. Better to
    // report it than to execute half an argument object.
    if (finishReason === 'MAX_TOKENS' && !text && !calls.length) {
      return {
        ok: false, text: '', calls: [], finishReason, usage: usageOf(json), latency_ms: Date.now() - t0,
        error: { code: 'TRUNCATED', message: 'The model hit its output limit before producing anything.', retryable: false },
      };
    }

    return { ok: true, text, calls, finishReason, error: null, usage: usageOf(json), latency_ms: Date.now() - t0 };
  }

  return { ok: false, text: '', calls: [], finishReason: null, usage: null, latency_ms: Date.now() - t0, error: lastErr };
}

/**
 * `cached` is the field this used to drop, and it is the only one that says
 * whether the saving is real.
 *
 * The system prompt plus the tool declarations run ~1,800–2,200 tokens and are
 * byte-identical on every call, which clears the 1,024-token minimum for
 * implicit context caching on 2.5 Flash — so a hit should discount most of that
 * prefix. Should. `cachedContentTokenCount` is the API stating whether it
 * actually did, and reading every counter except that one left the optimisation
 * a hope rather than a measurement.
 *
 * The corollary is a rule for anyone editing prompt.ts: implicit caching keys on
 * an EXACT prefix match, so interpolating anything per-turn into SYSTEM_PROMPT
 * switches it off silently, and this counter is the only thing that would say so.
 */
function usageOf(json: any) {
  const u = json?.usageMetadata;
  if (!u) return null;
  return {
    prompt: u.promptTokenCount ?? 0,
    output: u.candidatesTokenCount ?? 0,
    thoughts: u.thoughtsTokenCount ?? 0,
    cached: u.cachedContentTokenCount ?? 0,
  };
}

function summarise(detail: string): string {
  try {
    const j = JSON.parse(detail);
    return j?.error?.message ?? detail.slice(0, 200);
  } catch { return detail.slice(0, 200); }
}

/** Exponential with jitter — a synchronised retry storm is its own outage. */
function backoff(attempt: number): number {
  return Math.round((2 ** attempt) * 250 * (0.75 + Math.random() * 0.5));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
