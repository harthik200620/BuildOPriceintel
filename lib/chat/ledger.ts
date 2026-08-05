/**
 * The fact ledger.
 *
 * Every tool call deposits the atoms it is prepared to stand behind: the
 * numbers it computed or read, the entity names it saw in the database, and
 * the sources those came from. The validator then holds the model's draft
 * against this ledger and suppresses anything not in it.
 *
 * The inversion matters. The usual grounding approach asks a model to cite its
 * sources and trusts it to have done so; this asks nothing of the model and
 * verifies the output mechanically. A model that invents "₹412 per bag" fails
 * not because it forgot a citation but because 412 is not in the ledger.
 *
 * Numbers are stored at several roundings on purpose. The tool holds
 * `normalised_paise = 32160`; the reply will say "₹321.60" or "₹322" or
 * "₹321". All three are the same fact, and a validator that only knew 32160
 * would reject the correct answer — which is worse than useless, because a
 * validator that fires on true statements gets switched off.
 */

/**
 * A run of capitalised words — a brand, a vendor, a standard, a place.
 *
 * Defined here rather than in the validator so that the side that DEPOSITS
 * names and the side that CHECKS them cannot drift apart. `validator.ts`
 * imports it; the dependency runs that way round because the validator already
 * imports FactLedger, and the reverse would be a cycle.
 *
 * Returned as a factory because /g regexes carry lastIndex between calls.
 */
export const capitalisedRuns = () =>
  /\b([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})\b/g;

export interface Source {
  label: string;
  url: string;
  fetched_at?: string;
  confidence?: string;
}

export class FactLedger {
  private nums = new Set<number>();
  private ents = new Set<string>();
  private srcs = new Map<string, Source>();
  /** Free-text claims a tool authored and the model may restate verbatim. */
  private claims = new Set<string>();

  /** Numbers the reply is allowed to state, at every rounding a reply may use. */
  number(...values: Array<number | null | undefined>): this {
    for (const v of values) {
      if (v == null || !Number.isFinite(v)) continue;
      this.nums.add(v);
      this.nums.add(Math.round(v));
      this.nums.add(Math.round(v * 10) / 10);
      this.nums.add(Math.round(v * 100) / 100);
      this.nums.add(Math.floor(v));
      this.nums.add(Math.ceil(v));
    }
    return this;
  }

  /**
   * A paise figure, deposited as every rupee rendering of itself.
   *
   * 32160 paise is ₹321.60, ₹321.6, ₹322, ₹321 and — in a sentence about a
   * hundred bags — ₹32,160. All are true; all go in.
   */
  paise(...values: Array<number | null | undefined>): this {
    for (const p of values) {
      if (p == null || !Number.isFinite(p)) continue;
      this.nums.add(p);
      const r = p / 100;
      this.number(r);
      // Thousands/lakh renderings a reply may use for a line total.
      this.number(r / 1000, r / 100000);
    }
    return this;
  }

  /**
   * Brand names, vendor names, product titles, unit words, IS codes.
   *
   * Numbers inside the string are deposited as numbers too. "UltraTech OPC 53
   * grade cement — 50 kg bag" is a title, but 53 and 50 are facts it asserts,
   * and a reply that says "OPC 53" was otherwise rejected for the 53 — a
   * validator failing on a verbatim quote of its own tool output.
   */
  entity(...values: Array<string | null | undefined>): this {
    for (const v of values) {
      if (!v) continue;
      const s = String(v).trim();
      if (!s) continue;
      this.ents.add(s);
      for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) this.number(Number(m[0]));
    }
    return this;
  }

  source(s: Source): this {
    if (s?.url) this.srcs.set(s.url, s);
    return this;
  }

  /**
   * A sentence the tool authored and the model may restate.
   *
   * The numbers inside it are deposited, for the same reason `entity()` does it:
   * a tool that hands the model "Ranked on: declared grade (40%), certification
   * (25%)..." and then rejects the reply for saying 40 is failing on a verbatim
   * quote of itself. That was not a hypothetical — it was every "which is the
   * best cement" turn, because the system prompt asks for the rubric and this
   * method used to deposit nothing at all.
   *
   * Names go in as the capitalised RUNS inside the sentence, not as the whole
   * sentence. "IS 1489 Part 1" and "BIS Quality Control Order" become quotable;
   * every other substring of the claim does not. Depositing the raw string
   * instead would work — `hasEntity` matches substrings in both directions —
   * but it would let any fragment of any claim pass the entity check, which is
   * a far wider hole than the one it closes.
   */
  claim(...values: Array<string | null | undefined>): this {
    for (const v of values) {
      if (!v) continue;
      const s = String(v);
      this.claims.add(s);
      for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) this.number(Number(m[0]));
      for (const m of s.matchAll(capitalisedRuns())) this.ents.add(m[1]);
    }
    return this;
  }

  /** Merge another ledger in — used to roll a turn's tool calls together. */
  merge(other: FactLedger): this {
    for (const n of other.nums) this.nums.add(n);
    for (const e of other.ents) this.ents.add(e);
    for (const [k, v] of other.srcs) this.srcs.set(k, v);
    for (const c of other.claims) this.claims.add(c);
    return this;
  }

  hasNumber(v: number, tolerance = 0): boolean {
    if (this.nums.has(v)) return true;
    if (tolerance > 0) {
      for (const n of this.nums) if (Math.abs(n - v) <= tolerance) return true;
    }
    return false;
  }

  hasEntity(v: string): boolean {
    const t = v.trim().toLowerCase();
    if (!t) return true;
    for (const e of this.ents) {
      const el = e.toLowerCase();
      if (el === t || el.includes(t) || t.includes(el)) return true;
    }
    return false;
  }

  get sources(): Source[] { return [...this.srcs.values()]; }
  get size(): { numbers: number; entities: number; sources: number } {
    return { numbers: this.nums.size, entities: this.ents.size, sources: this.srcs.size };
  }
  get allEntities(): string[] { return [...this.ents]; }
  get allClaims(): string[] { return [...this.claims]; }
  get isEmpty(): boolean { return this.nums.size === 0 && this.ents.size === 0; }
}
