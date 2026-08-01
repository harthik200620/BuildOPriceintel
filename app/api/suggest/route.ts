import { NextRequest, NextResponse } from 'next/server';
import { suggest } from '@/lib/search';
import { parseQuery } from '@/lib/query/parse';
import { resolvePincode } from '@/lib/price';
import { armNetworkGuard } from '@/lib/no-network';
import { CATEGORY_LABEL } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

export async function GET(req: NextRequest) {
  const t0 = performance.now();
  const sp = req.nextUrl.searchParams;
  const q = sp.get('q') ?? '';
  const pincode = sp.get('pincode') ?? '500001';
  const dest = resolvePincode(pincode);
  if (!dest) return NextResponse.json({ products: [], categories: [], trending: [], intent: [] });

  const parsed = parseQuery(q);
  const s = suggest(q, dest.region_id, 7);

  // Category intent chips: "Cement → OPC 53 / PPC / white"
  const intent = s.categories.map((c: any) => ({
    category: c.category,
    label: CATEGORY_LABEL[c.category] ?? c.category,
    count: c.n,
  }));

  return NextResponse.json({
    ...s,
    intent,
    parsed: {
      category: parsed.category,
      constraints: parsed.constraints,
      matched_vocabulary: parsed.matched_vocabulary,
      correction: parsed.correction,
      unit_bearing: parsed.unit_bearing,
    },
    ms: performance.now() - t0,
  }, { headers: { 'cache-control': 'no-store' } });
}
