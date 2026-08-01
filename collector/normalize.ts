/**
 * RawOffer -> typed product + vendor + offer + provenanced spec rows.
 *
 * Entity resolution here is precision-first, exactly as the spec insists: a
 * false match is a P0 correctness defect, not a relevance miss, because it puts
 * the wrong item in the cart and onto the invoice. So products merge only on a
 * complete, typed attribute tuple. Where a listing does not publish enough
 * attributes to identify it, it becomes its own product rather than being
 * guessed into an existing one — a missed match costs one comparison row, a
 * wrong match costs a wrong delivery.
 */
import crypto from 'node:crypto';
import type { RawOffer } from './types';
import { Ladder } from './ladder';
import { TMT_KG_PER_M, TYPICAL_UNIT_KG, inchToBoreMm, cementCanonicalPaise, CEMENT_STANDARD_BAG_KG } from '../lib/units';

// ── unit normalisation ───────────────────────────────────────────────────────

/** Maps whatever the seller typed into a unit we can actually convert. */
const UNIT_MAP: Array<[RegExp, string, number]> = [
  [/^bag(\s|$|s)|bag of/i, 'bag', 1],
  [/^(piece|pieces|pcs?|nos?|number|unit|each|brick|bricks)$/i, 'piece', 1],
  [/^(kg|kilogram|kgs)$/i, 'kg', 1],
  [/^(ton|tonne|mt|metric ton)$/i, 'tonne', 1],
  [/^quintal$/i, 'quintal', 1],
  [/^(meter|metre|mtr|m|running meter|running metre|rmt)$/i, 'running_metre', 1],
  // Feet is a real quoted unit and must be converted, not assumed to be metres.
  [/^(feet|foot|ft)$/i, 'running_metre', 3.28084],
  [/^(cubic meter|cubic metre|cbm|cum|m3)$/i, 'cum', 1],
  [/^(cubic feet|cft)$/i, 'cft', 1],
  [/^(square feet|sq ?ft|sqft)$/i, 'sqft', 1],
  [/1000|thousand/i, 'per_1000', 1],
  [/^(roll|coil)$/i, 'coil', 1],
  [/^(box|packet|set|carton)$/i, 'box', 1],
];

export function normaliseUnit(quoted: string | null | undefined): { unit: string; perCanonical: number } | null {
  if (!quoted) return null;
  // "per" is stripped as well as "/" because sellers type it into the unit
  // field itself — ExportersIndia renders "Per Per piece" and "perkg" where the
  // seller wrote the word out. Stripping it is not a guess about what they
  // meant; it is removing a preposition the platform already prints for them.
  const q = quoted.trim().replace(/^(\/|per)\s*/i, '');
  for (const [re, unit, factor] of UNIT_MAP) if (re.test(q)) return { unit, perCanonical: factor };
  return null;
}

// ── brand rosters (real brands only; never invent one) ───────────────────────

const BRANDS: Record<string, string[]> = {
  // Cement is listed by PRODUCT LINE, not by parent company, because that is
  // what a seller actually lists and what a buyer actually asks for. "Birla" is
  // four different companies' brands — MP Birla Samrat (Birla Corp), Birla
  // Shakti (Kesoram), Birla Gold, Birla A1 (Orient) — and collapsing them to
  // one token merged them into a single product whose floor price belonged to
  // whichever was cheapest. detectBrand matches longest-first, so a line name
  // wins over its parent and a listing that names only the parent keeps it.
  //
  // Every entry below was mined from the `title` field of collector/raw/*.jsonl
  // and appears in at least one collected listing. Nothing here is from memory.
  cement: [
    // parents — still correct for a listing that names only the company
    'UltraTech', 'ACC', 'Ambuja', 'Dalmia', 'Ramco', 'Shree', 'JK', 'Zuari', 'Penna',
    'Bharathi', 'Sagar', 'Maha', 'Nagarjuna', 'Priya', 'JSW', 'Chettinad', 'India Cements',
    'Orient', 'Coromandel', 'Bangur', 'KCP', 'Deccan', 'Lafarge', 'Jaypee', 'Rashi',
    // the Birla brands, which are not one brand
    'MP Birla Perfect Plus', 'MP Birla Perfect', 'MP Birla Samrat', 'MP Birla',
    'Birla Shakti', 'Birla Gold', 'Birla A1', 'Birla',
    // ACC lines
    'ACC Concrete Plus Xtra Strong', 'ACC Concrete Plus', 'ACC Concrete',
    'ACC Suraksha Power', 'ACC Suraksha', 'ACC Gold Water Shield', 'ACC F2R',
    // other named lines present in the collected supply
    // "Ramco Super Grade" is not listed separately: it squashes to the same
    // string as "Ramco Supergrade", and having both split one brand in two.
    'Ramco Supercrete', 'Ramco Supergrade', 'Ramco Super',
    'UltraTech Super', 'Shree Jung Rodhak', 'Bangur Rockstrong', 'Bangur Magna',
    'Bharathi Ultrafast', 'JSW Concreel', 'Penna Premium',
    // standalone brands the old roster missed entirely, so they were filed
    // as "Unbranded" and merged with each other
    'Parasakti', 'CCI', 'Bhavya',
  ],
  tmt_steel: ['Tata Tiscon', 'Tata', 'JSW Neosteel', 'JSW', 'SAIL', 'Vizag Steel', 'Vizag', 'RINL',
    'Jindal Panther', 'Jindal', 'Kamdhenu', 'Rathi', 'Shyam Steel', 'Radha Thermax', 'Radha',
    'Sunvik', 'Prime Gold', 'Agni', 'Sujana', 'Meenakshi', 'Simhadri',
    // Telugu-state and regional mills that actually appear in this supply
    'Shree TMT', 'Sugna', 'AF Star', 'Vinayak', 'MS Life Steel', 'Dwaraka', 'Sri Sai'],
  // Pipes are the category where a brand roster earns its keep, because NO pipe
  // listing carries a seller brand field — 0 of 451 — so the title is the only
  // evidence there is. Every name below was verified present in a collected
  // title; the counts in `data/logs/` record how many.
  //
  // "Hindware" is deliberately absent. It appears only inside "Truflo by
  // Hindware", and since detectBrand matches longest-first, adding it would
  // relabel Truflo's own pipes as Hindware's.
  water_pipes: [
    // national brands
    'Astral', 'Supreme', 'Finolex', 'Ashirvad', 'Prince', 'Truflo', 'Kisan', 'Captain',
    'Ori-Plast', 'Ajay', 'Sudhakar', 'Nandi', 'Sagar', 'Apollo', 'Jindal', 'Tata', 'Utkarsh',
    'Jain', 'Vectus',
    // regional and own-brand manufacturers that actually supply these two
    // cities, and which the roster used to file as "Unbranded"
    'Austro', 'Lenox', 'Lexon', 'Sumolex', 'Sowbhagya', 'Varsha', 'Polycab',
    'Champion', 'Suki', 'Fitwell', 'Fitwin', 'Joton', 'Kaizen', 'Worldflow',
    'Tomson', 'BRP',
  ],
  bricks_blocks: ['UltraTech Xtralite', 'Xtralite', 'Biltech', 'Magicrete', 'Renacon',
    'Birla Aerocon', 'Aerocon', 'Aerobild', 'Greenstone', 'Siporex', 'Ecolite', 'Brickwell',
    'Conmix', 'Primo', 'Fusion',
    // Manufacturers present in the collected titles, each checked against the
    // listing that produced it rather than added on reputation.
    'Wienerberger', 'Porotherm', 'Nucon', 'Ecotherm', 'NCL',
    // Karimnagar is the brick belt that supplies Hyderabad, and the kiln
    // initials are how the trade names these — "Karimnagar ABN Bricks" is the
    // seller's own product name, so the qualified forms stay.
    //
    // Bare 'Karimnagar' and 'Karnataka' were in this roster and are now gone:
    // one is a district, the other a state. "Clay Rectangular Karimnagar Red
    // Bricks" says where the clay was fired, not who fired it, and resolving
    // that to a brand put a place at the top of the brand facet — asserting a
    // brand no seller claimed. Those 15 listings now carry no brand, which is
    // what the source actually supports.
    'Karimnagar SRB', 'Karimnagar SVT', 'Karimnagar PVC', 'Karimnagar MBC',
    'Karimnagar VBS', 'Karimnagar ABP', 'Karimnagar VBI', 'Karimnagar ABN'],
};

