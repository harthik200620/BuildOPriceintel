import { NextRequest, NextResponse } from 'next/server';
import { runTurn, WELCOME, type ChatMessage } from '@/lib/chat/engine';
import { GeminiKeyMissing, hasKey, GEMINI_MODEL } from '@/lib/chat/gemini';
import { armNetworkGuard } from '@/lib/no-network';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

armNetworkGuard();

/**
 * A token bucket, per client.
 *
 * One turn can cost four tool rounds plus a repair, so an unthrottled endpoint
 * is an unthrottled spend — and this route has no auth in front of it. The
 * bucket is deliberately generous enough that a person typing cannot feel it
 * and a loop hits it in about a second.
 *
 * In-memory on purpose: this is one Node process serving one machine, and a
 * Redis dependency for a local app would be ceremony. If it is ever fronted by
 * more than one instance, this becomes per-instance and needs replacing — which
 * is worth knowing before that day rather than after.
 */
const RATE = { capacity: 8, refillPerSec: 0.5 };
const buckets = new Map<string, { tokens: number; at: number }>();

function takeToken(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: RATE.capacity, at: now };
  b.tokens = Math.min(RATE.capacity, b.tokens + ((now - b.at) / 1000) * RATE.refillPerSec);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / RATE.refillPerSec) };
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  // Cheap sweep so a long-lived process does not accumulate a bucket per IP
  // forever. Full buckets are indistinguishable from absent ones.
  if (buckets.size > 1000) {
    for (const [k, v] of buckets) if (v.tokens >= RATE.capacity) buckets.delete(k);
  }
  return { ok: true, retryAfter: 0 };
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0] : null)?.trim() || req.headers.get('x-real-ip') || 'local';
}

/**
 * Progress streams; the answer does not.
 *
 * Token-streaming an LLM answer is the expected thing and it is wrong here.
 * The grounding validator needs a complete draft before it can hold it against
 * the ledger, so streamed tokens would put unvalidated text on screen and then
 * retract it — which is worse than waiting, because the retracted number is
 * the one the user remembers.
 *
 * So what streams is the work: "searching cement", "pricing 3 lines". The
 * answer arrives once, already checked. The wait feels shorter than it is for
 * the same reason a progress bar does, and nothing on screen is ever wrong.
 */
export async function POST(req: NextRequest) {
  const gate = takeToken(clientIp(req));
  if (!gate.ok) {
    return NextResponse.json(
      { error: 'RATE_LIMITED', message: 'Too many questions at once. Give it a second.' },
      { status: 429, headers: { 'retry-after': String(gate.retryAfter), 'cache-control': 'no-store' } },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });

  const message = String(body.message ?? '').slice(0, 2000);
  const pincode = String(body.pincode ?? '500001');
  const history: ChatMessage[] = Array.isArray(body.history)
    ? body.history
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-16)
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
    : [];

  /*
   * No key pre-check here on purpose.
   *
   * `runTurn` runs the pincode gate and the scope gate BEFORE it needs a
   * model, so a refusal is answerable with no key at all. Checking the key
   * first turned "What is the capital of France?" into a configuration error
   * instead of the refusal it should be — and made the guard rails, which are
   * the part worth demonstrating, undemonstrable until someone pastes a key
   * in. The engine still throws GeminiKeyMissing the moment a turn actually
   * needs the model, and that is caught below.
   */
  const stream = body.stream !== false;
  if (!stream) {
    try {
      const r = await runTurn({ message, history, pincode });
      return NextResponse.json(r, { headers: { 'cache-control': 'no-store' } });
    } catch (e: any) {
      if (e instanceof GeminiKeyMissing) return NextResponse.json({ error: 'NO_API_KEY', message: e.message }, { status: 503 });
      return NextResponse.json({ error: 'ENGINE_FAILED', message: String(e?.message ?? e) }, { status: 500 });
    }
  }

  const encoder = new TextEncoder();
  const rs = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const hb = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 15000);

      try {
        send('status', { stage: 'thinking' });
        const r = await runTurn({ message, history, pincode });
        for (const c of r.trace.tool_calls) send('tool', { name: c.name, ok: c.ok, ms: c.ms });
        send('message', r);
      } catch (e: any) {
        send('error', {
          code: e instanceof GeminiKeyMissing ? 'NO_API_KEY' : 'ENGINE_FAILED',
          message: e instanceof GeminiKeyMissing
            ? 'The assistant needs a Gemini API key. Add GEMINI_API_KEY=... to .env.local and restart the dev server.'
            : String(e?.message ?? e),
        });
      } finally {
        clearInterval(hb);
        send('done', {});
        controller.close();
      }
    },
  });

  return new Response(rs, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** The opening state: greeting, chips, and whether the key is even configured. */
export async function GET() {
  return NextResponse.json(
    { ...WELCOME, ready: hasKey(), model: GEMINI_MODEL },
    { headers: { 'cache-control': 'no-store' } },
  );
}
