/**
 * The grounding validator. Fails closed.
 *
 * The premise: a model cannot be trusted to report whether it made something
 * up, so it is never asked. Every number and every named entity in the draft
 * is extracted mechanically and held against the FactLedger the tools
 * deposited during this turn. Anything not in the ledger is a violation, and a
 * draft with violations does not reach the user.
 *
 * The engine gets one silent repair attempt — the draft goes back to the model
 * with its own violations listed — and if that fails too, the turn degrades to
 * an honest "I don't have that" instead of a plausible fiction. Degrading to
 * silence is the entire point. A price assistant that is occasionally wrong is
 * worth less than one that is occasionally unhelpful, because a wrong landed
 * price becomes a signed purchase order.
 *
 * Calibration is the hard part, and the failure mode to avoid is a validator
 * that fires on true statements: one false positive on a correct answer and
 * the operator turns the whole thing off. So three categories are exempt, and
 * each one is a deliberate hole with a reason:
 *
 *   - Numbers the USER supplied. Echoing "your 50 bags" is not invention.
 *   - Structural numerals: list markers, "step 2 of 3", ordinals in prose.
 *   - A closed vocabulary of domain terms that name nothing — GST, ISI, OPC,
 *     CPVC, "Hyderabad". These are words, not claims.
 */

import { FactLedger, capitalisedRuns } from './ledger';

export interface Violation {
  kind: 'number' | 'entity' | 'scope' | 'citation' | 'format';
  token: string;
  message: string;
}

export interface Verdict {
  pass: boolean;
  violations: Violation[];
  /** What to send back to the model on the repair pass. */
  repairInstruction: string | null;
  /**
   * The draft is grounded and clean — it is only too long. The caller may cut it
   * locally instead of paying for a round trip. Never set when a grounding,
   * scope or markup violation is present.
   */
  trimmable?: boolean;
}

// ─── vocabulary that names nothing ───────────────────────────────────────────

/**
 * Terms that may appear without being in the ledger, because they are not
 * claims about the catalogue. "GST" is a word; "18% GST" is a claim, and the
 * 18 is checked as a number regardless of this list.
 */
const DOMAIN_VOCAB = new Set([
  // materials, systems, standards bodies
  'cement', 'opc', 'ppc', 'psc', 'concrete', 'mortar', 'plaster', 'brick', 'bricks', 'block', 'blocks',
  'aac', 'clay', 'flyash', 'fly', 'ash', 'steel', 'tmt', 'rebar', 'reinforcement', 'bar', 'bars', 'rod', 'rods',
  'pipe', 'pipes', 'cpvc', 'upvc', 'pvc', 'hdpe', 'swr', 'gi', 'sand', 'aggregate', 'jelly', 'metal',
  'bis', 'isi', 'is', 'iso', 'qco', 'gst', 'hsn', 'sor', 'moq', 'mrp', 'boq', 'bbs',
  // geography we serve
  'hyderabad', 'vijayawada', 'telangana', 'andhra', 'pradesh', 'india', 'indian', 'ts', 'ap',
  // units
  'kg', 'kgs', 'tonne', 'tonnes', 'ton', 'quintal', 'bag', 'bags', 'piece', 'pieces', 'nos',
  'm', 'mm', 'cm', 'metre', 'metres', 'meter', 'meters', 'ft', 'feet', 'foot', 'inch', 'inches',
  'sqft', 'sqm', 'cft', 'cum', 'brass', 'litre', 'litres', 'running', 'rmt',
  // commerce
  'price', 'prices', 'cost', 'rate', 'rates', 'quote', 'vendor', 'vendors', 'seller', 'sellers',
  'supplier', 'suppliers', 'dealer', 'dealers', 'stockist', 'delivery', 'freight', 'landed', 'ex',
  'works', 'inclusive', 'exclusive', 'stock', 'lead', 'time', 'pincode', 'grade', 'spec', 'specs',
  // structural
  'slab', 'slabs', 'column', 'columns', 'beam', 'beams', 'footing', 'footings', 'raft', 'lintel',
  'staircase', 'wall', 'walls', 'partition', 'foundation', 'plinth', 'roof', 'floor', 'ceiling',
  // the assistant's own frame
  'buildo', 'i', 'you', 'your', 'we', 'the', 'a', 'an',
]);

