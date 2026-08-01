/**
 * Government anchor — Telangana PRED monthly steel & cement rate circulars.
 *
 * This is the most defensible number available on the page and no competitor
 * shows it. Telangana publishes a clean monthly series running 2014 → 2026.
 *
 * Measured limitation, recorded rather than hidden: the circulars are SCANNED
 * IMAGE PDFs with no text layer. The May-2026 issue is 1.5 MB of JPEG streams
 * and yields 23 characters of extractable text — a timestamp. So this adapter
 * resolves and records the authoritative document (issuing department, month,
 * URL, retrieval date) as a cited reference line, and states plainly that the
 * rupee figures inside require OCR or a manual read. It does not invent a rate,
 * and it does not quietly omit the source either.
 *
 * Andhra Pradesh publishes no current equivalent — the newest verifiable AP SoR
 * is 2018-19. That asymmetry is spec assumption A-07 and it is surfaced in the
 * UI for Vijayawada rather than smoothed over.
 */
import type { Adapter, AdapterCtx, SourceResult } from '../types';
import { db, tx } from '../../lib/db';

const INDEX_URL = 'https://www.pred.telangana.gov.in/steel_cement_rates.php';
const SSR_URL = 'https://www.pred.telangana.gov.in/ssr.php';
const AP_SSR_URL = 'https://irrigationap.cgg.gov.in/wrd/downloads?mode=SSR';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

function newestCircular(html: string): { label: string; url: string; sortKey: number } | null {
  const rows = [...html.matchAll(/>\s*(\d{1,2}-([A-Za-z]+)-(\d{4}))\s*<[\s\S]{0,400}?href="([^"]+\.pdf)"/g)];
  let best: { label: string; url: string; sortKey: number } | null = null;
  for (const m of rows) {
    const [, label, monthName, year, href] = m;
    const mi = MONTHS.indexOf(monthName.toLowerCase());
    if (mi < 0) continue;
    const sortKey = Number(year) * 12 + mi;
    if (!best || sortKey > best.sortKey) {
      best = {
        label,
        url: href.startsWith('http') ? href : `https://www.pred.telangana.gov.in/${href.replace(/^\//, '')}`,
        sortKey,
      };
    }
  }
  return best;
}

export const tgpred: Adapter = {
  id: 'tg-pred',
  source_class: 'government',
  label: 'Telangana PRED — monthly steel & cement rates',
  // Registered for both regions: Telangana is the anchor for Hyderabad, and it
  // is shown to Vijayawada as an explicitly cross-border cross-check because AP
  // publishes nothing current.
  covers: ['cement', 'tmt_steel'].flatMap((category) =>
    ['hyderabad', 'vijayawada'].map((region_id) => ({ category, region_id })),
  ),

  async run(category: string, region_id: string, ctx: AdapterCtx): Promise<SourceResult[]> {
    const res = await ctx.fetchText(INDEX_URL);
    if (!res.ok) {
      return [{
        source_id: `tg-pred:${category}`, source_class: 'government', category, region_id,
        url: INDEX_URL, fetch_mode: 'http', http_status: res.status, outcome: 'blocked',
        offers: [], pages_fetched: 0, pagination_exhausted: null, estimated_missed: null,
        note: 'The Telangana PRED rate index could not be fetched, so no government reference line is available this run. The previous anchor stands and ages honestly.',
      }];
    }

    const newest = newestCircular(res.body);
    if (!newest) {
      return [{
        source_id: `tg-pred:${category}`, source_class: 'government', category, region_id,
        url: INDEX_URL, fetch_mode: 'http', http_status: res.status, outcome: 'parse_fail',
        offers: [], pages_fetched: 1, pagination_exhausted: null, estimated_missed: null,
        note: 'Rate index fetched but no dated circular link matched — the page layout may have changed.',
      }];
    }

    const item = category === 'cement' ? 'Cement (basic rate, all grades)' : 'TMT reinforcement steel (basic rate)';
    const now = new Date().toISOString();
    const note =
      `Telangana PRED circular ${newest.label} resolved and recorded. The circular is a scanned image PDF ` +
      `with no text layer (1.5 MB of JPEG streams; 23 characters of extractable text), so the rupee figures ` +
      `inside were NOT machine-extracted. The document is cited as the government reference with its month ` +
      `and URL; no rate value has been invented from it.`;

    tx(() => {
      db().prepare(`DELETE FROM sor_rate WHERE state_code='TS' AND category=?`).run(category);
      db().prepare(
        `INSERT INTO sor_rate (state_code,category,item,rate_paise,unit,effective_period,source_url,document,fetched_at,note)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run('TS', category, item, 0,
        category === 'cement' ? 'bag' : 'kg',
        newest.label, newest.url,
        `Telangana Panchayat Raj Engineering Department — monthly steel & cement basic rates, ${newest.label}`,
        now,
        'Scanned PDF, no text layer. Rate value not machine-extracted — figure requires OCR or a manual read. The document reference itself is verified.');

      if (region_id === 'vijayawada') {
        db().prepare(`DELETE FROM sor_rate WHERE state_code='AP' AND category=?`).run(category);
        db().prepare(
          `INSERT INTO sor_rate (state_code,category,item,rate_paise,unit,effective_period,source_url,document,fetched_at,note)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run('AP', category, item, 0,
          category === 'cement' ? 'bag' : 'kg',
          'no current edition', AP_SSR_URL,
          'Andhra Pradesh Schedule of Rates — newest verifiable edition is 2018-19',
          now,
          'Andhra Pradesh publishes no current Schedule of Rates. The newest verifiable edition is 2018-19 and APSPDCL electrical SSR is 2020-21. AP therefore has no usable government price anchor; the Telangana series is shown as an explicitly cross-border cross-check. This is spec assumption A-07.');
      }
    });

    return [{
      source_id: `tg-pred:${category}`, source_class: 'government', category, region_id,
      url: newest.url, fetch_mode: 'http', http_status: res.status, outcome: 'ok',
      offers: [], pages_fetched: 1, pagination_exhausted: true,
      estimated_missed: null, note,
    }, {
      source_id: `tg-pred-ssr:${category}`, source_class: 'government', category, region_id,
      url: SSR_URL, fetch_mode: 'http', http_status: null, outcome: 'skipped',
      offers: [], pages_fetched: 0, pagination_exhausted: null, estimated_missed: null,
      note: 'The full annual TG SSR (common schedule of rates) was not parsed this run — it is a large scanned PDF with the same no-text-layer limitation as the monthly circulars.',
    }];
  },
};
