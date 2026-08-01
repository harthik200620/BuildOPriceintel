/**
 * Human-readable snapshots alongside the DB, so the data can be inspected
 * without a SQL client: data/snapshots/<date>/<category>.json and a flattened
 * .csv per category.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prep } from '../lib/db';
import { CATEGORIES, CATEGORY_LABEL } from '../lib/types';

const ROOT = process.cwd();

const SNAPSHOT_SQL = `
  SELECT p.product_id, p.category, p.title, p.brand, p.attrs, p.unit_canonical,
         p.hsn, p.gst_rate_bp, p.qco_regulated, p.cert_standards,
         o.offer_id, o.platform, o.source_url, o.base_paise, o.base_unit,
         o.base_paise_canonical, o.trade_multiple, o.gst_treatment, o.mrp_paise,
         o.delivery_scope, o.moq_qty, o.moq_unit, o.stock_state, o.lead_time_days,
         o.cert_state, o.cert_ref, o.rating, o.review_count, o.fetched_at,
         v.vendor_id, v.name AS vendor_name, v.locality AS vendor_locality,
         v.city AS vendor_city, v.seller_type, v.geo_confidence,
         o.region_id,
         s.freight_paise, s.handling_paise, s.loading_paise, s.vehicle_class,
         s.distance_km, s.distance_band, s.basis AS freight_basis,
         pc.landed_paise, pc.normalised_paise, pc.floor_paise, pc.ceiling_paise,
         pc.median_paise, pc.offer_count, pc.vendor_count, pc.priced_as_of, pc.sla_hours
    FROM offer o
    JOIN product p ON p.product_id = o.product_id
    JOIN vendor  v ON v.vendor_id  = o.vendor_id
    LEFT JOIN serviceability s ON s.offer_id = o.offer_id AND s.region_id = o.region_id
    LEFT JOIN price_current pc ON pc.product_id = o.product_id AND pc.region_id = o.region_id
   WHERE o.is_active = 1 AND p.category = ?
   ORDER BY o.region_id, pc.normalised_paise`;

const CSV_COLUMNS = [
  'product_id', 'category', 'title', 'brand', 'region_id', 'vendor_name', 'vendor_locality',
  'platform', 'seller_type', 'base_rupees', 'base_unit', 'base_rupees_per_canonical',
  'unit_canonical', 'gst_treatment', 'gst_rate_pct', 'hsn', 'freight_rupees', 'handling_rupees',
  'loading_rupees', 'landed_rupees_per_canonical', 'landed_rupees_per_trade_unit',
  'moq_qty', 'moq_unit', 'stock_state', 'lead_time_days', 'cert_state', 'cert_ref',
  'qco_regulated', 'rating', 'review_count', 'distance_km', 'vehicle_class', 'freight_basis',
  'fetched_at', 'source_url',
];

const r2 = (p: number | null | undefined) => (p == null ? '' : (p / 100).toFixed(2));

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeSnapshots(runId: string): Promise<{ dir: string; files: string[] }> {
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(ROOT, 'data', 'snapshots', date);
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];

  for (const category of CATEGORIES) {
    const rows = prep(SNAPSHOT_SQL).all(category) as any[];

    const json = {
      generated_at: new Date().toISOString(),
      collection_run_id: runId,
      category,
      category_label: CATEGORY_LABEL[category],
      offer_count: rows.length,
      vendor_count: new Set(rows.map((r) => r.vendor_id)).size,
      brand_count: new Set(rows.map((r) => r.brand).filter(Boolean)).size,
      platform_count: new Set(rows.map((r) => r.platform)).size,
      by_region: Object.fromEntries(
        ['hyderabad', 'vijayawada'].map((rg) => {
          const sel = rows.filter((r) => r.region_id === rg);
          return [rg, {
            offers: sel.length,
            vendors: new Set(sel.map((r) => r.vendor_id)).size,
            brands: new Set(sel.map((r) => r.brand).filter(Boolean)).size,
            platforms: new Set(sel.map((r) => r.platform)).size,
          }];
        }),
      ),
      note:
        'Every price here is the figure the named source published, converted to the canonical unit ' +
        'by a recorded conversion. Nothing in this file was invented to fill a gap.',
      offers: rows.map((r) => ({
        ...r,
        attrs: JSON.parse(r.attrs || '{}'),
        cert_standards: JSON.parse(r.cert_standards || '[]'),
        base_rupees: r2(r.base_paise),
        base_rupees_per_canonical: r2(r.base_paise_canonical),
        landed_rupees_per_canonical: r2(r.normalised_paise),
        gst_rate_pct: r.gst_rate_bp / 100,
      })),
    };

    const jsonPath = path.join(dir, `${category}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), 'utf8');
    files.push(jsonPath);

    const csv = [CSV_COLUMNS.join(',')];
    for (const r of rows) {
      csv.push(CSV_COLUMNS.map((c) => {
        switch (c) {
          case 'base_rupees': return csvEscape(r2(r.base_paise));
          case 'base_rupees_per_canonical': return csvEscape(r2(r.base_paise_canonical));
          case 'freight_rupees': return csvEscape(r2(r.freight_paise));
          case 'handling_rupees': return csvEscape(r2(r.handling_paise));
          case 'loading_rupees': return csvEscape(r2(r.loading_paise));
          case 'landed_rupees_per_canonical': return csvEscape(r2(r.normalised_paise));
          case 'landed_rupees_per_trade_unit': return csvEscape(r2(r.landed_paise));
          case 'gst_rate_pct': return csvEscape(r.gst_rate_bp / 100);
          default: return csvEscape((r as any)[c]);
        }
      }).join(','));
    }
    const csvPath = path.join(dir, `${category}.csv`);
    fs.writeFileSync(csvPath, csv.join('\n'), 'utf8');
    files.push(csvPath);
  }

  return { dir, files };
}

if (process.argv[1] && process.argv[1].endsWith('snapshot.ts')) {
  writeSnapshots('manual').then((r) => console.log(`snapshots → ${r.dir} (${r.files.length} files)`));
}