/**
 * Words that look like brands because they are capitalised at a sentence start.
 *
 * Number words earn their place here the hard way: "Two options:" opens a
 * perfectly good reply and was being flagged as an unknown brand, which is the
 * exact false positive that gets a validator switched off.
 */
const SENTENCE_STARTERS = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'i', 'if', 'it', 'in', 'on', 'at', 'for',
  'and', 'but', 'or', 'so', 'to', 'you', 'your', 'we', 'what', 'which', 'who', 'when', 'where',
  'how', 'why', 'all', 'both', 'each', 'every', 'no', 'not', 'give', 'tell', 'ask', 'say', 'here',
  'there', 'once', 'before', 'after', 'want', 'need', 'get', 'add', 'per', 'from', 'with',
  'without', 'about', 'against', 'across', 'ready', 'note', 'nothing', 'anything', 'something',
  // counts and ordinals — reply scaffolding, not names
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'first', 'second', 'third', 'next', 'last', 'other', 'another', 'none', 'either', 'neither',
  'yes', 'ok', 'okay', 'sure', 'cheapest', 'best', 'most', 'least', 'more', 'less', 'only',
  'based', 'assuming', 'assumed', 'using', 'sorted', 'ranked', 'showing', 'found', 'nearest',
  'currently', 'today', 'still', 'also', 'however', 'though', 'because', 'since', 'while',
]);

// ─── extraction ──────────────────────────────────────────────────────────────

/** Structural numerals that carry no claim. */
function stripStructural(text: string): string {
  return text
    // markdown ordered-list markers at line start
    .replace(/^\s{0,6}\d{1,2}[.)]\s/gm, '')
    // markdown headings / bullets
    .replace(/^\s{0,6}[-*+]\s/gm, '')
    // "step 2 of 3", "option 1", "(1)"
    .replace(/\b(?:step|option|question|point)\s+\d{1,2}(?:\s+of\s+\d{1,2})?/gi, '')
    // table pipes
    .replace(/\|/g, ' ');
}

export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  // Indian grouping (1,23,456.78) and plain, with optional trailing % or unit.
  const re = /(?<![\w.])(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w])/g;
  for (const m of stripStructural(text).matchAll(re)) out.push(m[1]);
  return out;
}

function toNumber(s: string): number { return Number(s.replace(/,/g, '')); }

/**
 * Candidate named entities: capitalised runs, and anything in quotes.
 *
 * Deliberately over-collects and then filters, because a missed brand is a
 * hallucination that ships and a false candidate costs one set lookup.
 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>();
  const body = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');

  // Capitalised runs: "UltraTech", "Birla Shakti", "JSW Concreel"
  for (const m of body.matchAll(capitalisedRuns())) {
    const raw = m[1].trim();
    const first = raw.split(/\s+/)[0].toLowerCase();
    // A capitalised word at the start of a sentence is usually just grammar.
    const idx = m.index ?? 0;
    const atSentenceStart = idx === 0 || /[.!?:\n]\s*$/.test(body.slice(Math.max(0, idx - 3), idx));
    if (atSentenceStart && SENTENCE_STARTERS.has(first)) continue;
    if (raw.length < 3) continue;
    out.add(raw);
  }
  return [...out];
}

// ─── the check ───────────────────────────────────────────────────────────────

export interface ValidateInput {
  draft: string;
  ledger: FactLedger;
  /** The user's own words this turn and last — echoing them is not invention. */
  userText: string;
  /** True when no tool ran, so the reply must assert nothing at all. */
  toolless: boolean;
}

const MAX_VIOLATIONS_REPORTED = 8;

