import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

/**
 * One SQLite file, opened in-process.
 *
 * This is the reason the latency target is reachable at all: there is no
 * network hop between the query and the data. The AWS design in the spec puts
 * OpenSearch, DynamoDB and Aurora behind an ALB and budgets 55 ms for the
 * retrieval hop alone. Here the same work is a function call.
 */

/**
 * On a serverless host the function filesystem is read-only, so the store is
 * opened read-only and the journal pragmas are skipped — setting journal_mode
 * or writing a -wal beside the file would fail before the first query ran.
 * Nothing on the query path writes except `logSearch`, which already swallows
 * its own errors, so a read-only store serves the same results.
 */
export const READ_ONLY =
  process.env.BUILDOBJECTS_READONLY === '1' || !!process.env.VERCEL;

/**
 * Two stores, because a live WAL cannot be shipped.
 *
 * `data/buildobjects.db` is the working copy the collector writes to; it carries a
 * -wal alongside it that holds committed pages not yet folded into the file,
 * so the file on its own is behind the data. `npm run db:snapshot` folds the
 * WAL in and VACUUMs the result into `data/buildobjects.prod.db` — one self-contained
 * file, safe to commit and to serve read-only. That snapshot is what a
 * deployment reads.
 */
export const DB_PATH = process.env.BUILDOBJECTS_DB
  ? path.resolve(process.env.BUILDOBJECTS_DB)
  : path.join(process.cwd(), 'data', READ_ONLY ? 'buildobjects.prod.db' : 'buildobjects.db');

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  if (!READ_ONLY) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH, READ_ONLY ? { readonly: true, fileMustExist: true } : {});
  if (!READ_ONLY) {
    d.pragma('journal_mode = WAL');
    d.pragma('synchronous = NORMAL');
  }
  d.pragma('foreign_keys = ON');
  // The whole catalogue is a few MB; keeping it in page cache removes the
  // remaining disk variance from the p99.
  d.pragma('cache_size = -32000');
  d.pragma('mmap_size = 268435456');
  // Must stay MEMORY on a read-only host: a sort or an FTS merge that spills
  // would otherwise try to open a temp file next to the database.
  d.pragma('temp_store = MEMORY');
  _db = d;
  return d;
}

/**
 * Fold the write-ahead log back into the database file.
 *
 * WAL mode auto-checkpoints at 1,000 pages, but only up to the oldest reader's
 * snapshot — so a long-lived reader (the dev server holds one connection for
 * the life of the process) pins the log, and it grows without bound while a
 * rebuild writes. Measured here: a 25 MB database with a **127 MB WAL**, which
 * put the query layer at 23.49 ms p95 against a 20 ms target. The same data
 * with the log folded in ran at 17.23 ms — retrieval alone went 11.97 → 8.11 ms,
 * because every read was searching that log.
 *
 * It returns what actually happened rather than assuming success: TRUNCATE
 * cannot complete while another process holds a read snapshot, and silently
 * doing nothing is exactly how the log reached 127 MB.
 */
export function checkpoint(mode: 'PASSIVE' | 'FULL' | 'TRUNCATE' = 'TRUNCATE'):
  { blocked: boolean; frames: number; checkpointed: number } {
  const r = (db().pragma(`wal_checkpoint(${mode})`) as any[])[0] ?? {};
  return { blocked: r.busy === 1, frames: r.log ?? 0, checkpointed: r.checkpointed ?? 0 };
}

/**
 * Columns added to a table that already exists in someone's database.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which is idempotent for new
 * tables and silently does nothing for a new *column* on an existing one. Each
 * entry here is applied once, ignoring the "duplicate column" error, so an
 * existing data/buildobjects.db picks up the change without being rebuilt from empty.
 */
const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['offer', 'listing_title', 'TEXT'],
  // Why an offer is inactive when it was not delisted: the plausibility rules
  // (lib/plausibility.ts) refused it on a rebuild. NULL on every live row and
  // on a row that simply disappeared from its source.
  ['offer', 'quarantine_reason', 'TEXT'],
];

export function initSchema(target?: Database.Database): void {
  const d = target ?? db();
  if (d === _db && READ_ONLY) return; // shipped store is already built
  const sql = fs.readFileSync(path.join(process.cwd(), 'lib', 'schema.sql'), 'utf8');
  d.exec(sql);

  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const has = (d.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column);
    if (!has) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/**
 * Prepared-statement cache. better-sqlite3 re-plans on every .prepare(), and
 * at 1,000 benchmark queries that re-planning is most of the query-layer cost.
 */
const stmtCache = new Map<string, Database.Statement>();

export function prep(sql: string): Database.Statement {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db().prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

export function tx<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export function close(): void {
  if (_db) {
    _db.close();
    _db = null;
    stmtCache.clear();
  }
}

export function dbExists(): boolean {
  return fs.existsSync(DB_PATH);
}

/** Has a collection run ever succeeded? Drives the no-data-yet UI state. */
export function lastSuccessfulRun(): { run_id: string; finished_at: string; offers_captured: number } | null {
  try {
    return (
      prep(
        `SELECT run_id, finished_at, offers_captured
           FROM collection_run
          WHERE status IN ('ok','partial') AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1`,
      ).get() as any ?? null
    );
  } catch {
    return null;
  }
}
