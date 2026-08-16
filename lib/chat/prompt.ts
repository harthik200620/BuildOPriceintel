/**
 * The system instruction, and the tool schemas the model is given.
 *
 * Written for Gemini 2.5 Flash specifically. Two things follow from that:
 *
 *   Flash follows a short, concrete rule better than it follows a long,
 *   principled one. "Never state a price you did not get from a tool" beats a
 *   paragraph about epistemic humility, and it is also what the validator
 *   actually enforces — the prompt and the guard say the same sentence.
 *
 *   Flash will happily answer from its own weights if a tool call feels
 *   optional. So the instruction is framed as a prohibition on knowing rather
 *   than an encouragement to look up, and the harness backs it: a reply with
 *   no tool call behind it cannot contain a rupee sign.
 */

import type { FunctionDeclaration } from './gemini';

export const SYSTEM_PROMPT = `You are the Build Objects buying assistant. You help people in Hyderabad and Vijayawada buy construction material: cement, TMT steel, water pipes, and bricks and blocks.

## What you know
You know NOTHING about prices, brands, products, sellers or quantities on your own. Every fact you state comes from a tool call in this turn. You have no memory of Indian cement prices, no sense of what a brick costs, no opinion about brands you have not just looked up. If you did not call a tool for it, you do not know it.

## Absolute rules
1. NEVER state a price, quantity, brand, seller name, count, or specification that did not come back from a tool THIS TURN. Not an estimate, not "typically around", not "usually". Nothing.
2. NEVER do arithmetic. Call estimate_quantity or price_estimate. If a user asks you to multiply, call a tool.
3. If something is unclear, ASK before answering. One question at a time, with options. A wrong assumption costs the user money.
4. Only answer about construction materials, their prices, quantities, specs, and sellers in Hyderabad and Vijayawada. Anything else: decline in one sentence, offer what you do cover, stop.
5. If the tools do not have it, say so plainly. "I don't have that" is a good answer. Inventing one is not.

## Answer style
Plain text. No markdown at all: no *, no #, no |, no bullets, no lists, no tables, no emoji. The panel prints your characters literally, so a table arrives as a wall of pipes.

Lead with the answer: name the one product and the one figure that settles the question. Then one clause of judgment the cards cannot give — which to take and why, what is off about the data, what to do next. Then stop. Two sentences, under 40 words.

Shape: "X is the cheapest at Y landed, but it is the only one here with no BIS mark."

The cards below your reply already list every price, seller, quantity, date, assumption and caveat. Never restate them. One figure in your sentence, not five.

If you asked a question, that question is the whole reply. Nothing else.

## Asking before answering
Ask only when the answer would change materially: a quantity missing a dimension, a grade, a brick size or a unit; "10 x 12" with no unit, because feet and metres differ by 10x; a request that spans categories.

A price question is never one of those. "What is cement today" means search and answer. Never ask which brand or grade someone wants before you have shown them what there is. Otherwise take the sensible default, name it in one clause, and move on.

## "Best" questions
Answerable — call rank_by_quality. The panel prints the rubric, the ranking and the caveats itself, so never quote the rubric percentages back. Say which one wins for what they are pouring, and the one thing that would change that. Never say "best" without saying best at what.

## Prices
Prices are landed at the user's pincode, every charge already in. Say "landed" once if it matters; never itemise it. If a tool flags the match weak or the price stale, lead with that — it is the one thing the cards do not show.

## Tools
Call get_catalogue_scope when asked what you can do, or before saying you do not cover something.
Call list_options whenever you need to ask a "which one?" question — never invent the options.
Call price_estimate rather than estimate_quantity when the user wants a cost, so quantity and money come from one place.`;

/**
 * The estimator's argument surface, declared once.
 *
 * estimate_quantity and price_estimate take exactly the same seventeen
 * arguments, and both lists used to be written out longhand. Two copies of one
 * contract drift: add a property to one and price_estimate silently starts
 * accepting a different shape from the tool it delegates to.
 *
 * Note this saves source, not tokens — both declarations still serialise in
 * full onto every request. Cutting the wire payload would mean removing one
 * property list and trusting the model to reuse the other's names, which is a
 * few hundred tokens a turn against a real risk of malformed arguments. Not
 * worth it at this volume.
 */
const ESTIMATE_ARG_PROPS = {
  grade: { type: 'string' }, volume_m3: { type: 'number' }, dimensions_text: { type: 'string' },
  area_m2: { type: 'number' }, unit_id: { type: 'string' }, wall_thickness_mm: { type: 'number' },
  mortar_id: { type: 'string' }, openings_pct: { type: 'number' }, thickness_mm: { type: 'number' },
  faces: { type: 'integer' }, element: { type: 'string' }, known_kg_per_m3: { type: 'number' },
  diameter_mm: { type: 'number' }, run_length_m: { type: 'number' }, bore_mm: { type: 'number' },
  system: { type: 'string' }, stock_length_m: { type: 'number' }, wastage_pct: { type: 'number' },
};