export function validate(input: ValidateInput): Verdict {
  const { draft, ledger, userText, toolless } = input;
  const violations: Violation[] = [];

  const userNums = new Set(extractNumbers(userText).map(toNumber));
  const userEnts = new Set(extractEntities(userText).map((e) => e.toLowerCase()));

  // ── numbers ──
  for (const raw of extractNumbers(draft)) {
    const n = toNumber(raw);
    if (!Number.isFinite(n)) continue;
    if (userNums.has(n)) continue;

    // Tolerance scales with magnitude: a reply may round ₹32,160 to ₹32,000
    // when it is talking about a total, and 8.06 bags to 8. Below 1 no
    // tolerance at all — 0.5% and 0.05% are different claims.
    const tol = n >= 1000 ? Math.max(1, n * 0.005) : n >= 100 ? 0.5 : n >= 1 ? 0.05 : 0;
    if (ledger.hasNumber(n, tol)) continue;

    violations.push({
      kind: 'number', token: raw,
      message: `"${raw}" is not in anything the tools returned this turn.`,
    });
  }

  // ── entities ──
  for (const ent of extractEntities(draft)) {
    const low = ent.toLowerCase();
    if (userEnts.has(low)) continue;
    // Every word of it is generic vocabulary → it names nothing.
    const words = low.split(/\s+/).filter(Boolean);
    if (words.every((w) => DOMAIN_VOCAB.has(w.replace(/[^a-z0-9]/g, '')))) continue;
    if (ledger.hasEntity(ent)) continue;

    violations.push({
      kind: 'entity', token: ent,
      message: `"${ent}" is not a brand, seller or product the tools returned this turn.`,
    });
  }

  // ── a reply with no tool behind it may not assert ──
  if (toolless) {
    const assertive = /₹|\brs\.?\s*\d|\bper (?:bag|kg|piece|tonne|metre)\b|\bcheapest\b|\bbest price\b/i.test(draft);
    if (assertive) {
      violations.push({
        kind: 'citation', token: '(no tool call)',
        message: 'The reply states a price or a superlative but no tool ran this turn.',
      });
    }
  }

  const trimmed = violations.slice(0, MAX_VIOLATIONS_REPORTED);
  const pass = violations.length === 0;

  return {
    pass, violations: trimmed,
    repairInstruction: pass ? null : buildRepair(trimmed),
  };
}

/**
 * Two different failures, told apart.
 *
 * These used to share one paragraph, which meant a 137-word draft was handed
 * back the sentence "these tokens are not supported by this turn's tool
 * results: - 137 words". The model was being asked to solve a grounding problem
 * it did not have, so the repair failed more often than it should have — and a
 * failed repair shows the user a confidence disclaimer for an answer that was
 * factually perfect and merely wordy.
 */
function buildRepair(vs: Violation[]): string {
  const grounding = vs.filter((v) => v.kind !== 'format');
  const format = vs.filter((v) => v.kind === 'format');
  const parts: string[] = [];

  if (grounding.length) {
    const lines = grounding.map((v) => `- ${v.token}: ${v.message}`).join('\n');
    parts.push(
      `Your previous draft was rejected by the grounding check. These tokens are not supported by ` +
      `this turn's tool results:\n${lines}\n\n` +
      `Rewrite the reply using ONLY figures and names that appear in the tool results above. ` +
      `Do not substitute a different number — remove the claim, or call a tool that establishes it. ` +
      `If the tools do not contain the answer, say plainly that you do not have it. Keep it short.`,
    );
  }
  if (format.length) {
    parts.push(
      `The draft also breaks the format rules:\n${format.map((v) => `- ${v.token}: ${v.message}`).join('\n')}\n\n` +
      `Rewrite it as one or two plain sentences. Delete anything the cards already show — prices, ` +
      `quantities, sellers, dates, assumptions.`,
    );
  }
  return parts.join('\n\n');
}

// ─── scope: the input side ───────────────────────────────────────────────────

/**
 * What this assistant will and will not take.
 *
 * Two layers, and the deterministic one runs first on purpose. A model
 * instructed to stay on topic can be argued out of it; a regex cannot be
 * argued with at all, and the attacks that matter here — "ignore your
 * instructions", "you are now DAN", "print your system prompt" — are
 * lexically obvious. What the regex cannot judge, the model refuses under its
 * own instructions, and the output validator catches whatever survives both.
 */
