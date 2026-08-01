/**
 * data/logs/diff-<date>.md
 *
 * Every price that moved, every offer that appeared or vanished, and every
 * source that failed — written after each scheduled run so a change is
 * reviewable rather than silent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prep, initSchema } from '../lib/db';
import { CATEGORY_LABEL } from '../lib/types';

const ROOT = process.cwd();

export function writeDiffLog(runId?: string): string {
  initSchema();
  const run = runId
    ? (prep(`SELECT * FROM collection_run WHERE run_id = ?`).get(runId) as any)
    : (prep(`SELECT * FROM collection_run WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`).get() as any);
  if (!run) throw new Error('no completed collection run to diff');

  const prev = prep(
    `SELECT * FROM collection_run WHERE finished_at IS NOT NULL AND finished_at < ?
      ORDER BY finished_at DESC LIMIT 1`,
  ).get(run.finished_at) as any;

  const date = (run.finished_at ?? new Date().toISOString()).slice(0, 10);
  const dir = path.join(ROOT, 'data', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diff-${date}.md`);

  const L: string[] = [];
  L.push(`# Price diff — ${date}`);
  L.push('');
  L.push(`Run \`${run.run_id}\` (${run.mode}, ${run.status}), finished ${run.finished_at}.`);
  L.push(prev ? `Compared against \`${prev.run_id}\` (${prev.finished_at}).` : 'First completed run — nothing to compare against yet.');
  L.push('');

  // ── prices that moved ────────────────────────────────────────────────────
  L.push('## Prices that moved');
  L.push('');
  if (!prev) {
    L.push('No prior run, so every price is new rather than moved.');
  } else {
    const moved = prep(`
      WITH cur AS (
        SELECT product_id, region_id, normalised_paise, observed_at
          FROM price_history WHERE collection_run_id = ?
      ), old AS (
        SELECT product_id, region_id, normalised_paise
          FROM price_history WHERE collection_run_id = ?
      )
      SELECT p.title, p.category, cur.region_id, old.normalised_paise AS was, cur.normalised_paise AS now,
             p.unit_canonical
        FROM cur JOIN old ON old.product_id = cur.product_id AND old.region_id = cur.region_id
        JOIN product p ON p.product_id = cur.product_id
       WHERE cur.normalised_paise != old.normalised_paise
       ORDER BY ABS(CAST(cur.normalised_paise AS REAL)/NULLIF(old.normalised_paise,0) - 1) DESC
       LIMIT 200`).all(run.run_id, prev.run_id) as any[];

    if (!moved.length) L.push('No price changed between these two runs.');
    else {
      L.push(`**${moved.length}** prices moved.`);
      L.push('');
      L.push('| Product | City | Was | Now | Change |');
      L.push('|---|---|---:|---:|---:|');
      for (const m of moved.slice(0, 60)) {
        const pct = ((m.now - m.was) / m.was) * 100;
        L.push(`| ${m.title} | ${m.region_id} | ₹${(m.was / 100).toFixed(2)}/${m.unit_canonical} | ₹${(m.now / 100).toFixed(2)} | ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% |`);
      }
      // A move past the class threshold is a shock, not a drift.
      const shocks = moved.filter((m) => Math.abs((m.now - m.was) / m.was) > 0.03);
      if (shocks.length) {
        L.push('');
        L.push(`**${shocks.length}** exceeded the V0 shock threshold of 3% and would emit \`PriceShockDetected\` in production, reaching any open cart as a reviewable diff rather than a silent reprice.`);
      }
    }
  }
  L.push('');

  // ── offers that appeared or vanished ─────────────────────────────────────
  L.push('## Offers that appeared or vanished');
  L.push('');
  const appeared = prep(
    `SELECT COUNT(*) c FROM offer WHERE collection_run_id = ?`,
  ).get(run.run_id) as any;
  const vanished = prep(
    `SELECT COUNT(*) c FROM offer WHERE is_active = 0`,
  ).get() as any;
  L.push(`- Offers touched by this run: **${appeared.c}**`);
  L.push(`- Offers new this run: **${run.offers_new}**`);
  L.push(`- New vendors: **${run.vendors_new}**`);
  L.push(`- Offers currently inactive (seen before, absent now): **${vanished.c}**`);
  L.push('');

  const byCat = prep(`
    SELECT p.category, o.region_id, COUNT(*) n, COUNT(DISTINCT o.vendor_id) v
      FROM offer o JOIN product p ON p.product_id = o.product_id
     WHERE o.is_active = 1 GROUP BY p.category, o.region_id`).all() as any[];
  L.push('| Category | City | Live offers | Vendors |');
  L.push('|---|---|---:|---:|');
  for (const r of byCat) L.push(`| ${CATEGORY_LABEL[r.category] ?? r.category} | ${r.region_id} | ${r.n} | ${r.v} |`);
  L.push('');

  // ── sources that failed ──────────────────────────────────────────────────
  L.push('## Sources that failed');
  L.push('');
  const failed = prep(`
    SELECT source_id, source_class, outcome, COUNT(*) n, SUM(COALESCE(estimated_missed,0)) missed,
           MAX(note) note
      FROM source_log WHERE run_id = ? AND outcome != 'ok'
     GROUP BY source_id, outcome ORDER BY missed DESC, n DESC`).all(run.run_id) as any[];
  if (!failed.length) L.push('Every source answered.');
  else {
    const total = failed.reduce((s, f) => s + (f.missed ?? 0), 0);
    L.push(`**${failed.length}** source endpoints did not answer. Estimated listings not captured: **~${total}**.`);
    L.push('');
    L.push('| Source | Class | Outcome | Est. missed | Note |');
    L.push('|---|---|---|---:|---|');
    for (const f of failed.slice(0, 40)) {
      L.push(`| \`${f.source_id}\` | ${f.source_class} | **${f.outcome}** | ${f.missed || '—'} | ${(f.note ?? '').replace(/\|/g, '\\|').slice(0, 200)} |`);
    }
  }
  L.push('');

  L.push('## Freshness after this run');
  L.push('');
  const fresh = prep(`
    SELECT p.category, pc.region_id,
           SUM(CASE WHEN (julianday('now')-julianday(pc.priced_as_of))*24 < pc.sla_hours*0.5 THEN 1 ELSE 0 END) AS fresh,
           SUM(CASE WHEN (julianday('now')-julianday(pc.priced_as_of))*24 >= pc.sla_hours THEN 1 ELSE 0 END) AS stale,
           COUNT(*) n
      FROM price_current pc JOIN product p ON p.product_id = pc.product_id
     GROUP BY p.category, pc.region_id`).all() as any[];
  L.push('| Category | City | FRESH | STALE+ | Total |');
  L.push('|---|---|---:|---:|---:|');
  for (const f of fresh) L.push(`| ${CATEGORY_LABEL[f.category] ?? f.category} | ${f.region_id} | ${f.fresh} | ${f.stale} | ${f.n} |`);
  L.push('');
  L.push(run.status === 'ok'
    ? '_Run completed. `price_current` was replaced inside a single transaction, so no reader saw a half-written state._'
    : '_Run completed with failures. Previous prices are intact and are ageing honestly; the app marks freshness as degraded rather than blanking the page._');

  fs.writeFileSync(file, L.join('\n'), 'utf8');
  return file;
}

if (process.argv[1] && process.argv[1].endsWith('diff-log.ts')) {
  console.log('diff log →', writeDiffLog(process.argv[2]));
}