/** Primary vs secondary is a real quality distinction buyers ask about. */
const PRIMARY_MILLS = /tata|jsw|sail|vizag|rinl|jindal panther|essar|arcelor/i;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const loosen = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function matchRoster(category: string, texts: (string | null | undefined)[]): string | null {
  const parts = texts.filter(Boolean) as string[];
  if (!parts.length) return null;
  const hay = loosen(parts.join(' '));
  const haySquashed = squash(parts.join(' '));
  const roster = BRANDS[category] ?? [];
  // Longest first so "ACC Suraksha Power" beats "ACC Suraksha" beats "ACC".
  const sorted = [...roster].sort((a, b) => b.length - a.length);
  for (const b of sorted) {
    if (hay.includes(loosen(b))) return b;
    // Spacing varies in seller copy — "M P Birla" is "MP Birla". Only for names
    // long enough that a squashed substring cannot collide by accident.
    const sq = squash(b);
    if (sq.length >= 6 && haySquashed.includes(sq)) return b;
  }
  return null;
}

/**
 * The brand a seller claims, in the order the claim can be trusted.
 *
 * Three tiers, tried in turn rather than merged into one haystack, because
 * sellers contradict themselves and merging lets the wrong field win on a
 * longest-match tie-break:
 *
 *   1. the listing TITLE — the name the seller chose to display
 *   2. their brand attribute — real, but routinely filled in wrong. One
 *      collected listing reads title "Maha PPC Cement", Brand "Birla Cement",
 *      Type "Maha PPC Cement". Merging tiers made that a Birla product because
 *      "Birla" is the longer token; the title is plainly the better evidence.
 *   3. the spec blob — weakest. IndiaMART renders related-product rows into it,
 *      which turned listings titled "Bangur Cement" and "Penna Ppc Cement" into
 *      UltraTech products. Still used when nothing else resolves: a weak signal
 *      beats no signal, and must not outrank a strong one.
 */
function detectBrand(
  category: string,
  brandField: string | null | undefined,
  title: string | null | undefined,
  specsBlob?: string | null,
): string | null {
  return matchRoster(category, [title])
    ?? matchRoster(category, [brandField])
    ?? matchRoster(category, [specsBlob]);
}

const specGet = (specs: Record<string, string>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const hit = Object.keys(specs).find((s) => s.toLowerCase() === k.toLowerCase());
    if (hit && specs[hit]?.trim()) return specs[hit].trim();
  }
  // loose contains-match as a second pass
  for (const k of keys) {
    const hit = Object.keys(specs).find((s) => s.toLowerCase().includes(k.toLowerCase()));
    if (hit && specs[hit]?.trim()) return specs[hit].trim();
  }
  return null;
};

const numOf = (s: string | null): number | null => {
  if (!s) return null;
  const m = s.replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

// ── commercial attributes, published by the seller on every category ─────────
//
// These were being collected and thrown away. An audit of the raw archive (77
// files, 4,625 listings) found `Country of Origin` on 170 loaded offers while
// `product.country_of_origin` sat at 0% fill since the schema was written, plus
// Supply Type, Trade Type, Colour, Material, Form and Shape — all published, all
// discarded because no extractor ever looked for them.
//
// Every field here is recorded `quoted`, not `derived` or `typical`, because it
// is the seller's own published text. Nothing in this function infers anything.

/** "Made in India", "INDIA", "Porbandar,India" → "India". Never guesses a country. */
function canonicalCountry(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/^made\s+in\s+/i, '').replace(/\.$/, '').trim();
  if (!s) return null;
  // Sellers type a place into this field as often as a country — one listing
  // reads "Porbandar,India". Take the last comma-separated part, which is the
  // country in every observed case, rather than publishing a town as a country.
  const tail = s.split(',').pop()!.trim();
  if (/^india$/i.test(tail)) return 'India';
  return tail.length >= 3 && tail.length <= 40
    ? tail.replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
}

