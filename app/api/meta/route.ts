import { NextResponse } from 'next/server';
import { armNetworkGuard } from '@/lib/no-network';
import { buildMeta } from '@/lib/meta';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

/**
 * The same object the home page renders on the server — see lib/meta.ts. The
 * client re-fetches it here after mount so a region switch, a pincode change,
 * or a collection run that landed since the page was served all read current.
 */
export async function GET() {
  return NextResponse.json(buildMeta(), { headers: { 'cache-control': 'no-store' } });
}
