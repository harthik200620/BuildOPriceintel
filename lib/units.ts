/**
 * Unit intelligence.
 *
 * The market's failure here is the whole product opportunity. IndiaMART ships
 * seven pricing units on one sand page (₹2,500/Tonne next to ₹70/CFT — a 2x
 * discrepancy hidden entirely by unit mismatch). BigBMart ships "River Sand
 * ₹2,450" with no unit at all, where per-tonne and per-brass differ ~4.5x.
 *
 * Two rules this module exists to hold:
 *   1. Conversions are PER CATEGORY. 1" CPVC is 25 mm nominal bore but 4" SWR
 *      is 110 mm OD. Naive x25.4 gets both wrong. It is a table, never arithmetic.
 *   2. Every SKU maps to exactly one canonical unit, and it is NOT NULL.
 */

export const CANONICAL_UNITS = [
  'kg', 'tonne', 'bag', 'litre', 'running_metre', 'sqm', 'cum', 'cft',
  'brass', 'piece', 'box', 'coil', 'length',
] as const;
export type CanonicalUnit = (typeof CANONICAL_UNITS)[number];

export const UNIT_LABEL: Record<string, string> = {
  kg: '/kg',
  tonne: '/tonne',
  bag: '/bag',
  litre: '/litre',
  running_metre: '/metre',
  sqm: '/m²',
  cum: '/m³',
  cft: '/cft',
  brass: '/brass',
  piece: '/piece',
  box: '/box',
  coil: '/coil',
  length: '/length',
};

/** Spoken form, for screen readers — every number is labelled with its unit. */
export const UNIT_SPOKEN: Record<string, string> = {
  kg: 'per kilogram',
  tonne: 'per tonne',
  bag: 'per bag',
  litre: 'per litre',
  running_metre: 'per running metre',
  sqm: 'per square metre',
  cum: 'per cubic metre',
  cft: 'per cubic foot',
  brass: 'per brass',
  piece: 'per piece',
  box: 'per box',
  coil: 'per coil',
  length: 'per length',
};

export const CATEGORY_CANONICAL_UNIT: Record<string, CanonicalUnit> = {
  cement: 'bag',
  tmt_steel: 'kg',
  water_pipes: 'running_metre',
  bricks_blocks: 'piece',
};

/**
 * The seed rows for unit_conversion. `category: '*'` means the factor is
 * genuinely universal (pure dimensional arithmetic); anything else is a trade
 * convention that only holds inside that category.
 */
export interface ConversionRow {
  from_unit: string;
  to_unit: string;
  category: string;
  factor: number;
  note: string | null;
  source_url: string;
  confidence: 'quoted' | 'derived' | 'typical' | 'unknown';
}

export const UNIT_CONVERSIONS: ConversionRow[] = [
  { from_unit: 'bag', to_unit: 'tonne', category: 'cement', factor: 0.05,
    note: '50 kg bag; 20 bags = 1 tonne', source_url: 'https://www.pred.telangana.gov.in/steel_cement_rates.php', confidence: 'quoted' },
  { from_unit: 'bag', to_unit: 'kg', category: 'cement', factor: 50,
    note: 'standard 50 kg bag under LMPC Rule 3(a)', source_url: 'https://www.pred.telangana.gov.in/steel_cement_rates.php', confidence: 'quoted' },
  { from_unit: 'tonne', to_unit: 'kg', category: '*', factor: 1000,
    note: null, source_url: 'SI definition', confidence: 'quoted' },
  { from_unit: 'quintal', to_unit: 'kg', category: '*', factor: 100,
    note: 'the unit most AP/TS steel dealers quote in', source_url: 'SI definition', confidence: 'quoted' },
  { from_unit: 'length', to_unit: 'running_metre', category: 'water_pipes', factor: 3.0,
    note: 'CPVC/UPVC/SWR standard length is 3 m; GI is 6 m — length_m is a per-SKU attribute and overrides this default',
    source_url: 'https://www.astralpipes.com/', confidence: 'typical' },
  { from_unit: 'coil', to_unit: 'running_metre', category: 'water_pipes', factor: 100,
    note: 'HDPE coil, commonly 100 m; varies 50–300 m by bore — overridden by the SKU attribute where published',
    source_url: 'https://www.finolexpipes.com/', confidence: 'typical' },
  { from_unit: 'cft', to_unit: 'cum', category: '*', factor: 0.0283168,
    note: null, source_url: 'SI definition', confidence: 'quoted' },
  { from_unit: 'brass', to_unit: 'cft', category: '*', factor: 100,
    note: '1 unit = 1 brass = 100 CFT', source_url: 'Indian trade convention', confidence: 'quoted' },
  { from_unit: 'per_1000', to_unit: 'piece', category: 'bricks_blocks', factor: 1000,
    note: 'brick and block supply is quoted per 1,000 as often as per piece',
    source_url: 'https://dir.indiamart.com/', confidence: 'quoted' },
  { from_unit: 'cum', to_unit: 'piece', category: 'bricks_blocks', factor: 0,
    note: 'DERIVED PER SKU from block dimensions — 1/(l*w*h in m). Factor 0 here means "compute it, never assume it".',
    source_url: 'derived from size attribute', confidence: 'derived' },
];