/**
 * One unit per meaning. The archive carries Piece / piece / Pieces / Piece(s) /
 * Pcs / pc as six spellings of the same thing across 19 distinct MOQ units,
 * which makes "MOQ 1000 Piece" and "MOQ 1000 Pieces" look like different units
 * in a facet.
 */
function canonicalMoqUnit(u: string | null): string | null {
  if (!u) return null;
  const s = u.trim().toLowerCase().replace(/[().]/g, '').trim();
  if (!s) return null;
  // "Bricks" and "Lightweight bricks" are the goods, not a unit — the seller
  // means one brick. Counting them as their own units would split the facet.
  if (/^(piece|pieces|pcs|pc|nos|no|number|unit|units|each)$/.test(s)) return 'Piece';
  if (/\b(brick|bricks|block|blocks)$/.test(s)) return 'Piece';
  if (/^(bag|bags)$/.test(s)) return 'Bag';
  if (/^(kg|kgs|kilogram|kilograms)$/.test(s)) return 'Kg';
  if (/^(ton|tons|tonne|tonnes|mt|metric ton)$/.test(s)) return 'Tonne';
  if (/^(meter|metre|meters|metres|mtr|m)$/.test(s)) return 'Metre';
  if (/^(square feet|sq ft|sqft)$/.test(s)) return 'Sq ft';
  if (/^(cubic feet|cft)$/.test(s)) return 'Cft';
  if (/^(set|sets|box|boxes|packet|packets)$/.test(s)) return 'Box';
  return u.trim().slice(0, 24);
}

/**
 * Deliberately NOT extracted, so this is not re-litigated later:
 *
 *   Feature / Features / Specialities / Suitable For — freeform marketing prose,
 *     roughly one distinct value per listing. A facet over them would have as
 *     many values as rows.
 *   Size — 93 distinct unparsed strings mixing inches, mm and prose. The
 *     per-category size extractors already do this properly where they can.
 *   Number Of Flower — an IndiaMART form template leaking into brick listings.
 *   Thermal Conductivity — 10 offers, and one of them holds "Karimnagar", a town
 *     name, in a W/mK field. Not trustworthy at that volume.
 */
function commercialAttrs(
  raw: RawOffer,
  L: Ladder,
  fi: (f: string, l: string, u?: string) => any,
): { attrs: Record<string, unknown>; country_of_origin: string | null } {
  const s = raw.specs ?? {};
  const attrs: Record<string, unknown> = {};

  const country = canonicalCountry(specGet(s, 'Country of Origin', 'Origin', 'Made In'));
  if (country) L.quoted(fi('country_of_origin', 'Country of origin'), country);

  // The brand the seller TYPED, which is not the same thing as the brand we
  // resolved. `product.brand` stays roster-gated because it feeds `item_code`
  // and therefore product identity — one mis-declared brand there splits a
  // product in two or merges two into one. But the seller's own words are a
  // real quoted claim and worth showing, so they are kept beside the resolved
  // brand rather than promoted into it.
  const declared = (raw.brand ?? '').trim();
  if (declared && declared.length <= 60) {
    attrs.declared_brand = declared;
    L.quoted(fi('declared_brand', 'Brand, as the seller states it'), declared);
  }

  // Manufacturer vs Supplier — who you are actually buying from. Binary and
  // clean in the source, and a real trust signal.
  const supply = specGet(s, 'Supply Type', 'Business Type', 'Seller Type');
  if (supply) {
    attrs.supply_type = supply;
    L.quoted(fi('supply_type', 'Supply type'), supply);
  }

  // Trade / Non-Trade is a genuine cement pricing distinction, not a label.
  const trade = specGet(s, 'Trade Type');
  if (trade) {
    const t = /non/i.test(trade) ? 'Non-Trade' : 'Trade';
    attrs.trade_type = t;
    L.quoted(fi('trade_type', 'Trade type'), t);
  }

  for (const [key, label, ...keys] of [
    ['color', 'Colour', 'Color', 'Colour'],
    ['material', 'Material', 'Material', 'Material Type'],
    ['form', 'Form', 'Form'],
    ['shape', 'Shape', 'Shape'],
    ['shelf_life', 'Shelf life', 'Shelf Life'],
    ['standard_compliance', 'Standard', 'Standard Compliance', 'IS Code', 'Standards'],
  ] as string[][]) {
    const v = specGet(s, ...keys);
    // A one-character or absurdly long value is markup noise, not a spec.
    if (v && v.length >= 2 && v.length <= 60) {
      attrs[key] = v;
      L.quoted(fi(key, label), v);
    }
  }

  return { attrs, country_of_origin: country };
}

/**
 * MOQ from the spec table, for sources whose card markup does not carry it.
 * IndiaMART publishes it as a `MOQ` spec on 156 offers while its card selector
 * matches nothing, so `offer.moq_qty` was populated from ExportersIndia alone.
 */
export function moqFromSpecs(raw: RawOffer): { qty: number | null; unit: string | null } {
  if (raw.moq_qty != null) return { qty: raw.moq_qty, unit: canonicalMoqUnit(raw.moq_unit ?? null) };
  const t = specGet(raw.specs ?? {}, 'MOQ', 'Minimum Order Quantity', 'Min. Order Quantity', 'Min Order');
  if (!t) return { qty: null, unit: null };
  const m = t.match(/([\d,.]+)\s*(.*)$/);
  if (!m) return { qty: null, unit: null };
  const qty = numOf(m[1]);
  return qty ? { qty, unit: canonicalMoqUnit(m[2] || null) } : { qty: null, unit: null };
}

// ── per-category attribute extraction ────────────────────────────────────────

