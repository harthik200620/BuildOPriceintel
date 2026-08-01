/**
 * GST rates as effective-dated data, never constants in code.
 *
 * The 56th GST Council's Notification 9/2025-Central Tax (Rate) dated
 * 2025-09-17 (effective 2025-09-22) moved cement from 28% to 18% overnight.
 * A rate compiled into TypeScript would have made every quote wrong by ten
 * points until someone shipped a release. So these are rows, with citations
 * and effective dates, seeded into the `gst_rate` table.
 */

export interface GstRow {
  hsn: string;
  category: string;
  rate_bp: number;
  effective_from: string;
  effective_to: string | null;
  citation: string;
  label: 'VERIFIED' | 'INFERRED' | 'ASSUMPTION';
  note: string | null;
}

const N9 = 'Notification 9/2025-Central Tax (Rate), 2025-09-17, effective 2025-09-22';

export const GST_RATES: GstRow[] = [
  { hsn: '2523', category: 'cement', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Cement OPC/PPC/PSC. Was 28% until 2025-09-21 — Schedule II @ 9% CGST.' },
  { hsn: '2523', category: 'cement', rate_bp: 2800, effective_from: '2017-07-01', effective_to: '2025-09-21',
    citation: 'Notification 1/2017-CT(R)', label: 'VERIFIED', note: 'Superseded. Retained so a historic quote still reprices correctly.' },

  { hsn: '7213', category: 'tmt_steel', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Hot-rolled bars and rods in irregularly wound coils.' },
  { hsn: '7214', category: 'tmt_steel', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Other bars and rods of iron or non-alloy steel — the TMT heading.' },

  { hsn: '3917', category: 'water_pipes', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Tubes, pipes and hoses of plastics — covers PVC, CPVC, UPVC, SWR and their fittings.' },
  { hsn: '7306', category: 'water_pipes', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Other tubes and pipes of iron or steel — the GI pipe heading.' },
  { hsn: '3917', category: 'water_pipes_hdpe', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'HDPE pipe sits in the same plastics heading.' },

  { hsn: '6904', category: 'bricks_blocks_clay', rate_bp: 1200, effective_from: '2022-04-01', effective_to: null,
    citation: 'Notification 14/2025; 12% with ITC or 6% under the composition option without ITC',
    label: 'VERIFIED',
    note: 'The 5% figure still repeated across the web died on 2022-04-01. Using it would systematically under-price every BOQ built on clay brick.' },
  { hsn: '6815', category: 'bricks_blocks_flyash', rate_bp: 1200, effective_from: '2022-04-01', effective_to: null,
    citation: 'Notification 14/2025', label: 'VERIFIED', note: 'Fly-ash bricks and blocks.' },
  { hsn: '6815', category: 'bricks_blocks_aac_high_flyash', rate_bp: 1200, effective_from: '2023-01-01', effective_to: null,
    citation: '55th GST Council clarification — AAC blocks with fly ash content above 50%',
    label: 'ASSUMPTION',
    note: 'Requires a fly_ash_pct SKU attribute to apply. Where the seller does not publish the percentage we rate at the HIGHER slab (6810, 18%) rather than assume the concession — under-charging tax is the worse error.' },
  { hsn: '6810', category: 'bricks_blocks_aac', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Articles of cement or concrete — AAC at or below 50% fly ash, and concrete blocks.' },
  { hsn: '6810', category: 'bricks_blocks_concrete', rate_bp: 1800, effective_from: '2025-09-22', effective_to: null,
    citation: N9, label: 'VERIFIED', note: 'Solid and hollow concrete blocks, CLC blocks.' },
];

/**
 * Resolve the rate in force for an HSN + category on a given date.
 * Returns null rather than a default — a missing rate must block the quote
 * (failure mode F10), not silently pick 18%.
 */
export function resolveGstRate(
  rows: GstRow[],
  hsn: string,
  category: string,
  asOf: string,
): GstRow | null {
  const day = asOf.slice(0, 10);
  const matches = rows.filter(
    (r) =>
      r.hsn === hsn &&
      r.category === category &&
      r.effective_from <= day &&
      (r.effective_to === null || r.effective_to >= day),
  );
  if (!matches.length) return null;
  return matches.sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1))[0];
}

/**
 * Which (hsn, category) key a product uses. Bricks are the interesting case:
 * the fly-ash percentage decides the tax rate, not just the recipe.
 */
export function gstKeyFor(category: string, attrs: Record<string, unknown>): { hsn: string; key: string } {
  switch (category) {
    case 'cement':
      return { hsn: '2523', key: 'cement' };
    case 'tmt_steel':
      return { hsn: '7214', key: 'tmt_steel' };
    case 'water_pipes':
      return attrs.pipe_system === 'GI'
        ? { hsn: '7306', key: 'water_pipes' }
        : { hsn: '3917', key: 'water_pipes' };
    case 'bricks_blocks': {
      const t = String(attrs.block_type ?? '');
      if (t === 'Red clay brick') return { hsn: '6904', key: 'bricks_blocks_clay' };
      if (t === 'Fly ash brick') return { hsn: '6815', key: 'bricks_blocks_flyash' };
      if (t === 'AAC block') {
        const flyAsh = attrs.fly_ash_pct;
        // Only take the 12% concession on published evidence of >50% fly ash.
        if (typeof flyAsh === 'number' && flyAsh > 50) {
          return { hsn: '6815', key: 'bricks_blocks_aac_high_flyash' };
        }
        return { hsn: '6810', key: 'bricks_blocks_aac' };
      }
      return { hsn: '6810', key: 'bricks_blocks_concrete' };
    }
    default:
      return { hsn: '0000', key: category };
  }
}