/**
 * Nominal bore, in the trade's own words. This is the table D10 insists on:
 * "the inch->mm mapping is a table, not arithmetic — 1" CPVC is 25 mm nominal
 * but 4" SWR is 110 mm OD, and naive multiplication gets both wrong."
 */
export const BORE_TABLE: Array<{ inch: string; mm: number; system?: string; basis: string }> = [
  { inch: '1/2', mm: 15, basis: 'nominal bore' },
  { inch: '3/4', mm: 20, basis: 'nominal bore' },
  { inch: '1', mm: 25, basis: 'nominal bore' },
  { inch: '1.25', mm: 32, basis: 'nominal bore' },
  { inch: '1.5', mm: 40, basis: 'nominal bore' },
  { inch: '1.75', mm: 50, basis: 'nominal bore' },
  { inch: '2', mm: 63, basis: 'nominal bore' },
  { inch: '2.5', mm: 75, basis: 'nominal bore' },
  { inch: '3', mm: 90, basis: 'nominal bore' },
  { inch: '4', mm: 110, system: 'SWR', basis: 'outside diameter — NOT 4 x 25.4' },
  { inch: '4', mm: 110, basis: 'outside diameter' },
  { inch: '6', mm: 160, basis: 'outside diameter' },
  { inch: '8', mm: 200, basis: 'outside diameter' },
];

export function inchToBoreMm(inch: string | number): number | null {
  const key = String(inch);
  const row = BORE_TABLE.find((r) => r.inch === key);
  return row ? row.mm : null;
}

export function boreMmToInch(mm: number): string | null {
  const row = BORE_TABLE.find((r) => r.mm === mm);
  if (!row) return null;
  const map: Record<string, string> = { '1/2': '½', '3/4': '¾', '1.25': '1¼', '1.5': '1½', '1.75': '1¾', '2.5': '2½' };
  return map[row.inch] ?? row.inch;
}

/**
 * Nominal mass per metre of TMT bar by diameter, per IS 1786 / IS 1732.
 * Used to convert a rod count into a tonnage and a per-rod price into ₹/kg.
 */
export const TMT_KG_PER_M: Record<number, number> = {
  6: 0.222, 8: 0.395, 10: 0.617, 12: 0.888, 16: 1.578,
  20: 2.466, 25: 3.854, 28: 4.834, 32: 6.313, 36: 7.99, 40: 9.864,
};

export function tmtRodWeightKg(diameterMm: number, lengthM = 12): number | null {
  const kgPerM = TMT_KG_PER_M[diameterMm];
  return kgPerM ? +(kgPerM * lengthM).toFixed(3) : null;
}

/**
 * The canonical cement bag is 50 kg — LMPC Rule 3(a), and the basis every
 * Indian cement price is quoted against.
 *
 * "bag" is not a dimensionless unit, and treating it as one is a basis error
 * wearing the trade's own word. A 1 kg pack quoted at ₹150/bag and a 50 kg bag
 * quoted at ₹380/bag are not two prices for the same thing, and ranking them
 * against each other put a ₹150 novelty pack of white cement at the top of a
 * search for "cement" — cheaper-looking than every real bag in the city.
 *
 * So every route to the canonical price goes through here, and every one of
 * them lands on the same basis: one standard 50 kg bag.
 */
export const CEMENT_STANDARD_BAG_KG = 50;

