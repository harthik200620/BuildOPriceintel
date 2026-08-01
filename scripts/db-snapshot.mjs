/**
 * Fold the WAL into one self-contained file that can be committed and served.
 *
 * The working store keeps `journal_mode = WAL`, so `data/buildo.db` on its own
 * is behind whatever the collector last wrote — the committed-but-unfolded
 * pages live in `data/buildo.db-wal`, which is both enormous and meaningless
 * without the process that produced it. Shipping the bare file would serve a
 * stale catalogue; shipping the pair would push a ~130 MB artefact.
 *
 * `VACUUM INTO` reads through the WAL, so the copy it writes is the database as
 * a reader sees it right now, compacted, with no journal beside it. That single
 * file is what a deployment opens read-only.
 *
 * Run: npm run db:snapshot
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'data', 'buildo.db');
const OUT = path.join(process.cwd(), 'data', 'buildo.prod.db');

if (!fs.existsSync(SRC)) {
  console.error(`No working store at ${SRC}. Run \`npm run db:init\` first.`);
  process.exit(1);
}

fs.rmSync(OUT, { force: true });

const src = new Database(SRC);
// Best effort: the collector or a dev server may hold a read lock, which makes
// the checkpoint return busy. That is fine — VACUUM INTO still reads through
// the WAL, so the snapshot is complete either way.
try {
  src.pragma('wal_checkpoint(TRUNCATE)');
} catch {
  /* fall through to VACUUM INTO */
}
src.exec(`VACUUM INTO '${OUT.replace(/\\/g, '/').replace(/'/g, "''")}'`);
src.close();

const out = new Database(OUT, { readonly: true });
const ok = out.pragma('integrity_check')[0].integrity_check;
if (ok !== 'ok') {
  console.error(`Snapshot failed integrity_check: ${ok}`);
  process.exit(1);
}
const count = (t) => {
  try {
    return out.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  } catch {
    return 0;
  }
};
const rows = {
  product: count('product'),
  offer: count('offer'),
  vendor: count('vendor'),
  facet_definition: count('facet_definition'),
};
out.close();

if (rows.offer === 0 || rows.product === 0) {
  console.error('Snapshot has no offers or no products — refusing to ship an empty catalogue.');
  process.exit(1);
}

const mb = (fs.statSync(OUT).size / 1048576).toFixed(1);
console.log(`data/buildo.prod.db  ${mb} MB  integrity ok`);
console.log(
  `  ${rows.product} products · ${rows.offer} offers · ${rows.vendor} vendors · ${rows.facet_definition} facets`,
);
