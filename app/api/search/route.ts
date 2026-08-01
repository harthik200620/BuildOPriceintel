import { NextRequest, NextResponse } from 'next/server';
import { search, logSearch } from '@/lib/search';
import { armNetworkGuard } from '@/lib/no-network';
import { resolvePincode } from '@/lib/price';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const sp = req.nextUrl.searchParams;

  const q = sp.get('q') ?? '';
  const pincode = sp.get('pincode') ?? '500001';
  const dest = resolvePincode(pincode);
  if (!dest) {
    return NextResponse.json(
      {
        error: 'PINCODE_NOT_SERVICED',
        message:
          `We do not have supply data for ${pincode} yet. This demo covers Hyderabad (500001–500100) ` +
          `and Vijayawada (520001–521456).`,
      },
      { status: 404 },
    );
  }

  const facets: Record<string, string[]> = {};
  for (const [k, v] of sp.entries()) {
    if (k.startsWith('f.')) {
      const id = k.slice(2);
      (facets[id] ??= []).push(v);
    }
  }

  const res = search({
    q,
    pincode,
    region_id: dest.region_id,
    category: sp.get('category'),
    facets,
    sort: sp.get('sort') ?? 'recommended',
    // A table column header. Validated against COLUMN_SORTS inside search().
    column_sort: sp.get('col'),
    column_dir: sp.get('dir') === 'desc' ? 'desc' : sp.get('dir') === 'asc' ? 'asc' : null,
    // Drill into one seller's matching stock; the list is one card per vendor otherwise.
    vendor_id: sp.get('vendor_id') ?? undefined,
    qty: sp.get('qty') ? Number(sp.get('qty')) : undefined,
    // 24 is the page, but the whole result set is reachable — the list used to
    // stop at 24 with no control to go further, which quietly hid most of the
    // sellers for any deep category. Capped at 500 so a hand-written URL cannot
    // ask for an unbounded render.
    limit: Math.min(500, Math.max(1, Number(sp.get('limit')) || 24)),
    offset: sp.get('offset') ? Number(sp.get('offset')) : 0,
  });

  if (q.trim()) logSearch(q, dest.region_id, res.total);

  res.timings.route = performance.now() - t0;
  return NextResponse.json(res, {
    headers: { 'x-buildo-query-ms': res.timings.total.toFixed(2), 'cache-control': 'no-store' },
  });
}
