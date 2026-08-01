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

export function armNetworkGuard(): void {
  if (armed) return;
  armed = true;
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    violations.push(url);
    throw new Error(
      `[BuildO] Law 1 violation: the query path attempted an outbound request to ${url}. ` +
      `Prices are served from the local store only; collection is asynchronous and offline.`,
    );
  }) as typeof globalThis.fetch;
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
