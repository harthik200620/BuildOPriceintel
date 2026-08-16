# The buying assistant

A chat surface over the Build Objects price catalogue that answers two questions —
*what does this cost* and *how much of it do I need* — and refuses everything
else.

The design problem is not "add a chatbot". It is that this application's whole
value is that a number on screen is the number a purchase order would carry,
and a language model is a machine for producing plausible numbers. Bolting one
onto a price catalogue puts those two facts in direct conflict.

The resolution is that **the model is never allowed to produce a fact.**

---

## 1. The architecture in one line

```
message
  → scope gate         deterministic, pre-model, costs nothing
  → tool loop          the model picks tools; tools produce every fact
  → fact ledger        every atom the tools stand behind
  → grounding check    the draft is held against the ledger
  → one silent repair  the model sees its own violations
  → answer, or an honest refusal
```

Nothing skips a stage. A turn that cannot be grounded does not ship.

| file | what it is |
| --- | --- |
| `lib/chat/coefficients.ts` | Every constant the estimator may use, as data with an IS-code citation and a confidence rung. |
| `lib/chat/estimator.ts` | The quantity engine. Pure arithmetic, no model. |
| `lib/chat/tools.ts` | The eight functions the model is given. The only route to a fact. |
| `lib/chat/ledger.ts` | What the tools are prepared to stand behind, this turn. |
| `lib/chat/validator.ts` | Scope gate in, grounding check out. Fails closed. |
| `lib/chat/gemini.ts` | Gemini 2.5 Flash over raw HTTP, with the failure modes handled. |
| `lib/chat/prompt.ts` | System instruction and tool schemas. |
| `lib/chat/engine.ts` | The turn loop. |
| `app/api/chat/route.ts` | SSE endpoint. Progress streams; the answer does not. |
| `components/ChatPanel.tsx` | The docked panel. |

---

## 2. Why the model cannot hallucinate a price

Three mechanisms, in order of how much work they do.

### It has no prices to hallucinate *from*

The system prompt does not ask the model to be careful. It tells it that it
knows nothing:

> You know NOTHING about prices, brands, products, sellers or quantities on
> your own. Every fact you state comes from a tool call in this turn.

That is a weak guarantee on its own — instructions are suggestions — but it
changes the model's default behaviour from *recall* to *look up*, which is
what makes the next two mechanisms rarely have to fire.

### It cannot do arithmetic

Every quantity comes from `lib/chat/estimator.ts`, which is ordinary
TypeScript. The model chooses an estimator and fills its arguments; a pure
function multiplies. This matters more than it sounds: an LLM asked for cement
in an M20 slab will usually produce a number in the right neighbourhood, and
"the right neighbourhood" on a 400-bag order is several thousand rupees.

Every coefficient is a row with a citation and a confidence rung:

| rung | meaning | example |
| --- | --- | --- |
| `CODE` | printed in an Indian Standard | 50 kg bag — LMPC Rule 3(a) |
| `DERIVED` | arithmetic on `CODE` values, with the working shown | bricks per m³ from size + joint |
| `TRADE` | universal site practice, in no code | dry volume factor 1.54 |
| `DRAWING` | genuinely unknowable without a structural drawing | steel per m³ |

The `DRAWING` rung is the interesting one. **Steel per cubic metre of concrete
cannot be computed from a spec** — it comes from a bar bending schedule, and a
column ranges 80–250 kg/m³. So it is returned as a band with both ends and a
caveat, never a midpoint, and `estimateSteel` propagates the band into the rod
count rather than collapsing it. Quoting "80 kg/m³ for your slab" as a figure
is the single most common hallucination in this domain, and it is wrong often
enough to lose real money.

### Whatever survives is checked mechanically

`validator.ts` extracts every number and every named entity from the draft and
holds each against the `FactLedger` the tools deposited **this turn**. Not the
database — the turn. A price that is real but was not returned by this turn's
search is still a violation, because the model did not have it.

Failures get one silent repair pass (the model sees its own violation list). A
draft that fails twice is replaced with what is actually known, and the tool
cards still render. The user loses the sentence, not the answer.

**Calibration is the hard part**, and the failure mode being defended against
is not the obvious one. A validator that rejects *true* statements gets
switched off within a week, and then nothing is protected. So three categories
are exempt, each deliberately:

- numbers the **user** supplied — echoing "your 50 bags" is not invention
- structural numerals — list markers, "step 2 of 3"
- a closed vocabulary that names nothing — GST, ISI, OPC, CPVC, "Hyderabad"

Rounding tolerance scales with magnitude: `₹32,160` may be written `₹32,000`
in a sentence about a total, `8.06` bags may be written `8`, and below 1 there
is no tolerance at all because 0.5% and 0.05% are different claims.

`tests/chat.ts` tests false positives with the same weight as false negatives.

---

## 3. Why it only answers about construction materials

Two layers, deterministic first.

**Input.** `checkScope()` runs before a single token is spent. Injection
patterns are matched lexically — a regex cannot be argued out of its
instructions, which is exactly the weakness of relying on the model to hold
its own line. Off-topic is decided by *absence* rather than a blocklist: a
blocklist of forbidden subjects is unbounded and always incomplete, so the
question asked is "does anything here belong to the domain?" and refusal only
follows when the answer is no **and** the message is long enough for that
absence to mean something. Short messages fall through, because "and in 20mm?"
carries no domain word either and is a perfectly good follow-up.