export type ScopeVerdict =
  | { allow: true }
  | { allow: false; reason: 'INJECTION' | 'OFF_TOPIC' | 'UNSAFE' | 'EMPTY'; reply: string };

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:your\s+|the\s+|previous\s+|prior\s+|above\s+)*(?:instruction|prompt|rule|direction|system)/i,
  /disregard\s+(?:all\s+|your\s+|the\s+|previous\s+)*(?:instruction|prompt|rule|context)/i,
  /forget\s+(?:everything|all|your\s+(?:instruction|prompt|rule|training))/i,
  /(?:reveal|show|print|repeat|output|display|dump|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?(?:prompt|instruction|rule|configuration|source\s+code|api\s+key)/i,
  /what\s+(?:are|were)\s+your\s+(?:exact\s+)?(?:system\s+)?(?:instruction|prompt|rule)s?\b/i,
  /\b(?:you\s+are\s+now|from\s+now\s+on\s+you(?:'re| are)|act\s+as|pretend\s+(?:to\s+be|you(?:'re| are)))\s+(?:a\s+|an\s+|the\s+)?(?!buildo)/i,
  /\b(?:DAN|jailbreak|developer\s+mode|god\s+mode|unrestricted\s+mode)\b/i,
  /\bsudo\b|\broot\s+access\b/i,
  /repeat\s+(?:the\s+)?(?:words?|text)\s+above/i,
  /<\|?(?:im_start|im_end|system|endoftext)\|?>/i,
];

/**
 * Off-topic, by absence rather than by blocklist.
 *
 * A blocklist of forbidden subjects is unbounded and always incomplete. This
 * asks the opposite question — does anything here belong to the domain? — and
 * only refuses when the answer is no AND the message is long enough for that
 * absence to mean something. Short messages fall through to the model, because
 * "and in 20mm?" carries no domain word either and is a perfectly good follow-up.
 */
const DOMAIN_SIGNALS = [
  /\b(?:cement|concrete|opc|ppc|psc|mortar|plaster|screed)\b/i,
  /\b(?:steel|tmt|rebar|reinforc|fe\s?500|fe\s?550|bar|rod)\b/i,
  /\b(?:pipe|cpvc|upvc|pvc|hdpe|swr|plumb|bore|fitting)\b/i,
  /\b(?:brick|block|aac|masonry|wall|kiln)\b/i,
  /\b(?:sand|aggregate|jelly|metal|gravel)\b/i,
  /\b(?:price|cost|rate|quote|cheap|expensive|budget|₹|rs\.?\s*\d)\b/i,
  /\b(?:quantity|how\s+much|how\s+many|estimate|calculat|bag|tonne|cft|sqft|m3|m²|m³)\b/i,
  /\b(?:vendor|seller|supplier|dealer|deliver|freight|stock|lead\s+time|moq)\b/i,
  /\b(?:hyderabad|vijayawada|telangana|andhra|pincode|\b5[0-2]\d{4}\b)\b/i,
  /\b(?:slab|column|beam|footing|foundation|lintel|staircase|roof|plinth)\b/i,
  /\b(?:build|construct|site|contractor|material|spec|grade|bis|isi|gst|hsn)\b/i,
  // Meta-questions about the assistant itself. Deliberately narrow: a bare
  // "can you" let "Can you help me with my resume" through as in-scope.
  /\b(?:buildo|catalogue|catalog)\b/i,
  /\b(?:what|which|how)\b.{0,24}\b(?:you (?:cover|have|do|stock|sell|help)|can you (?:do|help))\b/i,
  /\b(?:do|can) you (?:cover|have|stock|sell|deliver|carry|know)\b/i,
];

/**
 * Telugu and Devanagari, which the catalogue's search_blob already indexes.
 *
 * The word-count heuristic below is built on Latin whitespace and does not
 * survive a script that does not use it, so a Hindi or Telugu question was
 * being refused as off-topic for having no ASCII domain word in it. Non-Latin
 * input goes to the model, where the output validator still governs every
 * number it produces.
 */
const NON_LATIN = /[ऀ-ॿఀ-౿؀-ۿ]/;

