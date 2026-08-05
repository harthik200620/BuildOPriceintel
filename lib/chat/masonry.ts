/**
 * Which masonry unit, for which wall.
 *
 * This table exists because of a specific wrong answer. `rank_by_quality` scores
 * on declared grade (40%), certification (25%), brand (15%) and how many sellers
 * carry it (20%). Bricks have **no grade field anywhere** — not in the schema,
 * not in the normaliser, not in the facets — and 94% of them sit at
 * `cert_state = NOT_APPLICABLE` because an unbranded kiln brick is not something
 * BIS licenses. So three of the four terms are constant, the score collapses to
 * vendor breadth alone, and the tool returned **the cheapest unbranded brick in
 * the catalogue as "#1 best quality"**.
 *
 * That is a hallucination produced by arithmetic rather than by the model, which
 * is exactly the class the fact ledger cannot catch: every number in it is real.
 *
 * The honest answer is that bricks are not graded the way cement is. What decides
 * a brick is what the wall has to do. That IS answerable, but only from published
 * standards — so this file follows `coefficients.ts` exactly: every entry carries
 * a confidence rung and a citation, and an entry with neither cannot be used.
 *
 * The rungs mean the same thing here as they do there, and the distinction is the
 * whole point of the file:
 *
 *   CODE   the standard establishes it. IS 1077 defines burnt clay brick classes
 *          by compressive strength; IS 2185 Pt 3 covers autoclaved aerated
 *          concrete. Citable, and not our opinion.
 *
 *   TRADE  universal Indian site practice that appears in no code. Real, worth
 *          saying, and labelled so nobody mistakes it for a specification.
 *
 * What is deliberately NOT here: any claim that one type is better than another
 * in the abstract, any strength figure attributed to a listing, and any climate
 * rule dressed up as a code requirement. No Indian standard specifies masonry by
 * city or by region, and pretending otherwise to make an answer land better would
 * be the same failure in a nicer suit.
 */

import type { CoeffConfidence } from './coefficients';

/** What a wall is being asked to do. The question behind "which brick". */
export type WallDuty =
  | 'load_bearing'
  | 'framed_infill'
  | 'external_envelope'
  | 'below_dpc'
  | 'compound_wall';

export const DUTY_LABEL: Record<WallDuty, string> = {
  load_bearing: 'Load-bearing wall — the wall carries the structure above it',
  framed_infill: 'Infill or partition in an RCC frame — the frame carries the load, the wall fills it',
  external_envelope: 'External wall, where heat gain through the envelope matters',
  below_dpc: 'Foundation, plinth or anything below the damp-proof course',
  compound_wall: 'Compound or boundary wall',
};

export interface MasonryGuidance {
  /** Matches the `block_type` values the normaliser assigns. */
  block_type: string;
  /** The standard that governs this unit type. */
  standard: string;
  standard_title: string;
  suited_to: WallDuty[];
  why: string;
  confidence: CoeffConfidence;
  citation: string;
  /** Stated when the type is a poor choice for a duty someone might assume it fits. */
  caution?: string;
}

/**
 * One entry per `block_type` the classifier can assign. The standards mapping
 * mirrors `certStandardsFor()` in `collector/run.ts` on purpose — if the two ever
 * disagree, the catalogue is telling a buyer one standard and the assistant
 * another.
 */
