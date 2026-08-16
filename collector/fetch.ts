/**
 * Polite HTTP. Concurrency 2, a delay between requests to the same host, an
 * identifying User-Agent, and bounded retries.
 *
 * Node's built-in fetch decompresses gzip/br automatically, which matters:
 * IndiaMART serves brotli and a naive client reads 22 KB of binary instead of
 * 208 KB of listings.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36 BuildObjects-PriceIntel/0.1 (local research build)';

/**
 * Politeness, tuned against a real 429 rather than guessed.
 *
 * A 1.4 s gap at concurrency 2 was enough to get this client rate-limited by
 * IndiaMART mid-sweep, which cost a whole pass. The base gap is now 3.5 s and
 * the per-host delay ADAPTS: every 429 doubles that host's gap (to a 30 s
 * ceiling) and holds it there, and a long cool-off is served before retrying.
 * Being throttled costs far more time than being slow does.
 */
const BASE_HOST_DELAY_MS = 3500;
const MAX_HOST_DELAY_MS = 30_000;
const COOLOFF_MS = 90_000;
const MAX_CONCURRENCY = 2;

const lastHit = new Map<string, number>();
const hostDelay = new Map<string, number>();
let active = 0;
const queue: Array<() => void> = [];

function delayFor(host: string): number {
  return hostDelay.get(host) ?? BASE_HOST_DELAY_MS;
}

function backoff(host: string): number {
  const next = Math.min(MAX_HOST_DELAY_MS, delayFor(host) * 2);
  hostDelay.set(host, next);
  return next;
}

/**
 * Circuit breaker. After this many 429s from one host we stop asking for the
 * rest of the run and return immediately, so a throttled source costs seconds
 * rather than burning the whole pass on cool-offs. Every skipped request is
 * still logged as `rate_limited` with an estimate of what was behind it — the
 * breaker bounds the work, it does not hide that the work was bounded.
 */
const BREAKER_TRIP_AT = 3;
const strikes = new Map<string, number>();

export function isTripped(host: string): boolean {
  return (strikes.get(host) ?? 0) >= BREAKER_TRIP_AT;
}

/** Exposed so the collector can report throttling honestly in its log. */
export function throttleState(): Array<{ host: string; delayMs: number; strikes: number; tripped: boolean }> {
  const hosts = new Set([...hostDelay.keys(), ...strikes.keys()]);
  return [...hosts].map((host) => ({
    host,
    delayMs: hostDelay.get(host) ?? BASE_HOST_DELAY_MS,
    strikes: strikes.get(host) ?? 0,
    tripped: isTripped(host),
  }));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENCY) {
    await new Promise<void>((res) => queue.push(res));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  url: string;
  /** Set when this request tripped a 429 and widened the host's gap. */
  throttledTo?: number;
  /** Set when the host's circuit breaker is open and the request was not sent. */
  breakerOpen?: boolean;
}

export async function fetchText(url: string, opts: { retries?: number; timeoutMs?: number } = {}): Promise<FetchResult> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const host = new URL(url).host;

  if (isTripped(host)) {
    return { ok: false, status: 429, body: '', url, breakerOpen: true };
  }

  return slot(async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const gap = delayFor(host);
      const since = Date.now() - (lastHit.get(host) ?? 0);
      if (since < gap) await sleep(gap - since);
      lastHit.set(host, Date.now());

      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-IN,en;q=0.9,te;q=0.6,hi;q=0.5',
            'Cache-Control': 'no-cache',
          },
        });
        clearTimeout(t);
        const body = await res.text();
        if (res.status === 429 || res.status === 503) {
          // Widen this host's gap permanently for the rest of the run, then
          // serve a real cool-off. Hammering through a 429 is what lost the
          // last pass.
          const widened = backoff(host);
          strikes.set(host, (strikes.get(host) ?? 0) + 1);
          if (isTripped(host)) {
            return { ok: false, status: res.status, body, url: res.url || url, throttledTo: widened, breakerOpen: true };
          }
          if (attempt < retries) {
            const retryAfter = Number(res.headers.get('retry-after')) * 1000;
            await sleep(Math.max(COOLOFF_MS, retryAfter || 0));
            continue;
          }
          return { ok: false, status: res.status, body, url: res.url || url, throttledTo: widened };
        }
        return { ok: res.ok, status: res.status, body, url: res.url || url };
      } catch (e) {
        clearTimeout(t);
        if (attempt >= retries) {
          return { ok: false, status: 0, body: String((e as Error)?.message ?? e), url };
        }
        await sleep(1_500 * (attempt + 1));
      }
    }
    return { ok: false, status: 0, body: '', url };
  });
}

/** Classify a failure honestly rather than lumping everything into "error". */
export function classifyFailure(status: number, body: string) {
  const b = body.slice(0, 4000).toLowerCase();
  if (status === 429) return 'rate_limited' as const;
  if (/captcha|are you a robot|unusual traffic/.test(b)) return 'captcha' as const;
  if (status === 401 || status === 403 || /sign in|log ?in to (view|continue)/.test(b)) return 'login_wall' as const;
  if (status === 503 || status === 0 || status >= 500) return 'blocked' as const;
  if (status === 404) return 'empty' as const;
  return 'blocked' as const;
}