export function cementCanonicalPaise(
  quotedPaise: number,
  quotedUnit: string,
  packKg: number | null,
): { paise: number; note: string } | null {
  const B = CEMENT_STANDARD_BAG_KG;
  switch (quotedUnit) {
    case 'kg':
      return { paise: Math.round(quotedPaise * B), note: `₹/kg × ${B} kg per standard bag` };
    case 'tonne':
      return { paise: Math.round((quotedPaise * B) / 1000), note: `₹/tonne ÷ 1000 × ${B} kg per standard bag` };
    case 'quintal':
      return { paise: Math.round((quotedPaise * B) / 100), note: `₹/quintal ÷ 100 × ${B} kg per standard bag` };
    case 'bag':
    case 'piece': {
      // A bag of an unstated size is read as the standard bag, which is what
      // the trade means by an unqualified "bag". A stated size is rescaled.
      const pack = packKg && packKg > 0 ? packKg : B;
      if (pack === B) {
        return {
          paise: quotedPaise,
          note: quotedUnit === 'piece'
            ? 'seller quotes "per piece" for a bagged product — read as one standard bag'
            : 'seller already quotes per standard 50 kg bag',
        };
      }
      return {
        paise: Math.round(quotedPaise * (B / pack)),
        note: `₹${(quotedPaise / 100).toFixed(2)} per ${pack} kg bag × ${B}/${pack} → one standard ${B} kg bag`,
      };
    }
    default:
      return null;
  }
}

/** Typical unit mass, used only on the `derived` rung of the missing-data ladder. */
export const TYPICAL_UNIT_KG: Record<string, number> = {
  'cement:bag:50': 50,
  'cement:bag:25': 25,
  'bricks_blocks:red_clay': 3.1,
  'bricks_blocks:fly_ash': 3.0,
  'bricks_blocks:aac:600x200x100': 8.4,
  'bricks_blocks:aac:600x200x150': 12.6,
  'bricks_blocks:aac:600x200x200': 16.8,
  'bricks_blocks:aac:600x200x75': 6.3,
  'bricks_blocks:concrete_solid:400x200x100': 16.0,
  'bricks_blocks:concrete_solid:400x200x150': 24.0,
  'bricks_blocks:concrete_solid:400x200x200': 32.0,
  'bricks_blocks:concrete_hollow:400x200x200': 18.0,
};

/** Bulk density in kg/m³, for the volumetric-weight side of the freight model. */
export const TYPICAL_DENSITY_KG_M3: Record<string, number> = {
  cement: 1440,
  tmt_steel: 7850,
  water_pipes: 1450,
  bricks_blocks_clay: 1900,
  bricks_blocks_aac: 600,
  bricks_blocks_concrete: 2000,
};

/**
 * Convert a price expressed per `fromUnit` into a price per `toUnit`.
 * Returns null rather than guessing when the conversion is not in the table —
 * a wrong unit conversion is worse than a missing one.
 */
export function convertPricePerUnit(
  pricePaise: number,
  fromUnit: string,
  toUnit: string,
  category: string,
  rows: ConversionRow[],
  skuOverrides: Record<string, number> = {},
): { paise: number; factor: number; via: string } | null {
  if (fromUnit === toUnit) return { paise: pricePaise, factor: 1, via: 'identity' };

  const overrideKey = `${fromUnit}->${toUnit}`;
  if (skuOverrides[overrideKey]) {
    const f = skuOverrides[overrideKey];
    return { paise: Math.floor(pricePaise / f + 0.5), factor: f, via: 'sku attribute' };
  }

  const direct = rows.find(
    (r) => r.from_unit === fromUnit && r.to_unit === toUnit && (r.category === category || r.category === '*') && r.factor > 0,
  );
  if (direct) {
    // price per `from` / (units of `to` inside one `from`) = price per `to`
    return { paise: Math.floor(pricePaise / direct.factor + 0.5), factor: direct.factor, via: `${direct.from_unit}→${direct.to_unit}` };
  }

  const inverse = rows.find(
    (r) => r.from_unit === toUnit && r.to_unit === fromUnit && (r.category === category || r.category === '*') && r.factor > 0,
  );
  if (inverse) {
    return { paise: Math.floor(pricePaise * inverse.factor + 0.5), factor: 1 / inverse.factor, via: `${inverse.to_unit}→${inverse.from_unit} (inverted)` };
  }

  return null;
}