export const MASONRY_GUIDE: MasonryGuidance[] = [
  {
    block_type: 'Red clay brick',
    standard: 'IS 1077',
    standard_title: 'Common Burnt Clay Building Bricks — Specification',
    suited_to: ['load_bearing', 'framed_infill', 'below_dpc', 'compound_wall'],
    why:
      'IS 1077 classifies burnt clay bricks by compressive strength, starting at 3.5 N/mm² and rising in ' +
      'steps. It is the traditional load-bearing unit and the only one of these types the standard grades ' +
      'by strength class at all.',
    confidence: 'CODE',
    citation: 'IS 1077 — Common Burnt Clay Building Bricks',
    caution:
      'The class is a property of a tested consignment, not of a listing. No seller in this catalogue ' +
      'declares one.',
  },
  {
    block_type: 'AAC block',
    standard: 'IS 2185 Pt 3',
    standard_title: 'Concrete Masonry Units Part 3 — Autoclaved Cellular (Aerated) Concrete Blocks',
    suited_to: ['framed_infill', 'external_envelope'],
    why:
      'Autoclaved aerated concrete is a low-density cellular unit — the air voids are what make it both ' +
      'light and thermally insulating. In an RCC frame the wall carries no structural load, so the weight ' +
      'saving goes straight into a smaller dead load, and the insulation reduces heat gain through the ' +
      'envelope.',
    confidence: 'CODE',
    citation: 'IS 2185 Part 3 — Autoclaved Cellular (Aerated) Concrete Blocks',
    caution:
      'Not a load-bearing unit in ordinary residential practice, and it absorbs water readily — keep it ' +
      'above the damp-proof course.',
  },
  {
    block_type: 'Fly ash brick',
    standard: 'IS 12894',
    standard_title: 'Pulverized Fuel Ash-Lime Bricks — Specification',
    suited_to: ['framed_infill', 'load_bearing', 'compound_wall'],
    why:
      'A pulverised-fuel-ash and lime unit, moulded and cured rather than fired. It comes off the press to ' +
      'a tighter dimensional tolerance than a kiln brick, which is what makes the mortar joint thinner and ' +
      'the plaster coat lighter.',
    confidence: 'CODE',
    citation: 'IS 12894 — Pulverized Fuel Ash-Lime Bricks',
  },
  {
    block_type: 'Concrete solid block',
    standard: 'IS 2185 Pt 1',
    standard_title: 'Concrete Masonry Units Part 1 — Hollow and Solid Concrete Blocks',
    suited_to: ['load_bearing', 'below_dpc', 'compound_wall'],
    why:
      'A dense solid concrete unit. IS 2185 Part 1 covers it alongside hollow blocks and specifies grades ' +
      'for both load-bearing and non-load-bearing use.',
    confidence: 'CODE',
    citation: 'IS 2185 Part 1 — Hollow and Solid Concrete Blocks',
  },
  {
    block_type: 'Concrete hollow block',
    standard: 'IS 2185 Pt 1',
    standard_title: 'Concrete Masonry Units Part 1 — Hollow and Solid Concrete Blocks',
    suited_to: ['framed_infill', 'compound_wall'],
    why:
      'The voids cut the weight and the material per m² of wall, which is why a hollow block wall goes up ' +
      'faster and cheaper than a solid one of the same face area.',
    confidence: 'CODE',
    citation: 'IS 2185 Part 1 — Hollow and Solid Concrete Blocks',
    caution: 'Load-bearing use depends on the block grade, which no listing here declares.',
  },
  {
    block_type: 'CLC block',
    standard: 'IS 2185 Pt 4',
    standard_title: 'Concrete Masonry Units Part 4 — Preformed Foam Cellular Concrete Blocks',
    suited_to: ['framed_infill', 'external_envelope'],
    why:
      'Foamed cellular concrete — same lightweight, insulating idea as AAC but foam-formed and air-cured ' +
      'rather than autoclaved.',
    confidence: 'CODE',
    citation: 'IS 2185 Part 4 — Preformed Foam Cellular Concrete Blocks',
    caution: 'Non-load-bearing in ordinary practice, and it wants to stay dry.',
  },
];

/**
 * Hot-dry climate and the envelope.
 *
 * TRADE, not CODE, and the label is doing real work. **No Indian standard
 * specifies a masonry unit by city, by state or by climate zone.** Thermal
 * performance of the envelope is governed by ECBC and by IS 3792 for insulation
 * generally — neither of which says "use AAC in Hyderabad". This is the
 * engineering reason people reach for a cellular block on a hot-dry site, and it
 * is offered as that and nothing more.
 */
export const CLIMATE_NOTE = {
  confidence: 'TRADE' as CoeffConfidence,
  citation: 'Site practice — no Indian standard selects masonry by region',
  text:
    'Hyderabad and Vijayawada are both hot-dry. On an external wall a cellular block (AAC or CLC) cuts ' +
    'heat gain through the envelope in a way a dense clay or concrete unit does not, which is why they get ' +
    'specified for the outer skin of framed buildings here. That is a thermal argument, not a code ' +
    'requirement — no Indian standard picks a brick by city.',
};

/** Guidance for a duty, most relevant first. */
export function guidanceFor(duty: WallDuty): MasonryGuidance[] {
  return MASONRY_GUIDE.filter((g) => g.suited_to.includes(duty));
}

/** The duty a phrase is asking about, or null when it is not clear enough to guess. */
export function dutyFromText(text: string): WallDuty | null {
  const t = text.toLowerCase();
  if (/\b(?:below|under)\s+(?:dpc|damp|plinth)|\bfoundation\b|\bplinth\b|\bfooting\b/.test(t)) return 'below_dpc';
  if (/\bcompound\s+wall|\bboundary\s+wall|\bperimeter\s+wall/.test(t)) return 'compound_wall';
  if (/\bload[- ]?bearing\b|\bload\s+bearing\b/.test(t)) return 'load_bearing';
  if (/\bpartition\b|\binfill\b|\binternal\s+wall|\bnon[- ]?load/.test(t)) return 'framed_infill';
  if (/\bexternal\s+wall|\bouter\s+wall|\bfacade\b|\bheat\b|\bthermal\b|\binsulat/.test(t)) return 'external_envelope';
  return null;
}

/** The type a phrase names, so a question about one block does not answer about six. */
export function blockTypeFromText(text: string): string | null {
  const t = text.toLowerCase();
  if (/\baac\b|aerated|siporex/.test(t)) return 'AAC block';
  if (/\bclc\b|foam\s+concrete/.test(t)) return 'CLC block';
  if (/fly\s*-?\s*ash/.test(t)) return 'Fly ash brick';
  if (/hollow\s+block/.test(t)) return 'Concrete hollow block';
  if (/solid\s+block|cement\s+block|concrete\s+block/.test(t)) return 'Concrete solid block';
  if (/\bred\s+clay|\bclay\s+brick|\bwire\s*cut|\bkiln\b/.test(t)) return 'Red clay brick';
  return null;
}
