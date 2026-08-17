/**
 * Time, rendered the same on the server and in the browser.
 *
 * The catalogue is server-rendered on a UTC machine and hydrated in an IST
 * browser. `toLocaleString()` on each side gives two different strings for one
 * instant, and React then throws the whole server tree away and paints again
 * (error #418). So: one fixed zone, and the arithmetic done by hand rather
 * than by an ICU that also differs between Node and Chrome in whether it puts
 * a narrow no-break space before "am".
 */

const IST_OFFSET_MIN = 5 * 60 + 30; // no DST
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "17 Aug 2026, 7:39 am" in IST, for any ISO string or Date. */
export function formatIST(when: string | Date): string {
  const d = typeof when === 'string' ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + IST_OFFSET_MIN * 60_000);
  const day = t.getUTCDate();
  const mon = MONTHS[t.getUTCMonth()];
  const year = t.getUTCFullYear();
  const h24 = t.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${year}, ${h12}:${mm} ${h24 < 12 ? 'am' : 'pm'}`;
}
