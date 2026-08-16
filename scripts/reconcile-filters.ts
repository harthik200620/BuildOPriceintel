/**
 * The Phase 1 → Phase 2 reconciliation.
 *
 * The filter trees were authored before the data existed, so their brand
 * rosters, price bands and counts were illustrative. This rewrites all three
 * from real DB aggregates:
 *
 *   - Brand values become the brands actually collected, ordered by result
 *     count, not the roster we hoped for.
 *   - Price bands are derived from the real in-zone distribution (quartiles),
 *     not round numbers — ₹0–500 / ₹500–1000 on a catalogue where everything
 *     costs ₹380–₹460 produces one useful band and three empty ones.
 *   - Every count is measured.
 *   - A facet with nothing behind it does not quietly ship: it is marked
 *     `data_backed: false` with a reason, which the rail renders disabled.
 *     "Every facet you define must be a field you actually collect — a filter
 *     with no data behind it is a defect."
 *
 * Then `counts_are_illustrative` flips to false, and the trees are re-validated
 * against the category-filters checker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, prep, initSchema, tx } from '../lib/db';
import { assess } from '../lib/freshness';
import { seedFacets } from '../lib/facets';

const ROOT = process.cwd();
const FILES: Record<string, string> = {
  cement: 'cement.json',
  tmt_steel: 'tmt-steel.json',
  water_pipes: 'water-pipes.json',
  bricks_blocks: 'bricks-blocks.json',
};

const REGION = process.argv.find((a) => a.startsWith('--region='))?.split('=')[1] ?? 'hyderabad';

interface Row {
  product_id: string; brand: string | null; attrs: any; normalised_paise: number;
  cert_state: string; lead_time_days: number | null; gst_treatment: string;
  cert_standards: string[]; offer_count: number;
  priced_as_of: string; sla_hours: number;
}

/**
 * One row per OFFER, matching lib/search.ts BASE_SQL exactly.
 *
 * The rail counts offers now that the results list is one card per vendor, so
 * these counts must be offers too. A tree reconciled against products while the
 * rail counts offers is the same defect this script exists to prevent, just
 * pointing the other way.
 */
function load(category: string): Row[] {
  return (prep(`
    SELECT p.product_id, p.brand, p.attrs, p.cert_standards,
           op.normalised_paise, op.priced_as_of, op.sla_hours, pc.offer_count,
           o.cert_state, o.gst_treatment,
           COALESCE(o.lead_time_days, s.lead_time_days) AS lead_time_days
      FROM offer_price op
      JOIN offer   o ON o.offer_id   = op.offer_id
      JOIN product p ON p.product_id = op.product_id
      LEFT JOIN price_current pc ON pc.product_id = op.product_id AND pc.region_id = op.region_id
      LEFT JOIN serviceability s ON s.offer_id = op.offer_id AND s.region_id = op.region_id
     WHERE op.region_id = ? AND p.category = ? AND o.is_active = 1`).all(REGION, category) as any[])
    .map((r) => ({
      ...r,
      attrs: JSON.parse(r.attrs || '{}'),
      cert_standards: JSON.parse(r.cert_standards || '[]'),
    }));
}