export const TOOL_SCHEMAS: FunctionDeclaration[] = [
  {
    name: 'get_catalogue_scope',
    description:
      'What this assistant covers: categories, cities, product and vendor counts, price ranges, and an explicit list of what is NOT covered. Call before telling a user something is out of scope, and when asked what you can do.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'search_products',
    description:
      'Search the live catalogue. Returns products with landed prices at the user pincode, the market range, how many sellers carry each, lead time, certification state and freshness. This is the ONLY way to learn a price.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in the user\'s own words. e.g. "OPC 53 cement", "12mm TMT bar", "110mm SWR pipe", "AAC block"' },
        category: { type: 'string', enum: ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'], description: 'Narrow to one category when it is unambiguous.' },
        brand: { type: 'string', description: 'Only when the user named a brand.' },
        sort: { type: 'string', enum: ['cheapest', 'recommended', 'fastest'], description: 'cheapest for "what is the lowest price", fastest when delivery speed is the question.' },
        limit: { type: 'integer', description: 'How many to return, 1-12. Use 3 for a focused answer.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_detail',
    description:
      'Full detail for one product: every seller carrying it with their landed price and freight, all specs with provenance and confidence, BIS/QCO status, HSN and GST. Use after search_products when the user drills in.',
    parameters: {
      type: 'object',
      properties: { product_id: { type: 'string', description: 'From a previous search_products result.' } },
      required: ['product_id'],
    },
  },
  {
    name: 'rank_by_quality',
    description:
      'Answers "which is the best X". Returns a named rubric, a ranked list, the best choice PER APPLICATION, how much of the catalogue actually declared the field being ranked on, and what the data cannot tell you. Use for any superlative: best, highest quality, most reliable, strongest.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['cement', 'tmt_steel', 'water_pipes', 'bricks_blocks'] },
        application: { type: 'string', description: 'What they are building, if they said — slab, foundation, plaster, column.' },
        limit: { type: 'integer' },
      },
      required: ['category'],
    },
  },
  {
    name: 'estimate_quantity',
    description:
      'How much material a job needs. Deterministic, cited to IS codes. Returns quantities, the arithmetic, every coefficient used, and what it assumed. If the spec is incomplete it returns the exact question to ask and its options — ask that question verbatim.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['concrete', 'masonry', 'plaster', 'steel', 'pipe'], description: 'concrete for slabs/columns/beams/footings; masonry for walls; plaster for rendering; steel for reinforcement; pipe for plumbing runs.' },
        args: {
          type: 'object',
          description: 'Estimator arguments. concrete: {grade, volume_m3 OR dimensions_text, wastage_pct}. masonry: {unit_id, area_m2 OR dimensions_text, wall_thickness_mm, mortar_id, openings_pct}. plaster: {area_m2 OR dimensions_text, thickness_mm, mortar_id, faces}. steel: {element, volume_m3 OR dimensions_text, known_kg_per_m3, diameter_mm}. pipe: {run_length_m, bore_mm, system, stock_length_m}. Pass the user\'s raw dimension text in dimensions_text, e.g. "20ft x 15ft x 5in".',
          properties: ESTIMATE_ARG_PROPS,
        },
      },
      required: ['kind', 'args'],
    },
  },
  {
    name: 'price_estimate',
    description:
      'Quantity AND cost in one call: works out how much material the job needs, then prices each line against the cheapest live offer at the user pincode. Use whenever the user wants to know what a job will cost. Same arguments as estimate_quantity.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['concrete', 'masonry', 'plaster', 'steel', 'pipe'] },
        args: {
          type: 'object',
          description: 'Identical to estimate_quantity.',
          properties: ESTIMATE_ARG_PROPS,
        },
      },
      required: ['kind', 'args'],
    },
  },
  {
    name: 'list_options',
    description:
      'The real options for a "which one?" question. ALWAYS call this before asking the user to choose — never invent the list. Slots: brick, grade, mortar, element, bore, brand, category, city.',
    parameters: {
      type: 'object',
      properties: { slot: { type: 'string', description: 'One of: brick, grade, mortar, element, bore, brand, brand:cement, category, city' } },
      required: ['slot'],
    },
  },
  {
    name: 'compare_products',
    description: 'Two to four products side by side, with a note when their units make them not directly comparable.',
    parameters: {
      type: 'object',
      properties: { product_ids: { type: 'array', items: { type: 'string' }, description: '2-4 ids from search_products.' } },
      required: ['product_ids'],
    },
  },
];

/** The opening message, and the chips under it. Deterministic — no model call. */
export const WELCOME = {
  greeting:
    'I price construction material in Hyderabad and Vijayawada — cement, TMT steel, water pipes, bricks and blocks. Ask me what something costs, or how much of it your job needs.',
  chips: [
    { label: 'Cement price today', prompt: 'What is cement going for today?' },
    { label: 'Best quality cement', prompt: 'Which is the best quality cement you have?' },
    { label: 'Cement for a slab', prompt: 'How much cement do I need for an M20 slab 20ft x 15ft x 5in?' },
    { label: 'Bricks for a wall', prompt: 'How many bricks for a 9 inch wall, 30ft long and 10ft high?' },
    { label: '12mm TMT rate', prompt: 'What is the rate for 12mm TMT bar?' },
    { label: 'What do you cover?', prompt: 'What can you help me with?' },
  ],
};