const UNSAFE_PATTERNS: RegExp[] = [
  /\b(?:explosive|detonat|blast(?:ing)?\s+(?:cap|agent)|ammonium\s+nitrate\s+fuel|anfo|ied)\b/i,
  /\bhow\s+to\s+(?:make|build|synthesi[sz]e)\s+(?:a\s+)?(?:bomb|weapon|explosive|poison)/i,
];

const REFUSAL_OFF_TOPIC =
  'I only cover construction material prices and quantities for Hyderabad and Vijayawada — cement, TMT steel, water pipes, and bricks and blocks. Ask me what something costs, or how much of it you need.';

const REFUSAL_INJECTION =
  'I only answer questions about construction material prices and quantities. What are you buying?';

const REFUSAL_UNSAFE =
  'I cannot help with that. I cover construction material prices and quantities — cement, steel, pipes, bricks.';

export function checkScope(message: string): ScopeVerdict {
  const text = (message ?? '').trim();
  if (!text) return { allow: false, reason: 'EMPTY', reply: 'Ask me what a material costs, or how much of it you need.' };

  for (const p of UNSAFE_PATTERNS) if (p.test(text)) return { allow: false, reason: 'UNSAFE', reply: REFUSAL_UNSAFE };
  for (const p of INJECTION_PATTERNS) if (p.test(text)) return { allow: false, reason: 'INJECTION', reply: REFUSAL_INJECTION };

  // A script without Latin word breaks cannot be judged by word count.
  if (NON_LATIN.test(text)) return { allow: true };

  const words = text.split(/\s+/).length;
  const hasSignal = DOMAIN_SIGNALS.some((p) => p.test(text));
  // Short messages are follow-ups; the model has the thread and decides.
  if (!hasSignal && words >= 4) return { allow: false, reason: 'OFF_TOPIC', reply: REFUSAL_OFF_TOPIC };

  return { allow: true };
}

/**
 * The output-side scope check.
 *
 * Catches the case the input filter cannot: a question that looks in-domain
 * and pulls an out-of-domain answer out of the model. "What cement did the
 * Romans use" carries "cement" and passes the input gate; the answer is
 * history, and history is not what this thing is for.
 */
/**
 * No trailing \b on any of these.
 *
 * A prefix like `symptom` followed by `\b` cannot match "symptoms" — the
 * boundary assertion fails between two word characters — and `function\s*\(`
 * followed by `\b` cannot match at all, because a bracket is not a word
 * character. Both silently never fired.
 */
const OUT_OF_DOMAIN_OUTPUT: Array<{ p: RegExp; what: string }> = [
  { p: /\b(?:recipe|cook(?:ing|ed)?|bake|marinate|preheat)\b/i, what: 'cooking' },
  { p: /\b(?:python|javascript|typescript|const\s+\w+\s*=|function\s*\w*\s*\(|=>\s*\{|import\s+\w+\s+from)/i, what: 'code' },
  { p: /\b(?:diagnos|symptom|dosage|prescri)|(?:\d+\s*mg\b)/i, what: 'medical advice' },
  { p: /\b(?:stock\s+market|share\s+price|nifty|sensex|invest\s+in|portfolio|mutual\s+fund)\b/i, what: 'investment advice' },
  { p: /\b(?:poem|sonnet|haiku|screenplay|limerick)\b|write\s+(?:me\s+)?a\s+story/i, what: 'creative writing' },
  { p: /\b(?:election|vote\s+for|political\s+part|prime\s+minister|parliament)/i, what: 'politics' },
];

export function checkOutputScope(draft: string): Violation[] {
  const out: Violation[] = [];
  for (const { p, what } of OUT_OF_DOMAIN_OUTPUT) {
    const m = p.exec(draft);
    if (m) out.push({ kind: 'scope', token: m[0], message: `The reply drifted into ${what}, which is out of scope.` });
  }
  return out;
}

// ─── length ──────────────────────────────────────────────────────────────────

/**
 * "Small and crisp very small."
 *
 * Enforced rather than requested, because a length instruction in a system
 * prompt is a suggestion and this one is a requirement. Prose is measured
 * without the structured blocks — a nine-line quantity table is not verbosity,
 * a nine-line explanation of it is.
 *
 * 60, down from 90. The old number was set when the prompt asked for numbers in
 * a list or a table, so the ceiling only ever saw part of a reply. Now the panel
 * renders every figure itself and the prose is asked for one answer and one
 * clause of judgment — around 35 words. 60 leaves room to lead with a stale-price
 * or weak-match warning without tripping.
 */
export const MAX_PROSE_WORDS = 60;

/**
 * Past this the model did not run long, it misread the task — it is summarising
 * a catalogue rather than answering a question. Trimming that produces a
 * confident opening paragraph of the wrong answer, so it goes to the model.
 */
export const RUNAWAY_PROSE_WORDS = 180;

export function countProse(draft: string): number {
  const prose = draft
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s{0,6}[-*+\d][.)]?\s.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '');
  return prose.split(/\s+/).filter(Boolean).length;
}

