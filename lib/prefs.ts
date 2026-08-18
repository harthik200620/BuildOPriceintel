/**
 * Where the buyer is. Region and pincode are the one piece of state that
 * should survive a reload and a return visit — every price on the site is
 * landed at this pincode, and asking for it again on each visit would be
 * asking the same question twice.
 *
 * localStorage, guarded: private mode and some embedded browsers throw on
 * access, and a preference is never worth an exception.
 */

const KEY = 'buildobjects:where';

export interface Where { regionId: string; pincode: string }

export function readWhere(): Where | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (typeof j?.regionId !== 'string' || typeof j?.pincode !== 'string') return null;
    if (!/^\d{6}$/.test(j.pincode)) return null;
    return { regionId: j.regionId, pincode: j.pincode };
  } catch {
    return null;
  }
}

export function writeWhere(w: Where): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* a preference is never worth an exception */
  }
}

/**
 * Has this browser been through the front door?
 *
 * A separate key, and deliberately not "do we have a pincode": the effect that
 * persists `where` runs on the first render with the DEFAULT pincode already in
 * state, so a pincode exists from the first second of the first visit and can
 * never distinguish a new buyer from a returning one. This is written once,
 * when someone actually presses Get started.
 */
const SEEN_KEY = 'buildobjects:started';

export function hasStarted(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    // A browser that refuses storage would otherwise be shown the welcome
    // screen on every navigation. Assume they have started and let them in.
    return true;
  }
}

export function markStarted(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* a preference is never worth an exception */
  }
}
