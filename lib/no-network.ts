/**
 * Law 1, enforced rather than promised: a user-initiated read never issues an
 * outbound request.
 *
 * The arithmetic behind the law: a live fan-out is 60 calls at an observed p95
 * of 2.8 s (HTML) to 8.0 s (JS-rendered), which is ~16.8 s against a 200 ms
 * budget — 84× over. It is not a tuning problem, it is two orders of magnitude.
 *
 * So rather than trusting that nobody adds a fetch() to a route handler one
 * day, the request path installs a guard: any attempt to reach the network
 * while a request is in flight throws, loudly, with the offending URL. Whether
 * this guard is armed is reported by /api/meta, and tests/no-network.ts proves
 * it fires.
 */

let armed = false;
let violations: string[] = [];
const realFetch: typeof globalThis.fetch = globalThis.fetch;

/**
 * Hosts the guard lets through, and the reason each one is here.
 *
 * The law is "a user-initiated read never issues an outbound request" and the
 * arithmetic behind it is about PRICE SOURCES: 60 marketplace calls at a 2.8 s
 * p95 against a 200 ms budget. The assistant's model host is a different
 * animal — it is on the conversational path, not the price path, and it never
 * returns a price. Blanket-bypassing the guard for it would give up the
 * protection everywhere; naming it keeps every other host blocked, so a
 * `fetch('https://indiamart.com/...')` added to a route handler next year
 * still throws exactly as it does today.
 *
 * A host is added here only if it cannot return catalogue data. That is the
 * test, and it is why no marketplace, directory or brand site can ever qualify.
 */
const ALLOWED_HOSTS = new Map<string, string>([
  ['generativelanguage.googleapis.com', 'the assistant\'s model host — conversational path, returns no price data'],
]);

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

export function isAllowedHost(url: string): boolean {
  return ALLOWED_HOSTS.has(hostOf(url));
}

export function armNetworkGuard(): void {
  if (armed) return;
  armed = true;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (isAllowedHost(url)) return realFetch(input, init);
    violations.push(url);
    throw new Error(
      `[Build Objects] Law 1 violation: the query path attempted an outbound request to ${url}. ` +
      `Prices are served from the local store only; collection is asynchronous and offline.`,
    );
  }) as typeof globalThis.fetch;
}

/** What the guard permits, for /api/meta to publish alongside its state. */
export function allowedHosts(): Array<{ host: string; why: string }> {
  return [...ALLOWED_HOSTS].map(([host, why]) => ({ host, why }));
}

export function guardState() {
  return { armed, violations: [...violations] };
}

/** Only the collector may lift the guard — it is the asynchronous write path. */
export function withNetwork<T>(fn: () => T): T {
  const saved = globalThis.fetch;
  globalThis.fetch = realFetch;
  try {
    return fn();
  } finally {
    globalThis.fetch = saved;
  }
}

export function resetViolations() {
  violations = [];
}