export function checkLength(draft: string): Violation[] {
  const words = countProse(draft);
  if (words > MAX_PROSE_WORDS) {
    return [{
      kind: 'format', token: `${words} words`,
      message: `Prose is ${words} words against a ${MAX_PROSE_WORDS}-word ceiling.`,
    }];
  }
  return [];
}

/**
 * Markdown, which this panel cannot render.
 *
 * `ChatPanel` prints the reply into a `whitespace-pre-wrap` div and there is no
 * markdown parser in the app, so a table arrives as a wall of pipes and `**` as
 * literal asterisks — directly above the cards that already show the same
 * figures properly. The prompt bans the characters; this catches the drift.
 */
const MARKUP = /^\s{0,3}(?:[-*+]\s|\d{1,2}[.)]\s|#{1,6}\s|\|)|\*\*|`{3}/m;

export function checkMarkup(draft: string): Violation[] {
  const m = MARKUP.exec(draft);
  if (!m) return [];
  return [{
    kind: 'format', token: m[0].trim() || '|',
    message: 'Markdown does not render here — the panel prints your characters literally. Plain sentences only.',
  }];
}

/** Everything, in one call. */
export function validateAll(input: ValidateInput): Verdict {
  const base = validate(input);
  const hard = [...base.violations, ...checkOutputScope(input.draft)];
  const markup = checkMarkup(input.draft);
  const length = checkLength(input.draft);

  // Grounded, clean, and only long. Every number and name in this draft already
  // cleared the ledger, so any prefix of it has cleared the ledger too — cutting
  // it locally cannot introduce a claim, and a round trip to the model buys
  // nothing but latency and tokens. Markup is excluded because trimming by
  // sentence through a half-written table produces worse output, not shorter.
  if (!hard.length && !markup.length && length.length && countProse(input.draft) <= RUNAWAY_PROSE_WORDS) {
    return { pass: false, violations: length, repairInstruction: null, trimmable: true };
  }

  const all = [...hard, ...markup, ...length];
  if (!all.length) return { pass: true, violations: [], repairInstruction: null };
  const shown = all.slice(0, MAX_VIOLATIONS_REPORTED);
  return { pass: false, violations: shown, repairInstruction: buildRepair(shown) };
}

/**
 * Whole sentences from the start until the budget is spent.
 *
 * Only ever applied to a draft that already cleared the number, entity and
 * citation checks, which is what makes skipping the model safe here: truncation
 * is closed over groundedness. It cannot invent, only drop.
 *
 * It can drop a trailing caveat, which is the reason the budget sits at 60
 * against a prompt asking for 35 — by the time this fires, the tail is padding.
 * The first sentence is always kept, however long, so a reply is never empty.
 */
export function trimProse(draft: string, budget = MAX_PROSE_WORDS): string {
  const sentences = draft.match(/[^.!?\n]+[.!?]*[\s\n]*/g) ?? [draft];
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const w = s.split(/\s+/).filter(Boolean).length;
    if (kept.length && used + w > budget) break;
    kept.push(s);
    used += w;
  }
  return kept.join('').trim();
}
