import { NextResponse } from 'next/server';
import { prep, lastSuccessfulRun } from '@/lib/db';
import { armNetworkGuard, guardState, allowedHosts } from '@/lib/no-network';
import { hasKey, GEMINI_MODEL } from '@/lib/chat/gemini';
import { SORTS, COLUMN_SORTS } from '@/lib/rank';
import { CATEGORY_LABEL } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

export async function GET() {
  const regions = prep(
    `SELECT region_id, name, state_code, district, pincode_from, pincode_to, default_pincode,
            sor_status, sor_note FROM region ORDER BY name`,
  ).all() as any[];

  const counts = prep(
    `SELECT p.category, pc.region_id, COUNT(*) AS products,
            SUM(pc.offer_count) AS offers, MIN(pc.normalised_paise) AS lo, MAX(pc.normalised_paise) AS hi
       FROM price_current pc JOIN product p ON p.product_id = pc.product_id
      GROUP BY p.category, pc.region_id`,
  ).all() as any[];

  const run = lastSuccessfulRun();
  const runDetail = run
    ? (prep(
        `SELECT run_id, started_at, finished_at, status, mode, sources_attempted, sources_ok,
                sources_blocked, offers_captured, vendors_new,
                ladder_quoted, ladder_derived, ladder_typical, ladder_unknown, notes
           FROM collection_run WHERE run_id = ?`,
      ).get(run.run_id) as any)
    : null;

  const blocked = prep(
    `SELECT source_id, source_class, outcome, SUM(COALESCE(estimated_missed,0)) AS missed
       FROM source_log WHERE outcome != 'ok'
       GROUP BY source_id, outcome ORDER BY missed DESC LIMIT 12`,
  ).all() as any[];

  return NextResponse.json({
    regions: regions.map((r) => ({ ...r, categories: counts.filter((c) => c.region_id === r.region_id) })),
    category_labels: CATEGORY_LABEL,
    sorts: SORTS,
    // Column-header sorts, with the disclosure text each one publishes when it
    // is the applied order. `value` is a function and does not serialise.
    column_sorts: Object.fromEntries(
      Object.entries(COLUMN_SORTS).map(([k, v]) => [k, { label: v.label, explain: v.explain }]),
    ),
    last_run: runDetail,
    // Freshness of the whole surface is degraded when the last run failed —
    // the app says so rather than presenting stale data as current.
    degraded: !runDetail || runDetail.status === 'failed',
    blocked_sources: blocked,
    // The guard's exceptions are published rather than buried, because an
    // allowlist nobody can see is indistinguishable from no guard at all.
    network_guard: { ...guardState(), allowed: allowedHosts() },
    assistant: { ready: hasKey(), model: GEMINI_MODEL },
  }, { headers: { 'cache-control': 'no-store' } });
}