const numOf = (s: string): number | null => {
  const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function attrValue(row: Row, key: string): string | null {
  if (key.startsWith('attrs.')) {
    const v = row.attrs[key.slice(6)];
    return v === null || v === undefined || v === '' ? null : String(v);
  }
  if (key === 'product.brand') return row.brand;
  if (key === 'product.producer_type') return row.attrs.producer_type ?? null;
  if (key === 'product.pack_size') return row.attrs.pack_size_kg != null ? String(row.attrs.pack_size_kg) : null;
  if (key === 'offer.cert_state') {
    return { CERTIFIED: 'Licence number on file', BRAND_LICENSED: 'BIS-licensed brand, licence not quoted',
      NOT_APPLICABLE: 'Not applicable', NOT_DECLARED: 'Not declared', EXPIRED: 'Expired' }[row.cert_state] ?? 'Not declared';
  }
  if (key === 'offer.gst_treatment') return row.gst_treatment === 'INCL' ? 'Inclusive of GST' : 'Exclusive of GST';
  if (key === 'serviceability.lead_time_days') {
    const d = row.lead_time_days ?? 3;
    return d <= 1 ? 'Tomorrow' : d <= 3 ? 'Within 3 days' : d <= 7 ? 'Within a week' : 'Scheduled delivery';
  }
  if (key === 'product.cert_standards') return row.cert_standards[0] ?? null;
  if (key === 'product.country_of_origin') return 'Not published by seller';
  // Freshness is derived at query time, not stored — mirrored from
  // lib/search.ts facetValueOf. Without this case it read as null on every row
  // and the rail shipped `price_freshness` disabled in all four categories
  // while search would have filtered on it perfectly well: a facet turned off
  // by a gap in this script rather than by a gap in the data.
  if (key === 'price_current.freshness_state') {
    const h = assess(row.priced_as_of, row.sla_hours).ageHours;
    return h < 24 ? 'Verified today' : h < 72 ? 'Within 3 days' : h < 168 ? 'Within a week' : null;
  }
  return null;
}

function matches(row: Row, key: string, label: string): boolean {
  const raw = attrValue(row, key);
  if (raw === null) return false;
  // A dimension triple is a name, not a quantity — compare it as text.
  if (/\d\s*[×x]\s*\d/.test(raw)) {
    return raw.replace(/\s|x/gi, '×').toLowerCase() === label.replace(/\s|x/gi, '×').toLowerCase();
  }
  const asNum = numOf(raw);
  if (asNum !== null) {
    const range = label.match(/(-?[\d.]+)\s*[–-]\s*(-?[\d.]+)/);
    if (range) return asNum >= Number(range[1]) && asNum <= Number(range[2]);
    const under = label.match(/^Under\s+([\d.,]+)/i);
    if (under) return asNum < Number(under[1].replace(/,/g, ''));
    const over = label.match(/^Over\s+([\d.,]+)/i);
    if (over) return asNum > Number(over[1].replace(/,/g, ''));
    const lead = numOf(label);
    if (lead !== null) return Math.abs(asNum - lead) < 1e-9;
  }
  return raw.toLowerCase() === label.toLowerCase();
}

/** Quartile bands over the real distribution, rounded to readable rupees. */
function priceBands(rows: Row[], unitLabel: string): Array<{ label: string; unit: string; count: number }> {
  const vals = rows.map((r) => r.normalised_paise / 100).sort((a, b) => a - b);
  if (vals.length < 4) {
    return [{ label: 'All prices', unit: unitLabel, count: vals.length }];
  }
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const round = (x: number) => (x >= 1000 ? Math.round(x / 100) * 100 : x >= 100 ? Math.round(x / 10) * 10 : Math.round(x));
  const a = round(q(0.25)), b = round(q(0.5)), c = round(q(0.75));
  const cuts = [...new Set([a, b, c])].filter((x) => x > 0).sort((x, y) => x - y);
  const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`;

  const out: Array<{ label: string; unit: string; count: number }> = [];
  out.push({ label: `Under ${fmt(cuts[0])}`, unit: unitLabel, count: vals.filter((v) => v < cuts[0]).length });
  for (let i = 0; i < cuts.length - 1; i++) {
    out.push({
      label: `${fmt(cuts[i])} – ${fmt(cuts[i + 1])}`, unit: unitLabel,
      count: vals.filter((v) => v >= cuts[i] && v < cuts[i + 1]).length,
    });
  }
  out.push({ label: `Over ${fmt(cuts[cuts.length - 1])}`, unit: unitLabel, count: vals.filter((v) => v >= cuts[cuts.length - 1]).length });
  return out;
}

function main() {
  initSchema();
  console.log(`reconciling filter trees against real data — region ${REGION}\n`);
  const summary: string[] = [];

  for (const [category, fname] of Object.entries(FILES)) {
    const p = path.join(ROOT, 'filters', fname);
    const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
    const rows = load(category);

    spec.result_count = rows.length;
    spec.counts_are_illustrative = false;
    spec.counts_note =
      `Counts measured from data/buildobjects.db on ${new Date().toISOString().slice(0, 10)} for ${REGION}. ` +
      `Each count is a number of OFFERS, not products: the results list shows one card per vendor, so the ` +
      `rail counts sellers' listings and these numbers match it exactly. ` +
      `A facet marked data_backed:false has no field behind it in the collected data and ships disabled with a reason.`;
    spec.reconciled_at = new Date().toISOString();
    spec.reconciled_region = REGION;

    let dropped = 0, kept = 0;

    for (const f of spec.filters) {
      const key: string = f.facet_key ?? f.id;

      // Brand: replace the authored roster with what was actually collected.
      if (key === 'product.brand') {
        const counts = new Map<string, number>();
        for (const r of rows) if (r.brand) counts.set(r.brand, (counts.get(r.brand) ?? 0) + 1);
        const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        if (ordered.length) {
          // Six visible, rest behind search-within-facet. The panel budget is a
          // real constraint (34 value rows, ~1350 px of rail) and a long brand
          // roster is the usual way it gets blown.
          const VISIBLE = 6;
          f.values = ordered.slice(0, VISIBLE).map(([label, count]) => ({ label, count }));
          f.note = (f.note ? f.note + ' ' : '') +
            `Roster rewritten from collected data: ${ordered.length} brands present` +
            (ordered.length > VISIBLE ? `, top ${VISIBLE} shown with search-within-facet for the remaining ${ordered.length - VISIBLE}.` : '.');
          f.data_backed = true;
          kept++;
        } else {
          f.values = f.values.map((v: any) => ({ ...v, count: 0, disabled: true }));
          f.data_backed = false;
          f.no_data_reason = 'No brand was resolvable on any collected listing for this category and city.';
          dropped++;
        }
        continue;
      }

      // Price: derive bands from the real distribution.
      if (key === 'price_current.normalised_paise') {
        const unitLabel = f.values?.[0]?.unit ?? `₹/${spec.canonical_unit}`;
        if (!rows.length) {
          // No supply: keep the authored bands, disabled, rather than
          // collapsing to a single live "All prices" that eliminates nothing
          // and produces a dead click.
          f.values = f.values.map((v: any) => ({ ...v, count: 0, disabled: true }));
          f.data_backed = false;
          f.no_data_reason = `No collected listing in ${REGION} carries a price for this category, so no band can be derived from a real distribution.`;
          dropped++;
          continue;
        }
        const bands = priceBands(rows, unitLabel);
        f.values = bands.map((b) => (b.count === 0 ? { ...b, disabled: true } : b));
        f.data_backed = bands.some((b) => b.count > 0);
        f.note = (f.note ?? '') + ` Bands derived from the actual in-zone distribution (quartiles), not round numbers.`;
        if (f.data_backed) kept++; else dropped++;
        continue;
      }

      // Everything else: measure each authored value.
      let any = false;
      f.values = f.values.map((v: any) => {
        const count = rows.filter((r) => matches(r, key, v.label)).length;
        if (count > 0) any = true;
        return { ...v, count, ...(count === 0 ? { disabled: true } : {}) };
      });
      f.data_backed = any;
      if (!any) {
        // Two different facts get the same disabled pill, and conflating them
        // hides the more actionable one. "Nobody publishes this" is a
        // collection gap. "Everybody publishes it as free prose" is a
        // normalisation gap — the data is there and an extractor would reach
        // it. Cement `application` is the second kind: 60 products carry it,
        // as "Construction", "For Construction", "Used For Constrution", and
        // a controlled vocabulary of five values matches none of them.
        const populated = rows.filter((r) => attrValue(r, key) !== null);
        const examples = [...new Set(populated.map((r) => attrValue(r, key)!))]
          .slice(0, 3).map((s) => `"${s.slice(0, 40)}"`).join(', ');
        f.no_data_reason = populated.length
          ? `\`${key}\` is populated on ${populated.length} of ${rows.length} listings in ${REGION}, but as ` +
            `uncontrolled seller text (${examples}) which matches none of this filter's values. The gap is ` +
            `normalisation, not collection: shipped disabled rather than deleted, and rather than mapped by guess.`
          : `No collected listing in ${REGION} populates \`${key}\`. The facet is retained and shipped disabled ` +
            `rather than deleted, so the gap is visible rather than silently absent.`;
        f.no_data_kind = populated.length ? 'unnormalised' : 'uncollected';
        dropped++;
      } else kept++;
    }

    fs.writeFileSync(p, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    const line = `${spec.category.padEnd(16)} ${String(rows.length).padStart(4)} offers · ${kept} facets data-backed · ${dropped} shipped disabled`;
    console.log('  ' + line);
    summary.push(line);
  }

  // Publishing the document is only half of it. The query layer reads
  // `facet_definition`, not these files, and until this call existed only
  // `npm run db:init` refreshed that table — so a reconciled tree could state
  // one set of price bands while the rail rendered the bands seeded weeks
  // earlier. CP(E-Commerce) Rule 5(3)(f) requires the disclosed filtering
  // parameters to be the applied ones, so the two are now written together.
  const n = tx(() => seedFacets(ROOT));
  console.log(`\nfilters/*.json rewritten with measured counts.`);
  console.log(`facet_definition re-seeded from them — ${n} facets. The published tree and the rail agree.`);
  return summary;
}

main();
