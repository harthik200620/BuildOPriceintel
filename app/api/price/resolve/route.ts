import { NextRequest, NextResponse } from 'next/server';
import { resolvePrice, resolveBulk } from '@/lib/price';
import { armNetworkGuard } from '@/lib/no-network';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

/**
 * The one pricing contract, exposed. Every surface calls this — which is what
 * makes the price on the search card and the price in the list total the same
 * number by construction rather than by coincidence.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });

  if (Array.isArray(body.lines)) {
    const r = resolveBulk(body.lines, body.pincode ?? '500001');
    return NextResponse.json(r);
  }

  const q = resolvePrice({
    product_id: body.product_id,
    pincode: body.pincode ?? '500001',
    qty: body.qty,
    offer_id: body.offer_id,
  });
  if (!q) return NextResponse.json({ error: 'NO_OFFER', message: 'No offer for this product at this pincode.' }, { status: 404 });

  if (!q.quotable) {
    // 425 PRICE_EXPIRED / 409 QUOTE_BLOCKED — with a message written for the
    // customer, not the developer. No override path exists.
    const expired = q.freshness_state === 'EXPIRED';
    return NextResponse.json(
      { error: expired ? 'PRICE_EXPIRED' : 'QUOTE_BLOCKED', message: q.blocked_reason, quote: q },
      { status: expired ? 425 : 409 },
    );
  }

  return NextResponse.json(q);
}
