/**
 * Trade and multilingual vocabulary — maintained as data with tests, never as
 * model behaviour. An LLM that decides `4 inch` means 110 mm is inventing a
 * dimension; a table that says so is a fact with an owner.
 *
 * Four scripts per concept: Latin, Telugu, Devanagari, and the transliterations
 * people actually type on a phone keyboard on site.
 */

export interface VocabEntry {
  /** Canonical English term the index is built on. */
  canonical: string;
  category?: string;
  /** Every surface form that should reach `canonical`. */
  forms: string[];
  /** What it means, shown when a non-Latin or trade term is matched. */
  gloss: string;
  script: 'latin' | 'telugu' | 'devanagari' | 'mixed';
}

export const VOCAB: VocabEntry[] = [
  // ── cement ────────────────────────────────────────────────────────────────
  { canonical: 'cement', category: 'cement', script: 'mixed', gloss: 'cement',
    forms: ['cement', 'siment', 'sement', 'sementu', 'simentu', 'cementu',
      'సిమెంట్', 'సిమెంటు', 'सीमेंट', 'सिमेंट'] },
  { canonical: 'cement bag', category: 'cement', script: 'mixed', gloss: 'a bag of cement',
    forms: ['basta', 'బస్తా', 'bori', 'बोरी', 'cement bag', 'bag cement'] },
  { canonical: 'opc', category: 'cement', script: 'latin', gloss: 'Ordinary Portland Cement',
    forms: ['opc', 'ordinary portland', 'ordinary portland cement'] },
  { canonical: 'ppc', category: 'cement', script: 'latin', gloss: 'Portland Pozzolana Cement, fly-ash blended',
    forms: ['ppc', 'pozzolana', 'portland pozzolana', 'fly ash cement'] },
  { canonical: 'psc', category: 'cement', script: 'latin', gloss: 'Portland Slag Cement',
    forms: ['psc', 'slag cement', 'portland slag'] },

  // ── steel ─────────────────────────────────────────────────────────────────
  { canonical: 'tmt bar', category: 'tmt_steel', script: 'mixed', gloss: 'TMT reinforcement bar',
    forms: ['tmt', 'tmt bar', 'tmt bars', 'tmt rod', 'rebar', 're-bar', 'reinforcement steel',
      'reinforcement bar', 'steel bar', 'steel rod', 'iron rod', 'iron bar',
      'sariya', 'saria', 'sarya', 'सरिया', 'सरिया रेट',
      'kaddi', 'kaddhi', 'inupa kaddi', 'కడ్డీ', 'ఇనుప కడ్డీ', 'స్టీల్'] },
  { canonical: 'fe500', category: 'tmt_steel', script: 'latin', gloss: 'Fe 500 grade to IS 1786',
    forms: ['fe500', 'fe 500', 'fe-500', '500 grade steel'] },
  { canonical: 'fe500d', category: 'tmt_steel', script: 'latin', gloss: 'Fe 500D — controlled ductility, seismic zones',
    forms: ['fe500d', 'fe 500d', 'fe-500d', '500d'] },

  // ── pipes ─────────────────────────────────────────────────────────────────
  { canonical: 'pipe', category: 'water_pipes', script: 'mixed', gloss: 'pipe',
    forms: ['pipe', 'pipes', 'paip', 'paipu', 'pypu', 'पाइप', 'పైప్', 'పైపు', 'gottam', 'గొట్టం'] },
  { canonical: 'cpvc', category: 'water_pipes', script: 'latin', gloss: 'CPVC — hot & cold water, IS 15778',
    forms: ['cpvc', 'c pvc', 'hot water pipe'] },
  { canonical: 'upvc', category: 'water_pipes', script: 'latin', gloss: 'UPVC/PVC — cold water, IS 4985',
    forms: ['upvc', 'u pvc', 'pvc', 'pvc pipe', 'cold water pipe'] },
  { canonical: 'swr', category: 'water_pipes', script: 'latin', gloss: 'SWR — soil, waste and rainwater drainage, IS 13592',
    forms: ['swr', 'drainage pipe', 'soil pipe', 'waste pipe', 'sewage pipe'] },
  { canonical: 'gi pipe', category: 'water_pipes', script: 'latin', gloss: 'Galvanised iron pipe, IS 1239',
    forms: ['gi', 'gi pipe', 'galvanised', 'galvanized', 'g.i. pipe'] },
  { canonical: 'hdpe', category: 'water_pipes', script: 'latin', gloss: 'HDPE — underground mains and borewell, IS 4984',
    forms: ['hdpe', 'poly pipe', 'borewell pipe'] },

  // ── bricks and blocks ─────────────────────────────────────────────────────
  { canonical: 'brick', category: 'bricks_blocks', script: 'mixed', gloss: 'brick',
    forms: ['brick', 'bricks', 'itaka', 'itika', 'eeta', 'eta', 'ita', 'itukalu',
      'ఇటుక', 'ఇటుకలు', 'ईंट', 'eent', 'int'] },
  { canonical: 'aac block', category: 'bricks_blocks', script: 'mixed', gloss: 'Autoclaved aerated concrete block',
    forms: ['aac', 'aac block', 'aac blocks', 'aerated block', 'lightweight block',
      'ఏఏసీ బ్లాక్', 'siporex'] },
  { canonical: 'fly ash brick', category: 'bricks_blocks', script: 'latin', gloss: 'Fly ash brick, IS 12894',
    forms: ['fly ash brick', 'flyash brick', 'fly-ash brick', 'flyash'] },
  { canonical: 'concrete block', category: 'bricks_blocks', script: 'mixed', gloss: 'Concrete masonry block',
    forms: ['concrete block', 'cement block', 'solid block', 'hollow block', 'cement brick',
      'బ్లాక్', 'ब्लॉक'] },

  // ── price intent ──────────────────────────────────────────────────────────
  { canonical: 'price', script: 'mixed', gloss: 'price / rate',
    forms: ['price', 'rate', 'rates', 'cost', 'dhara', 'ధర', 'రేటు', 'retu',
      'bhav', 'भाव', 'daam', 'दाम', 'kimmat', 'कीमत', 'ధరలు'] },

  // ── other trade terms the sheet itself supplies ───────────────────────────
  { canonical: 'brass', script: 'latin', gloss: '1 brass = 100 CFT = 2.83 m³',
    forms: ['brass', 'brass sand'] },
  { canonical: 'farma', script: 'mixed', gloss: 'measuring box',
    forms: ['farma', 'pharma box', 'measuring box'] },
  { canonical: 'bullie', script: 'latin', gloss: 'wooden prop',
    forms: ['bullie', 'bulli', 'wooden prop', 'props'] },
  { canonical: 'chajja', script: 'mixed', gloss: 'sunshade',
    forms: ['chajja', 'chhajja', 'sunshade'] },
];