Devanagari and Telugu bypass the word-count heuristic entirely — it is built
on Latin whitespace — and go to the model, where the output validator still
governs every number.

**Output.** `checkOutputScope()` catches the case the input gate structurally
cannot: a question that looks in-domain and pulls an out-of-domain answer out.
"What cement did the Romans use" carries the word *cement* and passes the
input gate; the answer is history, and history is not what this is for.

---

## 4. "Which is the best cement?"

Answered, not deflected — but the answer names its own rubric, and three
things keep it honest.

**Coverage is stated before the ranking.** Grade is declared on 76 of 239
cement listings in Hyderabad. A ranking that hides that has manufactured a
consensus out of a minority.

**Contradictory data is refused rather than repeated.** 29 listings in this
catalogue advertise a *"PPC 53 grade"* cement. Those grades exist only for OPC
under IS 269 — PPC is IS 1489, PSC is IS 455, and neither is graded that way.
The tool ignores the grade on those rows and says why. This is the line
between a catalogue that repeats what sellers say and one that knows what it
is looking at.

**"Best" is answered per application, because it has no single answer.** OPC
53 gains strength fastest, which is what a slab wants and what a mass pour
must avoid. PPC ends denser and more sulphate-resistant. PSC has the lowest
heat of hydration. The tool returns a winner for each, and price rank is
reported *beside* the quality score rather than inside it — so "best" and
"dearest" can be seen to be different questions.

---

## 5. Setup

```bash
# 1. add your key
echo 'GEMINI_API_KEY=your_key_here' >> .env.local

# 2. run
npm run dev
```

The panel is bottom-right, or `⌘J` / `Ctrl-J`. Without a key everything else
still works and the panel says exactly what is missing.

```bash
npm run test:chat     # 160 tests — scope, ledger, validator, estimator, tools
npm run test:engine   #  17 tests — the turn loop against a model that misbehaves
npm run test:live     #  14 real conversations (needs the key)
npm run test:all      # the above plus the existing 146-test suite
```

`test:live` is a **report, not a gate**. A model turn is not deterministic, so
asserting on its exact words produces a test that fails for reasons nobody
should act on. What it *does* hard-fail on is the harness: no turn may ship an
ungrounded figure, and no off-topic prompt may get an answer.

---

## 6. Two decisions worth knowing about

### The answer does not stream

Token-streaming an LLM reply is the expected thing and it is wrong here. The
validator needs a complete draft before it can check anything, so streamed
tokens would put unvalidated text on screen and then retract it — and the
retracted number is the one the user remembers. What streams is the *work*
("searching the catalogue", "pricing the job"); the answer arrives once,
already checked.

### The network guard has one exception, and it is published

`lib/no-network.ts` throws on any outbound request from the query path. The
assistant needs exactly one host, so `ALLOWED_HOSTS` names it with a reason,
rather than the guard being bypassed for the chat route. A host qualifies only
if it *cannot return catalogue data* — which is why no marketplace, directory
or brand site can ever be added. `/api/meta` publishes the allowlist, because
an exception nobody can see is indistinguishable from no guard at all.

---

## 7. Adding a category

1. **Coefficients** — add to `coefficients.ts` with a citation and a rung. If
   the quantity needs a drawing, it is a `CoefficientBand`, not a
   `Coefficient`.
2. **Estimator** — a function returning `Estimate`. Return
   `{ ok: false, missing: [...] }` for anything it cannot know; do not default.
3. **Register** it in `ESTIMATORS` and add the arg names to the
   `estimate_quantity` schema in `prompt.ts`.
4. **Options** — add the slot to `listOptions()` so the bot can ask about it
   without inventing the choices.
5. **Test** the arithmetic against a published figure, and test that an
   incomplete spec asks rather than assumes.

The rule that keeps this safe as it grows: **a tool may return "I don't know"
but may never return a default.** Every silent default is a wrong answer
waiting for the one user whose case differs.

---

## 8. Where it is weak

Named because a system that does not list its own gaps is not trustworthy.

- **Sand and aggregate have no prices.** The estimator computes the
  quantities; the catalogue has no offers, so `price_estimate` returns a
  partial subtotal and says which lines are missing. For an M20 slab that is
  two of three lines unpriced — the honest number, not a comfortable one.
- **Certification cannot be verified.** 223 cement listings show a
  brand-licensed BIS mark; one shows an independent certificate. A licence
  number cannot be confirmed from a marketplace listing, and the tool says so
  every time rather than implying more assurance than exists.
- **Freshness varies.** Many prices are past their SLA. Every card carries its
  own state and the reply passes it on, but this is catalogue age, not
  something the assistant fixes.
- **Multilingual is partial.** Telugu and Hindi reach the model and the
  validator still governs the numbers, but replies come back in English and
  the tool descriptions are English-only.
- **No memory across sessions.** Each conversation starts cold. A returning
  buyer re-states their pincode and their job.
- **The scope gate can over-refuse.** A four-word off-topic message is refused
  without a model call. That is the intended trade — cheap and unarguable —
  but it will occasionally catch an unusual phrasing of a legitimate question.
