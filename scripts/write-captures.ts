/**
 * Materialises browser-assisted captures into collector/raw/assisted-*.jsonl,
 * which the `assisted` adapter then loads on every run.
 *
 * Keeping the captures as typed source files rather than hand-edited JSONL
 * means the conversion (units, GST basis, region fan-out) is reviewable code
 * rather than a pile of literals.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toRawOffers as bigbmart, CAPTURED_AT } from '../collector/captures/bigbmart-2026-08-01';

const RAW = path.join(process.cwd(), 'collector', 'raw');

function write(name: string, rows: unknown[]) {
  fs.mkdirSync(RAW, { recursive: true });
  const file = path.join(RAW, `assisted-${name}-${CAPTURED_AT.slice(0, 10)}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`${rows.length.toString().padStart(5)} rows → ${path.relative(process.cwd(), file)}`);
  return rows.length;
}

const total = write('bigbmart', bigbmart());
console.log(`\n${total} browser-assisted rows staged for the next collector run.`);