export interface Normalised {
  ok: boolean;
  reason?: string;
  category: string;
  item_code: string;
  product_id: string;
  title: string;
  brand: string | null;
  attrs: Record<string, unknown>;
  /** Published by the seller, canonicalised. Null when nobody stated it. */
  country_of_origin: string | null;
  unit_canonical: string;
  unit_trade: string;
  pack_size: number | null;
  pack_unit: string | null;
  unit_weight_kg: number | null;
  unit_volume_m3: number | null;
  /** Price for ONE canonical unit, as the seller quoted it (before tax/freight). */
  base_paise_per_canonical: number;
  /** Price for one trade unit, as quoted. */
  base_paise_trade: number;
  ladder: Ladder;
  cert_state: 'CERTIFIED' | 'BRAND_LICENSED' | 'NOT_DECLARED' | 'NOT_APPLICABLE' | 'EXPIRED';
  cert_ref: string | null;
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function cementAttrs(raw: RawOffer, L: Ladder, fi: (f: string, l: string, u?: string) => any) {
  const s = raw.specs;
  const blob = `${raw.title} ${JSON.stringify(s)}`;

  const typeRaw = specGet(s, 'Cement Type', 'Type of Cement', 'Cement Type/Grade', 'Type');
  let cement_type: string | null = null;
  const t = `${typeRaw ?? ''} ${raw.title}`.toUpperCase();
  if (/\bPPC\b|POZZOLANA/.test(t)) cement_type = 'PPC';
  else if (/\bPSC\b|SLAG/.test(t)) cement_type = 'PSC';
  else if (/WHITE/.test(t)) cement_type = 'White cement';
  else if (/SULPHATE|SRC/.test(t)) cement_type = 'Sulphate resisting';
  else if (/\bOPC\b|ORDINARY PORTLAND/.test(t)) cement_type = 'OPC';
  L.resolve(fi('cement_type', 'Type'), {
    quoted: () => cement_type,
    typical: () => (/CEMENT/.test(t) ? { value: 'OPC', basis: 'Neither the listing nor the title states a type; OPC is the most common grade in this market. Representative, not quoted.' } : null),
  });

  const gradeRaw = specGet(s, 'Grade', 'Cement Grade', 'Cement Type/Grade');
  const gm = `${gradeRaw ?? ''} ${raw.title}`.match(/\b(33|43|53)\b/);
  const opc_grade = gm ? `${gm[1]} grade` : null;
  if ((cement_type ?? 'OPC') === 'OPC') {
    L.resolve(fi('opc_grade', 'Grade'), { quoted: () => opc_grade });
  }

  const packRaw = specGet(s, 'Packaging Size', 'Pack Size', 'Weight', 'KG', 'Quantity Per Pack');
  const packKg = numOf(packRaw) ?? numOf(raw.title.match(/(\d+)\s*kg/i)?.[0] ?? null);
  L.resolve(fi('pack_size_kg', 'Pack size', 'kg'), {
    quoted: () => (packKg && packKg >= 1 && packKg <= 1500 ? packKg : null),
    typical: () => ({ value: 50, basis: 'The Indian standard cement bag is 50 kg and is expressly inside the packaged-commodity regime (LMPC Rule 3(a)). Representative, not quoted.' }),
  });

  const app = specGet(s, 'Application', 'Usage/Application', 'Usage');
  L.resolve(fi('application', 'Application'), { quoted: () => app });
  const packType = specGet(s, 'Packaging Type');
  L.resolve(fi('packaging_type', 'Packaging'), { quoted: () => packType });

  return {
    cement_type: cement_type ?? 'OPC',
    opc_grade,
    pack_size_kg: L.numeric('pack_size_kg') ?? 50,
    application: app,
    _blob: blob,
  };
}

function tmtAttrs(raw: RawOffer, L: Ladder, fi: (f: string, l: string, u?: string) => any) {
  const s = raw.specs;
  const sizeRaw = specGet(s, 'Size', 'Diameter', 'Thickness', 'Bar Size', 'Dia');
  let dia = numOf(sizeRaw);
  if (!dia) {
    const m = raw.title.match(/(\d+(?:\.\d+)?)\s*mm/i);
    dia = m ? Number(m[1]) : null;
  }
  if (dia && !TMT_KG_PER_M[dia]) {
    // Round to the nearest real IS 1786 diameter rather than inventing one.
    const known = Object.keys(TMT_KG_PER_M).map(Number);
    const near = known.find((k) => Math.abs(k - dia!) <= 0.6);
    dia = near ?? null;
  }
  L.resolve(fi('diameter_mm', 'Diameter', 'mm'), { quoted: () => dia });

  const gradeRaw = specGet(s, 'Grade', 'Steel Grade', 'Material Grade');
  const g = `${gradeRaw ?? ''} ${raw.title}`.toUpperCase().replace(/\s+/g, '');
  let grade: string | null = null;
  if (/FE550D/.test(g)) grade = 'Fe 550D';
  else if (/FE550/.test(g)) grade = 'Fe 550';
  else if (/FE500D/.test(g)) grade = 'Fe 500D';
  else if (/FE500/.test(g)) grade = 'Fe 500';
  else if (/FE415/.test(g)) grade = 'Fe 415';
  else if (/FE600/.test(g)) grade = 'Fe 600';
  L.resolve(fi('grade', 'Grade'), { quoted: () => grade });

  const lenRaw = specGet(s, 'Length', 'Bar Length');
  const len = numOf(lenRaw);
  L.resolve(fi('length_m', 'Length', 'm'), {
    quoted: () => (len && len >= 1 && len <= 18 ? len : null),
    typical: () => ({ value: 12, basis: 'TMT is supplied in 12 m standard lengths across the Indian market. Representative, not quoted.' }),
  });

  const brand = detectBrand('tmt_steel', raw.brand, raw.title, JSON.stringify(s));
  const producer_type = brand && PRIMARY_MILLS.test(brand) ? 'Primary producer' : brand ? 'Secondary producer' : null;
  if (producer_type) {
    L.derived(fi('producer_type', 'Producer'), producer_type,
      `Classified from the brand "${brand}": integrated steel plants are primary, induction/re-rolling mills are secondary.`);
  }

  const lengthM = L.numeric('length_m') ?? 12;
  const kgPerM = dia ? TMT_KG_PER_M[dia] : null;
  const rodKg = kgPerM ? +(kgPerM * lengthM).toFixed(3) : null;
  if (rodKg) {
    L.derived(fi('unit_weight_kg', 'Weight per rod', 'kg'), rodKg,
      `${dia} mm nominal mass ${kgPerM} kg/m (IS 1786) × ${lengthM} m = ${rodKg} kg`);
  }

  const corr = specGet(s, 'Corrosion', 'Coating', 'Surface');
  L.resolve(fi('corrosion_resistance', 'Corrosion resistance'), { quoted: () => corr });

  return {
    diameter_mm: dia, grade, length_m: lengthM, producer_type,
    kg_per_m: kgPerM, rod_weight_kg: rodKg,
  };
}

function pipeAttrs(raw: RawOffer, L: Ladder, fi: (f: string, l: string, u?: string) => any) {
  const s = raw.specs;
  const hay = `${raw.title} ${JSON.stringify(s)}`.toUpperCase();

  let system: string | null = null;
  if (/CPVC/.test(hay)) system = 'CPVC';
  else if (/\bSWR\b|SOIL.{0,8}WASTE|DRAINAGE/.test(hay)) system = 'SWR';
  else if (/HDPE/.test(hay)) system = 'HDPE';
  else if (/\bGI\b|GALVAN/.test(hay)) system = 'GI';
  else if (/UPVC|PVC/.test(hay)) system = 'UPVC / PVC';
  L.resolve(fi('pipe_system', 'System'), { quoted: () => system });

  // Bore. The trade quotes inches; the standard is millimetres; the mapping is
  // a table because 1" CPVC is 25 mm nominal but 4" SWR is 110 mm OD.
  const sizeRaw = specGet(s, 'Size', 'Nominal Size', 'Diameter', 'Pipe Size', 'Outer Diameter');
  let bore: number | null = null;
  let boreHow = '';
  const mmMatch = `${sizeRaw ?? ''} ${raw.title}`.match(/(\d+(?:\.\d+)?)\s*mm/i);
  if (mmMatch) { bore = Number(mmMatch[1]); boreHow = 'stated in mm by the seller'; }
  if (!bore) {
    const inMatch = `${sizeRaw ?? ''} ${raw.title}`.match(/(\d+(?:\s*\/\s*\d+)?(?:\.\d+)?)\s*(?:inch|in\b|")/i);
    if (inMatch) {
      const frac = inMatch[1].replace(/\s+/g, '');
      const asNum = frac.includes('/') ? (() => { const [a, b] = frac.split('/').map(Number); return a / b; })() : Number(frac);
      const key = asNum === 0.5 ? '1/2' : asNum === 0.75 ? '3/4' : String(asNum);
      const mm = inchToBoreMm(key);
      if (mm) { bore = mm; boreHow = `${inMatch[1]}" → ${mm} mm from the nominal-bore table (not ×25.4)`; }
    }
  }
  if (bore && boreHow.includes('table')) {
    L.derived(fi('nominal_bore_mm', 'Nominal bore', 'mm'), bore, boreHow);
  } else {
    L.resolve(fi('nominal_bore_mm', 'Nominal bore', 'mm'), { quoted: () => bore });
  }

  const clsRaw = specGet(s, 'Class', 'Pressure Class', 'Pressure Rating', 'SDR', 'Schedule', 'Grade');
  const cls = `${clsRaw ?? ''} ${raw.title}`.toUpperCase();
  let sdr: string | null = null, pressure_class: string | null = null;
  let swr_type: string | null = null, gi_class: string | null = null, pe_grade: string | null = null;
  if (system === 'CPVC') { const m = cls.match(/SDR\s*-?\s*(11|13\.5)/); sdr = m ? `SDR-${m[1]}` : null; }
  if (system === 'UPVC / PVC') { const m = cls.match(/CLASS\s*-?\s*([1-5])/); pressure_class = m ? `Class ${m[1]}` : null; }
  if (system === 'SWR') { const m = cls.match(/TYPE\s*-?\s*([AB])/); swr_type = m ? `Type ${m[1]}` : null; }
  if (system === 'GI') {
    if (/HEAVY|RED/.test(cls)) gi_class = 'Heavy';
    else if (/MEDIUM|BLUE/.test(cls)) gi_class = 'Medium';
    else if (/LIGHT|YELLOW/.test(cls)) gi_class = 'Light';
  }
  if (system === 'HDPE') { const m = cls.match(/PE\s*-?\s*(63|80|100)/); pe_grade = m ? `PE ${m[1]}` : null; }
  if (sdr) L.quoted(fi('sdr', 'Pressure class — SDR'), sdr);
  if (pressure_class) L.quoted(fi('pressure_class', 'Pressure class'), pressure_class);
  if (swr_type) L.quoted(fi('swr_type', 'SWR type'), swr_type);
  if (gi_class) L.quoted(fi('gi_class', 'GI class'), gi_class);
  if (pe_grade) L.quoted(fi('pe_grade', 'PE grade'), pe_grade);

  const lenRaw = specGet(s, 'Length', 'Pipe Length', 'Single Piece Length');
  let len = numOf(lenRaw);
  if (lenRaw && /f(ee)?t/i.test(lenRaw) && len) len = +(len * 0.3048).toFixed(2);
  const defaultLen = system === 'GI' ? 6 : 3;
  L.resolve(fi('length_m', 'Length', 'm'), {
    quoted: () => (len && len >= 0.5 && len <= 20 ? len : null),
    typical: () => ({
      value: defaultLen,
      basis: system === 'GI'
        ? 'GI pipe is supplied in 6 m standard lengths (IS 1239). Representative, not quoted.'
        : 'CPVC, UPVC and SWR pipe is supplied in 3 m standard lengths. Representative, not quoted.',
    }),
  });

  const joint = specGet(s, 'Joint', 'Connection', 'End Type');
  L.resolve(fi('joint_type', 'Joint'), { quoted: () => joint });

  return {
    pipe_system: system, nominal_bore_mm: bore, sdr, pressure_class, swr_type, gi_class, pe_grade,
    length_m: L.numeric('length_m') ?? defaultLen, joint_type: joint,
  };
}

function brickAttrs(raw: RawOffer, L: Ladder, fi: (f: string, l: string, u?: string) => any) {
  const s = raw.specs;
  const hay = `${raw.title} ${JSON.stringify(s)}`.toUpperCase();

  let block_type: string | null = null;
  if (/\bAAC\b|AUTOCLAVED|AERATED/.test(hay)) block_type = 'AAC block';
  else if (/\bCLC\b|CELLULAR/.test(hay)) block_type = 'CLC block';
  else if (/FLY\s?ASH/.test(hay)) block_type = 'Fly ash brick';
  else if (/HOLLOW/.test(hay)) block_type = 'Concrete hollow block';
  else if (/SOLID.*(BLOCK|CONCRETE)|CONCRETE.*SOLID|CEMENT BLOCK|SOLID BLOCK/.test(hay)) block_type = 'Concrete solid block';
  else if (/RED\s?(CLAY\s?)?BRICK|CLAY\s?BRICK|WIRE\s?CUT|TABLE\s?MOULD|\bBRICK\b/.test(hay)) block_type = 'Red clay brick';
  else if (/BLOCK/.test(hay)) block_type = 'Concrete solid block';
  L.resolve(fi('block_type', 'Type'), { quoted: () => block_type });

  const sizeRaw = specGet(s, 'Size', 'Dimension', 'Size (Inches)', 'Block Size', 'Brick Size');
  let size_mm: string | null = null;
  const sm = `${sizeRaw ?? ''} ${raw.title}`.match(/(\d{2,4})\s*[xX×*]\s*(\d{2,4})\s*[xX×*]\s*(\d{2,4})/);
  if (sm) size_mm = `${sm[1]}×${sm[2]}×${sm[3]}`;
  L.resolve(fi('size_mm', 'Size', 'mm'), {
    quoted: () => size_mm,
    typical: () =>
      block_type === 'Red clay brick'
        ? { value: '230×110×75', basis: 'The IS 1077 modular brick. Representative, not quoted — local kiln sizes vary by lot.' }
        : block_type === 'AAC block'
          ? { value: '600×200×100', basis: 'The most common AAC partition block. Representative, not quoted.' }
          : null,
  });

  const strRaw = specGet(s, 'Compressive Strength', 'Strength', 'Crushing Strength');
  L.resolve(fi('compressive_strength_nmm2', 'Compressive strength', 'N/mm²'), { quoted: () => numOf(strRaw) });

  const densRaw = specGet(s, 'Density', 'Dry Density');
  L.resolve(fi('density_kg_m3', 'Density', 'kg/m³'), {
    quoted: () => numOf(densRaw),
    typical: () =>
      block_type === 'AAC block' ? { value: 600, basis: 'AAC dry density typically 550–650 kg/m³. Representative, not quoted.' }
        : block_type === 'Red clay brick' ? { value: 1900, basis: 'Burnt clay brick bulk density ~1,900 kg/m³. Representative, not quoted.' }
          : null,
  });

  const flyRaw = specGet(s, 'Fly Ash', 'Fly Ash Content', 'Fly Ash Percentage');
  // Only take the 12% GST concession on published evidence. Silence is not
  // evidence, and under-charging tax is the worse error.
  L.resolve(fi('fly_ash_pct', 'Fly ash content', '%'), { quoted: () => numOf(flyRaw) });

  const finish = specGet(s, 'Finish', 'Surface Finish', 'Type');
  if (block_type === 'Red clay brick' && finish) L.quoted(fi('finish', 'Finish'), finish);

  // Read the size back through the ladder, so a `typical` standard size counts
  // as a resolved attribute for identity. Otherwise every clay brick stays
  // unresolved and no two sellers' bricks ever merge into one product.
  size_mm = L.value('size_mm');

  // Volume per piece, which drives volumetric freight weight.
  const dims = size_mm?.split('×').map(Number);
  const vol = dims && dims.length === 3 ? +((dims[0] * dims[1] * dims[2]) / 1e9).toFixed(6) : null;
  if (vol) {
    L.derived(fi('unit_volume_m3', 'Volume per piece', 'm³'), vol,
      `${size_mm} mm = ${dims![0]}×${dims![1]}×${dims![2]} / 1e9 = ${vol} m³`);
  }

  return {
    block_type, size_mm, compressive_strength_nmm2: L.numeric('compressive_strength_nmm2'),
    density_kg_m3: L.numeric('density_kg_m3'), fly_ash_pct: L.numeric('fly_ash_pct'),
    finish: block_type === 'Red clay brick' ? finish : null, unit_volume_m3: vol,
  };
}

// ── the main entry point ─────────────────────────────────────────────────────

const CANONICAL: Record<string, string> = {
  cement: 'bag', tmt_steel: 'kg', water_pipes: 'running_metre', bricks_blocks: 'piece',
};

/**
 * Category guard.
 *
 * Platforms file adjacent products under a category — BigBMart lists
 * "UltraTech Weather Pro WP+200", a waterproofing compound, under Cement.
 * Without this guard the missing-data ladder cheerfully applies the `typical`
 * 50 kg bag to it and produces a ₹182/bag "cement" that undercuts every real
 * bag on the page. That is a wrong price shown as right, which is the one
 * outcome this engine may never produce.
 *
 * So a listing whose title names a different product class is refused and the
 * refusal is counted, rather than being coerced into the category it was
 * filed under.
 */
const NOT_THIS_CATEGORY: Record<string, RegExp> = {
  cement: /waterproof|water proof|wp\+|putty|grout|adhesive|admixture|compound|bond|primer|sealant|plaster|mortar|tile\s?fix|repair|paint|sand\b|aggregate/i,
  tmt_steel: /scrap|wire\s?mesh|binding\s?wire|nail|welding|almirah|furniture|utensil|pipe|tube|sheet|angle|channel/i,
  water_pipes: /conduit|electric|cable|casing|column\s?pipe|duct|machine|scrap|adhesive|solvent|cement\b/i,
  bricks_blocks: /sand\b|aggregate|machine|mould|adhesive|mortar|plaster|paver\s?machine|putty/i,
};

export function normalise(raw: RawOffer): Normalised | { ok: false; reason: string } {
  if (raw.price_paise == null || raw.price_paise <= 0) {
    return { ok: false, reason: 'no published price' };
  }
  const guard = NOT_THIS_CATEGORY[raw.category];
  if (guard && guard.test(raw.title)) {
    return { ok: false, reason: `listed under ${raw.category} but the title names a different product class` };
  }
  const u = normaliseUnit(raw.price_unit);
  if (!u) return { ok: false, reason: `unmappable unit "${raw.price_unit ?? '(none)'}"` };

  const L = new Ladder();
  const fi = (field: string, label: string, unit?: string) => ({
    field, label, unit: unit ?? null, source_url: raw.source_url, fetched_at: raw.fetched_at,
  });

  const category = raw.category;
  const brand = detectBrand(category, raw.brand, raw.title, JSON.stringify(raw.specs));
  if (brand) L.quoted(fi('brand', 'Brand'), brand);

  let attrs: Record<string, any>;
  switch (category) {
    case 'cement': attrs = cementAttrs(raw, L, fi); break;
    case 'tmt_steel': attrs = tmtAttrs(raw, L, fi); break;
    case 'water_pipes': attrs = pipeAttrs(raw, L, fi); break;
    case 'bricks_blocks': attrs = brickAttrs(raw, L, fi); break;
    default: return { ok: false, reason: `unknown category ${category}` };
  }

  // Commercial attributes apply to every category and are merged after the
  // per-category pass, so a category extractor that already resolved one of
  // these properly (brick `finish` from a size string, say) keeps its version.
  const commercial = commercialAttrs(raw, L, fi);
  for (const [k, v] of Object.entries(commercial.attrs)) {
    if (attrs[k] == null) attrs[k] = v;
  }

  const canonical = CANONICAL[category];

  // ── convert the quoted price to one canonical unit ─────────────────────────
  let basePerCanonical: number | null = null;
  let conversionNote = '';
  const quotedUnit = u.unit;
  const quotedPaise = Math.round(raw.price_paise * u.perCanonical); // feet→metre etc.

  // Cement is handled before the generic same-unit shortcut: "bag" is not
  // dimensionless, so a per-bag quote still needs its pack size resolved
  // against the standard 50 kg bag. See cementCanonicalPaise.
  if (category === 'cement') {
    const conv = cementCanonicalPaise(quotedPaise, quotedUnit, attrs.pack_size_kg ?? null);
    if (conv) { basePerCanonical = conv.paise; conversionNote = conv.note; }
  } else if (quotedUnit === canonical) {
    basePerCanonical = quotedPaise;
    conversionNote = 'seller already quotes in the canonical unit';
  } else if (category === 'tmt_steel') {
    if (quotedUnit === 'tonne') { basePerCanonical = Math.round(quotedPaise / 1000); conversionNote = '₹/tonne ÷ 1000'; }
    else if (quotedUnit === 'quintal') { basePerCanonical = Math.round(quotedPaise / 100); conversionNote = '₹/quintal ÷ 100'; }
    else if (quotedUnit === 'piece' && attrs.rod_weight_kg) {
      basePerCanonical = Math.round(quotedPaise / attrs.rod_weight_kg);
      conversionNote = `₹/rod ÷ ${attrs.rod_weight_kg} kg (${attrs.diameter_mm} mm × ${attrs.length_m} m, IS 1786 nominal mass)`;
    } else if (quotedUnit === 'running_metre' && attrs.kg_per_m) {
      basePerCanonical = Math.round(quotedPaise / attrs.kg_per_m);
      conversionNote = `₹/m ÷ ${attrs.kg_per_m} kg/m`;
    }
  } else if (category === 'water_pipes') {
    const len = attrs.length_m ?? 3;
    if (quotedUnit === 'piece' || quotedUnit === 'length') {
      basePerCanonical = Math.round(quotedPaise / len);
      conversionNote = `₹/length ÷ ${len} m — the competitor failure this removes: a 3 m pipe and a 6 m pipe cannot share a price band`;
    } else if (quotedUnit === 'coil') { basePerCanonical = Math.round(quotedPaise / 100); conversionNote = '₹/coil ÷ 100 m'; }
  } else if (category === 'bricks_blocks') {
    if (quotedUnit === 'per_1000') { basePerCanonical = Math.round(quotedPaise / 1000); conversionNote = '₹/1000 ÷ 1000'; }
    else if (quotedUnit === 'cum' && attrs.unit_volume_m3) {
      basePerCanonical = Math.round(quotedPaise * attrs.unit_volume_m3);
      conversionNote = `₹/m³ × ${attrs.unit_volume_m3} m³ per piece (from ${attrs.size_mm} mm)`;
    } else if (quotedUnit === 'sqft') {
      return { ok: false, reason: 'quoted per sqft — needs a wall-thickness assumption we will not make' };
    }
  }

  if (basePerCanonical == null || basePerCanonical <= 0) {
    return { ok: false, reason: `cannot convert ₹/${quotedUnit} to ₹/${canonical} without inventing an attribute` };
  }

  L.derived(fi('normalised_base', `Seller price per ${canonical}`, canonical),
    (basePerCanonical / 100).toFixed(2), `${raw.price_text} → ${conversionNote}`);

  // ── unit weight, for the freight model ─────────────────────────────────────
  let unit_weight_kg: number | null = null;
  // The canonical unit weighs 50 kg by definition, and freight is amortised per
  // canonical unit — so a 25 kg pack priced per standard bag must also carry the
  // freight of a standard bag, or the landed figure mixes two bases again.
  // The pack actually shipped stays in attrs.pack_size_kg for the card to state.
  if (category === 'cement') unit_weight_kg = CEMENT_STANDARD_BAG_KG;
  else if (category === 'tmt_steel') unit_weight_kg = 1;
  else if (category === 'water_pipes') unit_weight_kg = 0.42;   // per running metre, 25 mm class
  else if (category === 'bricks_blocks') {
    const key = `bricks_blocks:${(attrs.block_type ?? '').toLowerCase().replace(/[^a-z]/g, '_')}`;
    unit_weight_kg =
      TYPICAL_UNIT_KG[`${key}:${attrs.size_mm?.replace(/×/g, 'x')}`] ??
      (attrs.unit_volume_m3 && attrs.density_kg_m3 ? +(attrs.unit_volume_m3 * attrs.density_kg_m3).toFixed(2) : null) ??
      3.1;
    if (attrs.unit_volume_m3 && attrs.density_kg_m3) {
      L.derived(fi('unit_weight_kg', 'Weight per piece', 'kg'), unit_weight_kg,
        `${attrs.unit_volume_m3} m³ × ${attrs.density_kg_m3} kg/m³`);
    }
  }

  // ── certification ──────────────────────────────────────────────────────────
  const certHay = `${raw.title} ${JSON.stringify(raw.specs)} ${raw.cert_text ?? ''}`;
  const licence = certHay.match(/CM\s*\/?\s*L\s*-?\s*\d{6,}/i)?.[0] ?? null;
  const qco = category === 'cement' || category === 'tmt_steel';
  let cert_state: Normalised['cert_state'];
  if (licence) cert_state = 'CERTIFIED';
  else if (qco && brand) cert_state = 'BRAND_LICENSED';
  else if (category === 'bricks_blocks' && !brand) cert_state = 'NOT_APPLICABLE';
  else cert_state = 'NOT_DECLARED';
  L.quoted(fi('cert_state', 'BIS licence'),
    cert_state === 'CERTIFIED' ? `Licence ${licence}`
      : cert_state === 'BRAND_LICENSED' ? 'BIS-licensed brand, licence number not quoted on this listing'
        : cert_state === 'NOT_APPLICABLE' ? 'BIS certification does not apply to this product'
          : 'No BIS mark declared');

  // ── identity: precision-first ──────────────────────────────────────────────
  //
  // Two offers merge into one product only when their full identifying tuple
  // agrees. A missed match costs one comparison row; a wrong match bills the
  // wrong item into a cart and onto an invoice, so the asymmetry is total.
  //
  // The distinction that matters here is between an attribute that is MISSING
  // and one that is NOT APPLICABLE. PPC and PSC carry no grade in the sense OPC
  // does, and CPVC has no uPVC pressure class — treating those absences as
  // "unresolved" would stop every seller's PPC bag from ever merging, which
  // would leave the vendor table permanently one row long.
  const NA = '~na';
  const keyParts: string[] = [category, brand ?? 'unbranded'];
  const required: Array<string | null> = [];

  if (category === 'cement') {
    keyParts.push(attrs.cement_type, String(attrs.pack_size_kg));
    required.push(attrs.cement_type, String(attrs.pack_size_kg));
    // Grade is part of the identity only where the type actually has one.
    keyParts.push(attrs.cement_type === 'OPC' ? (attrs.opc_grade ?? null) as any : NA);
    if (attrs.cement_type === 'OPC') required.push(attrs.opc_grade ?? null);
  }
  if (category === 'tmt_steel') {
    keyParts.push(String(attrs.diameter_mm ?? ''), attrs.grade ?? '');
    required.push(attrs.diameter_mm ? String(attrs.diameter_mm) : null, attrs.grade ?? null);
  }
  if (category === 'water_pipes') {
    const cls = attrs.sdr ?? attrs.pressure_class ?? attrs.swr_type ?? attrs.gi_class ?? attrs.pe_grade ?? null;
    keyParts.push(attrs.pipe_system ?? '', String(attrs.nominal_bore_mm ?? ''), cls ?? NA, String(attrs.length_m));
    required.push(attrs.pipe_system ?? null, attrs.nominal_bore_mm ? String(attrs.nominal_bore_mm) : null);
  }
  if (category === 'bricks_blocks') {
    keyParts.push(attrs.block_type ?? '', attrs.size_mm ?? '');
    required.push(attrs.block_type ?? null, attrs.size_mm ?? null);
  }

  const unresolved = required.some((p) => p === null || p === '' || p === 'null' || p === 'undefined');
  const item_code = unresolved
    ? `${keyParts.map((p) => p ?? NA).join('|')}|UNRESOLVED:${raw.source_ref}`
    : keyParts.map((p) => p ?? NA).join('|');

  const title = buildTitle(category, brand, attrs, raw);

  return {
    ok: true,
    category,
    item_code,
    product_id: `p_${hash(item_code)}`,
    title,
    brand,
    attrs,
    country_of_origin: commercial.country_of_origin,
    unit_canonical: canonical,
    unit_trade: quotedUnit,
    pack_size: category === 'cement' ? attrs.pack_size_kg : null,
    pack_unit: category === 'cement' ? 'kg' : null,
    unit_weight_kg,
    unit_volume_m3: attrs.unit_volume_m3 ?? null,
    base_paise_per_canonical: basePerCanonical,
    base_paise_trade: quotedPaise,
    ladder: L,
    cert_state,
    cert_ref: licence,
  };
}

/** Deterministic from attributes, never free text. */
function buildTitle(category: string, brand: string | null, a: Record<string, any>, raw: RawOffer): string {
  const b = brand ?? 'Unbranded';
  switch (category) {
    case 'cement': {
      const g = a.opc_grade ? ` ${a.opc_grade.replace(' grade', '')} grade` : '';
      return `${b} ${a.cement_type}${g} cement — ${a.pack_size_kg} kg bag`;
    }
    case 'tmt_steel':
      return `${b} TMT bar ${a.diameter_mm ?? '?'} mm ${a.grade ?? ''}`.replace(/\s+/g, ' ').trim() +
        (a.length_m ? ` × ${a.length_m} m` : '');
    case 'water_pipes': {
      const cls = a.sdr ?? a.pressure_class ?? a.swr_type ?? a.gi_class ?? a.pe_grade ?? '';
      return `${b} ${a.pipe_system ?? 'pipe'} ${a.nominal_bore_mm ?? '?'} mm ${cls} × ${a.length_m} m`.replace(/\s+/g, ' ').trim();
    }
    case 'bricks_blocks':
      return `${b} ${a.block_type ?? 'block'}${a.size_mm ? ` ${a.size_mm} mm` : ''}`.replace(/\s+/g, ' ').trim();
    default:
      return raw.title;
  }
}