/**
 * Vocabulary terms that name a stored attribute value.
 *
 * `lookupTerm` resolved "opc" to the canonical token and the parser pushed it
 * into free text, where it only ever moved the lexical score. So "bangur opc
 * 53 grade" ranked the OPC bags first and then listed thirteen PPC and one PSC
 * underneath them — a different cement, a different IS code, and a different
 * pour, presented as the same answer.
 *
 * The values are the ones actually stored in product.attrs, read out of the
 * catalogue rather than guessed:
 *   cement_type   OPC · PPC · PSC · White cement · Sulphate resisting
 *   pipe_system   UPVC / PVC · CPVC · HDPE · SWR
 *   grade         Fe 550 · Fe 500 · Fe 550D · Fe 500D
 *   block_type    Concrete solid block · Fly ash brick · CLC block ·
 *                 Red clay brick · Concrete hollow block · AAC block
 *
 * Two are deliberately absent. 'concrete block' spans both the solid and the
 * hollow value, so binding it to either would silently drop half the stock;
 * 'brick' names the category, not a type. Both stay free text.
 *
 * 'gi pipe' IS bound even though the catalogue currently stocks no GI. A query
 * for it now falls to the relaxation ladder, which says so — better than the
 * UPVC and HDPE it used to answer with.
 */
export const TERM_CONSTRAINTS: Record<string, { key: string; value: string }> = {
  opc: { key: 'cement_type', value: 'OPC' },
  ppc: { key: 'cement_type', value: 'PPC' },
  psc: { key: 'cement_type', value: 'PSC' },
  cpvc: { key: 'pipe_system', value: 'CPVC' },
  upvc: { key: 'pipe_system', value: 'UPVC / PVC' },
  swr: { key: 'pipe_system', value: 'SWR' },
  hdpe: { key: 'pipe_system', value: 'HDPE' },
  'gi pipe': { key: 'pipe_system', value: 'GI' },
  fe500: { key: 'grade', value: 'Fe 500' },
  fe500d: { key: 'grade', value: 'Fe 500D' },
  'aac block': { key: 'block_type', value: 'AAC block' },
  'fly ash brick': { key: 'block_type', value: 'Fly ash brick' },
};

/** Brand aliases. Corrections are shown to the user, never applied silently. */
export const BRAND_ALIASES: Record<string, string> = {
  ultratec: 'UltraTech', ultratech: 'UltraTech', 'ultra tech': 'UltraTech', ultrateck: 'UltraTech',
  ambhuja: 'Ambuja', ambuja: 'Ambuja', ambuj: 'Ambuja',
  astrel: 'Astral', astral: 'Astral', astrall: 'Astral',
  asirvad: 'Ashirvad', ashirwad: 'Ashirvad', ashirvad: 'Ashirvad',
  finolx: 'Finolex', finolex: 'Finolex',
  supremo: 'Supreme', supreme: 'Supreme',
  tiscon: 'Tata Tiscon', tata: 'Tata Tiscon',
  neosteel: 'JSW Neosteel', jsw: 'JSW',
  vizag: 'Vizag', rinl: 'Vizag',
  magicret: 'Magicrete', magicrete: 'Magicrete',
  biltech: 'Biltech', aerocon: 'Aerocon', renacon: 'Renacon',
};

const _index = new Map<string, VocabEntry>();
for (const e of VOCAB) for (const f of e.forms) _index.set(f.toLowerCase(), e);

export function lookupTerm(token: string): VocabEntry | undefined {
  return _index.get(token.toLowerCase());
}

/** Every surface form for a canonical term — used to build the search blob. */
export function formsFor(canonical: string): string[] {
  return VOCAB.filter((e) => e.canonical === canonical).flatMap((e) => e.forms);
}

/**
 * All alternate-script and trade forms relevant to a category, so a product's
 * search blob matches `ఇటుక`, `itaka`, `eeta` and `sariya` as well as English.
 */
export function categoryForms(category: string): string[] {
  const out = new Set<string>();
  for (const e of VOCAB) {
    if (e.category === category || !e.category) for (const f of e.forms) out.add(f);
  }
  return [...out];
}
