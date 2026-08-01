/**
 * Fold the write-ahead log back into the database file.
 *
 * Run this after a rebuild if the collector reported that it could not — which
 * happens whenever something else holds the database open, most often a running
 * `npm run dev`. Stop that first; a checkpoint cannot pass a live reader's
 * snapshot, and reporting success it did not achieve would be worse than
 * failing loudly.
 *
 *   npm run db:checkpoint
 */
import fs from 'node:fs';
import { checkpoint, DB_PATH, close } from '../lib/db';

const mb = (p: string) => {
  try { return (fs.statSync(p).size / 1048576).toFixed(1) + ' MB'; } catch { return '—'; }
};
const wal = `${DB_PATH}-wal`;

console.log(`before   db ${mb(DB_PATH)} · wal ${mb(wal)}`);
const r = checkpoint('TRUNCATE');
console.log(`after    db ${mb(DB_PATH)} · wal ${mb(wal)}`);
console.log(`frames   ${r.checkpointed} of ${r.frames} folded back`);

if (r.blocked || r.checkpointed < r.frames) {
  console.log(
    '\nBLOCKED. Another process holds a read snapshot on this database — almost\n' +
    'always a running dev server. Stop it, re-run this, and start it again.\n' +
    'Leaving the log large is not cosmetic: a 127 MB log against a 25 MB\n' +
    'database measured 23.49 ms p95 on the query layer against a 20 ms target,\n' +
    'and 17.23 ms once folded in.',
  );
  close();
  process.exit(1);
}
console.log('\nDone. The log is folded in and the file is reset.');
close();
