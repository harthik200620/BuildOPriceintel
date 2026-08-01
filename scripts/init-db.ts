/**
 * Creates the schema and seeds every reference table that is data-rather-than-code:
 * regions, pincodes with coordinates, unit conversions, effective-dated GST rates,
 * and the facet definitions loaded from filters/<category>.json.
 *
 * Idempotent. Safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, initSchema, tx, DB_PATH } from '../lib/db';
import { UNIT_CONVERSIONS } from '../lib/units';
import { GST_RATES } from '../lib/gst';
import { seedFacets } from '../lib/facets';

const ROOT = process.cwd();

interface RegionSeed {
  region_id: string; name: string; state_code: string; district: string;
  pincode_from: string; pincode_to: string; default_pincode: string;
  centroid_lat: number; centroid_lon: number; freight_band: number;
  sor_status: string; sor_note: string;
}

const REGIONS: RegionSeed[] = [
  {
    region_id: 'hyderabad', name: 'Hyderabad', state_code: 'TS', district: 'Hyderabad',
    pincode_from: '500001', pincode_to: '500100', default_pincode: '500001',
    centroid_lat: 17.385, centroid_lon: 78.4867, freight_band: 1,
    sor_status: 'CURRENT',
    sor_note:
      'Telangana PRED publishes a clean monthly cement and steel basic-rate series (2014 → 2026) plus an annual SSR. ' +
      'This is the most defensible price anchor on the page and no competitor shows it.',
  },
  {
    region_id: 'vijayawada', name: 'Vijayawada', state_code: 'AP', district: 'Krishna',
    pincode_from: '520001', pincode_to: '521456', default_pincode: '520001',
    centroid_lat: 16.5062, centroid_lon: 80.648, freight_band: 2,
    sor_status: 'STALE',
    sor_note:
      'Andhra Pradesh does not publish a current Schedule of Rates. The newest verifiable edition is 2018-19 ' +
      '(AP WRD downloads); APSPDCL electrical SSR is 2020-21. This asymmetry is spec assumption A-07 and it is ' +
      'recorded rather than smoothed over: AP has no government price anchor, so its reference line is the ' +
      'Telangana series shown explicitly as a cross-border cross-check.',
  },
];

function seedRegions() {
  const stmt = db().prepare(
    `INSERT INTO region (region_id,name,state_code,district,pincode_from,pincode_to,default_pincode,
       centroid_lat,centroid_lon,freight_band,sor_status,sor_note)
     VALUES (@region_id,@name,@state_code,@district,@pincode_from,@pincode_to,@default_pincode,
       @centroid_lat,@centroid_lon,@freight_band,@sor_status,@sor_note)
     ON CONFLICT(region_id) DO UPDATE SET
       name=excluded.name, centroid_lat=excluded.centroid_lat, centroid_lon=excluded.centroid_lon,
       sor_status=excluded.sor_status, sor_note=excluded.sor_note`,
  );
  for (const r of REGIONS) stmt.run(r);
  return REGIONS.length;
}

function seedPincodes() {
  const file = path.join(ROOT, 'data', 'pincodes.csv');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const header = lines.shift()!.split(',');
  const idx = (k: string) => header.indexOf(k);
  const stmt = db().prepare(
    `INSERT INTO pincode (pincode,region_id,locality,district,state_code,lat,lon,source_url,confidence)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(pincode) DO UPDATE SET
       lat=excluded.lat, lon=excluded.lon, confidence=excluded.confidence, locality=excluded.locality`,
  );
  let n = 0;
  for (const line of lines) {
    const c = line.split(',');
    stmt.run(
      c[idx('pincode')], c[idx('region_id')], c[idx('locality')], c[idx('district')],
      c[idx('state_code')], Number(c[idx('lat')]), Number(c[idx('lon')]),
      c[idx('source_url')], c[idx('confidence')],
    );
    n++;
  }
  return n;
}

function seedUnits() {
  const stmt = db().prepare(
    `INSERT INTO unit_conversion (from_unit,to_unit,category,factor,note,source_url,confidence)
     VALUES (@from_unit,@to_unit,@category,@factor,@note,@source_url,@confidence)
     ON CONFLICT(from_unit,to_unit,category) DO UPDATE SET
       factor=excluded.factor, note=excluded.note, confidence=excluded.confidence`,
  );
  for (const u of UNIT_CONVERSIONS) stmt.run(u);
  return UNIT_CONVERSIONS.length;
}

function seedGst() {
  const stmt = db().prepare(
    `INSERT INTO gst_rate (hsn,category,rate_bp,effective_from,effective_to,citation,label,note)
     VALUES (@hsn,@category,@rate_bp,@effective_from,@effective_to,@citation,@label,@note)
     ON CONFLICT(hsn,category,effective_from) DO UPDATE SET
       rate_bp=excluded.rate_bp, citation=excluded.citation, label=excluded.label, note=excluded.note`,
  );
  for (const g of GST_RATES) stmt.run(g);
  return GST_RATES.length;
}

function main() {
  console.log(`db  ${DB_PATH}`);
  initSchema();
  const counts = tx(() => ({
    regions: seedRegions(),
    pincodes: seedPincodes(),
    units: seedUnits(),
    gst: seedGst(),
    facets: seedFacets(),
  }));
  console.log(
    `seeded  regions=${counts.regions}  pincodes=${counts.pincodes}  ` +
    `unit_conversions=${counts.units}  gst_rates=${counts.gst}  facets=${counts.facets}`,
  );

  const byRegion = db()
    .prepare(`SELECT region_id, COUNT(*) n, SUM(confidence='quoted') q FROM pincode GROUP BY region_id`)
    .all() as Array<{ region_id: string; n: number; q: number }>;
  for (const r of byRegion) {
    console.log(`  ${r.region_id.padEnd(12)} ${r.n} pincodes, ${r.q} with quoted coordinates, ${r.n - r.q} snapped to city centre (typical)`);
  }
}

main();
