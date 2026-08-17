/**
 * Browser-assisted capture — BigBMart (Hyderabad construction-materials platform).
 *
 * BigBMart serves a "Checking your browser before accessing" interstitial to a
 * scripted client, so this was captured through the in-app browser: the page
 * context holds the clearance cookie, so every category page was fetched from
 * inside it (fetch with credentials) and parsed with DOMParser. Captured
 * 2026-08-17 — every page of /product-category/cement/, /tmt-bars/ and
 * /bricks-and-blocks/ (10 pages, 149 cards). BigBMart has no water-pipe
 * category. Prices were unchanged from the 2026-08-01 capture; what this
 * refresh changes is the date they were seen, which is what freshness is.
 *
 * Every row below is the figure BigBMart published that day. `sale` is the
 * price shown to the buyer and `mrp` the struck-through reference — stored as
 * distinct fields, because rendering a strike-through reference as if it were a
 * price is the exact move the spec forbids (an ex-GST or MRP figure is not a
 * price).
 *
 * Rows the site files under a construction category but which are neither the
 * category nor the region — one Bengaluru-delivery listing, seventeen river and
 * playground sand listings, wall putty, grout, a waterproofing compound — are
 * dropped here (21 of 149); the plausibility rules would refuse them at load
 * anyway.
 */
import type { RawOffer } from '../types';

interface Row { title: string; sale: string; mrp: string; href: string; cat: string }

export const CAPTURED_AT = '2026-08-17T08:10:00.000Z';
export const PAGES_FETCHED = 10;

export const ROWS: Row[] = [
  // ── cement (₹ per 50 kg bag) ────────────────────────────────────────────
  { title: 'UltraTech Super Cement', sale: '305.00', mrp: '370.00', href: 'https://bigbmart.com/product/ultratech-super-cement/', cat: 'cement' },
  { title: 'ACC Suraksha PPC Cement', sale: '280.00', mrp: '360.00', href: 'https://bigbmart.com/product/acc-suraksha-ppc-cement/', cat: 'cement' },
  { title: 'Ultratech PPC Super Cement', sale: '325.00', mrp: '390.00', href: 'https://bigbmart.com/product/ultratech-ppc-super-cement/', cat: 'cement' },
  { title: 'JSW Concreel Cement', sale: '285.00', mrp: '370.00', href: 'https://bigbmart.com/product/jsw-concreel-cement/', cat: 'cement' },
  { title: 'ACC Suraksha OPC Cement', sale: '295.00', mrp: '390.00', href: 'https://bigbmart.com/product/acc-suraksha-opc-cement/', cat: 'cement' },
  { title: 'MP Birla Perfect Cement Concrete Plus', sale: '360.00', mrp: '400.00', href: 'https://bigbmart.com/product/mp-birla-perfect-cement-concrete-plus/', cat: 'cement' },
  { title: 'KCP OPC Cement', sale: '320.00', mrp: '400.00', href: 'https://bigbmart.com/product/kcp-opc-cement/', cat: 'cement' },
  { title: 'Bangur PPC Cement', sale: '270.00', mrp: '350.00', href: 'https://bigbmart.com/product/bangur-ppc-cement/', cat: 'cement' },
  { title: 'UltraTech PSC Cement', sale: '320.00', mrp: '380.00', href: 'https://bigbmart.com/product/ultratech-psc-cement/', cat: 'cement' },
  { title: 'Chettinad 53 Grade OPC Cement', sale: '335.00', mrp: '360.00', href: 'https://bigbmart.com/product/chettinad-53-grade-opc-cement/', cat: 'cement' },
  { title: 'Birla A1 Orient Green Cement', sale: '310.00', mrp: '400.00', href: 'https://bigbmart.com/product/birla-a1-orient-green-cement/', cat: 'cement' },
  { title: 'ACC Concrete OPC Cement', sale: '350.00', mrp: '400.00', href: 'https://bigbmart.com/product/acc-concrete-opc-cement/', cat: 'cement' },
  { title: 'Dalmia OPC Cement', sale: '330.00', mrp: '370.00', href: 'https://bigbmart.com/product/dalmia-opc-cement/', cat: 'cement' },
  { title: 'Birla Shakti OPC Cement', sale: '285.00', mrp: '350.00', href: 'https://bigbmart.com/product/birla-shakti-opc-cement/', cat: 'cement' },
  { title: 'Ambuja OPC Cement', sale: '350.00', mrp: '390.00', href: 'https://bigbmart.com/product/ambuja-opc-cement/', cat: 'cement' },
  { title: 'Ambuja PPC Cement', sale: '330.00', mrp: '370.00', href: 'https://bigbmart.com/product/ambuja-ppc-cement/', cat: 'cement' },
  { title: 'Bangur OPC Cement', sale: '305.00', mrp: '380.00', href: 'https://bigbmart.com/product/bangur-opc-cement/', cat: 'cement' },
  { title: 'Nagarjuna PPC Cement', sale: '265.00', mrp: '340.00', href: 'https://bigbmart.com/product/nagarjuna-ppc-cement/', cat: 'cement' },
  { title: 'KCP PPC Cement', sale: '290.00', mrp: '395.00', href: 'https://bigbmart.com/product/kcp-ppc-cement/', cat: 'cement' },
  { title: 'ACC Suraksha Power Plus Cement', sale: '340.00', mrp: '370.00', href: 'https://bigbmart.com/product/acc-suraksha-power-plus-cement/', cat: 'cement' },
  { title: 'MP Birla Samrat PPC Cement', sale: '300.00', mrp: '390.00', href: 'https://bigbmart.com/product/mp-birla-samrat-ppc-cement/', cat: 'cement' },
  { title: 'Parasakti PPC Cement', sale: '285.00', mrp: '360.00', href: 'https://bigbmart.com/product/parasakti-ppc-cement/', cat: 'cement' },
  { title: 'Nagarjuna OPC Cement', sale: '305.00', mrp: '390.00', href: 'https://bigbmart.com/product/nagarjuna-opc-cement/', cat: 'cement' },
  { title: 'Chettinad 43 Grade PPC Cement', sale: '330.00', mrp: '350.00', href: 'https://bigbmart.com/product/chettinad-43-grade-ppc-cement/', cat: 'cement' },
  { title: 'Parasakti OPC Cement', sale: '310.00', mrp: '360.00', href: 'https://bigbmart.com/product/parasakti-opc-cement/', cat: 'cement' },
  { title: 'JSW PSC Cement', sale: '290.00', mrp: '350.00', href: 'https://bigbmart.com/product/jsw-psc-cement/', cat: 'cement' },
  { title: 'Coromandel King PPC Cement', sale: '330.00', mrp: '390.00', href: 'https://bigbmart.com/product/coromandel-king-ppc-cement/', cat: 'cement' },
  { title: 'Birla Shakti PPC Cement', sale: '280.00', mrp: '390.00', href: 'https://bigbmart.com/product/birla-shakti-ppc-cement/', cat: 'cement' },
  { title: 'Dalmia Vajram PPC Cement', sale: '299.00', mrp: '340.00', href: 'https://bigbmart.com/product/dalmia-vajram-ppc-cement/', cat: 'cement' },
  { title: 'Bharathi Ultrafast Cement', sale: '315.00', mrp: '390.00', href: 'https://bigbmart.com/product/bharathi-ultrafast-cement/', cat: 'cement' },
  { title: 'Coromandel King OPC Cement', sale: '350.00', mrp: '395.00', href: 'https://bigbmart.com/product/coromandel-king-opc-cement/', cat: 'cement' },
  { title: 'Bharathi PPC Cement', sale: '300.00', mrp: '410.00', href: 'https://bigbmart.com/product/bharathi-ppc-cement/', cat: 'cement' },
  { title: 'Maha PPC Cement', sale: '285.00', mrp: '350.00', href: 'https://bigbmart.com/product/maha-ppc-cement/', cat: 'cement' },
  { title: 'Maha OPC Cement', sale: '310.00', mrp: '390.00', href: 'https://bigbmart.com/product/maha-opc-cement/', cat: 'cement' },
  { title: 'CCI OPC Cement', sale: '320.00', mrp: '390.00', href: 'https://bigbmart.com/product/cci-opc-cement/', cat: 'cement' },
  { title: 'Birla Gold OPC Cement', sale: '360.00', mrp: '375.00', href: 'https://bigbmart.com/product/birla-gold-opc-cement/', cat: 'cement' },
  { title: 'Deccan PPC Cement', sale: '325.00', mrp: '345.00', href: 'https://bigbmart.com/product/deccan-ppc-cement/', cat: 'cement' },
  { title: 'Deccan OPC Cement', sale: '340.00', mrp: '380.00', href: 'https://bigbmart.com/product/deccan-opc-cement/', cat: 'cement' },
  { title: 'CCI PPC Cement', sale: '295.00', mrp: '350.00', href: 'https://bigbmart.com/product/cci-ppc-cement/', cat: 'cement' },
  { title: 'Birla Gold PPC Cement', sale: '335.00', mrp: '360.00', href: 'https://bigbmart.com/product/birla-gold-ppc-cement/', cat: 'cement' },
  { title: 'Birla A1 PPC Cement', sale: '360.00', mrp: '380.00', href: 'https://bigbmart.com/product/birla-a1-ppc-cement/', cat: 'cement' },
  { title: 'Birla A1 OPC Cement', sale: '370.00', mrp: '410.00', href: 'https://bigbmart.com/product/birla-a1-opc-cement/', cat: 'cement' },
  { title: 'Bhavya PPC Cement', sale: '335.00', mrp: '360.00', href: 'https://bigbmart.com/product/bhavya-ppc-cement/', cat: 'cement' },
  { title: 'Bhavya OPC Cement', sale: '305.00', mrp: '380.00', href: 'https://bigbmart.com/product/bhavya-opc-cement/', cat: 'cement' },
  { title: 'Anjani Super Gold Cement', sale: '299.00', mrp: '340.00', href: 'https://bigbmart.com/product/anjani-super-gold-cement/', cat: 'cement' },

  // ── TMT (₹ per tonne, as BigBMart quotes it) ────────────────────────────
  { title: 'Shree TMT Xtra 10mm Steel Bars', sale: '57800.00', mrp: '62100.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-10mm-steel-bars/', cat: 'tmt_steel' },
  { title: '16mm Vizag TMT Bars', sale: '51500.00', mrp: '71000.00', href: 'https://bigbmart.com/product/16mm-vizag-tmt-bars/', cat: 'tmt_steel' },
  { title: 'Vizag TMT Bars – 12mm', sale: '51500.00', mrp: '71000.00', href: 'https://bigbmart.com/product/vizag-tmt-bars-12mm/', cat: 'tmt_steel' },
  { title: '8mm Vizag TMT Bar', sale: '54000.00', mrp: '73500.00', href: 'https://bigbmart.com/product/8mm-vizag-tmt-bar/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 8mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-8mm/', cat: 'tmt_steel' },
  { title: '10mm Vizag TMT Bars', sale: '52500.00', mrp: '72000.00', href: 'https://bigbmart.com/product/10mm-vizag-tmt-bars/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600+ 12mm TMT Steel Bar', sale: '51250.00', mrp: '68220.00', href: 'https://bigbmart.com/product/ms-life-steel-600-12mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 10mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-10mm/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 8mm TMT Steel Bar', sale: '47200.00', mrp: '59500.00', href: 'https://bigbmart.com/product/sugna-fe-550-8mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 16mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-16mm/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 16mm TMT Steel Bar', sale: '46500.00', mrp: '61700.00', href: 'https://bigbmart.com/product/af-star-fe-550-16mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 10mm TMT Steel Bar', sale: '48000.00', mrp: '59000.00', href: 'https://bigbmart.com/product/af-star-fe-550-10mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 12mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-12mm/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 32mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-32mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 12mm TMT Steel Bar', sale: '48000.00', mrp: '62000.00', href: 'https://bigbmart.com/product/af-star-fe-550-12mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 8mm Fe-550 Grade', sale: '49500.00', mrp: '65000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-8mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: '20mm Vizag TMT Bars', sale: '51500.00', mrp: '71000.00', href: 'https://bigbmart.com/product/20mm-vizag-tmt-bars/', cat: 'tmt_steel' },
  { title: 'Shree TMT Xtra 16mm Steel Bars', sale: '56500.00', mrp: '61500.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-16mm-steel-bars/', cat: 'tmt_steel' },
  { title: 'Shree TMT Xtra 12mm Steel Bars', sale: '56500.00', mrp: '61000.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-12mm-steel-bars/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 12mm TMT Steel Bar', sale: '46200.00', mrp: '58000.00', href: 'https://bigbmart.com/product/sugna-fe-550-12mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 10mm TMT Steel Bar', sale: '47200.00', mrp: '57000.00', href: 'https://bigbmart.com/product/sugna-fe-550-10mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 8mm TMT Steel Bar', sale: '48000.00', mrp: '61000.00', href: 'https://bigbmart.com/product/af-star-fe-550-8mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600 16mm TMT Steel Bar', sale: '51250.00', mrp: '66660.00', href: 'https://bigbmart.com/product/ms-life-steel-600-16mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Shree TMT Xtra 08mm Steel Bars', sale: '57800.00', mrp: '61400.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-08mm-steel-bars/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 12mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-12mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 25mm TMT Steel Bar', sale: '46200.00', mrp: '55500.00', href: 'https://bigbmart.com/product/sugna-fe-550-25mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 20mm TMT Steel Bar', sale: '48000.00', mrp: '61500.00', href: 'https://bigbmart.com/product/af-star-fe-550-20mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600+ 25mm TMT Steel Bar', sale: '51250.00', mrp: '68000.00', href: 'https://bigbmart.com/product/ms-life-steel-600-25mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600+ 10mm TMT Steel Bar', sale: '52450.00', mrp: '69000.00', href: 'https://bigbmart.com/product/ms-life-steel-600-10mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Thermax Fe-550D 16mm TMT Steel Bar', sale: '55500.00', mrp: '75660.00', href: 'https://bigbmart.com/product/radha-thermax-fe-550d-16mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Thermax Fe-550D 10mm TMT Steel Bar', sale: '56000.00', mrp: '78000.00', href: 'https://bigbmart.com/product/radha-thermax-fe-550d-10mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 16mm Fe-550 Grade', sale: '48500.00', mrp: '65000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-16mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 12mm Fe-550 Grade', sale: '48500.00', mrp: '64200.00', href: 'https://bigbmart.com/product/radha-tmt-bar-12mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 20mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-20mm/', cat: 'tmt_steel' },
  { title: 'Vinayak TMT Bars – 25mm', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/vinayak-tmt-bars-25mm/', cat: 'tmt_steel' },
  { title: '32mm Vinayak TMT Bars', sale: '46500.00', mrp: '53000.00', href: 'https://bigbmart.com/product/32mm-vinayak-tmt-bars/', cat: 'tmt_steel' },
  { title: '32mm Vizag TMT Bars', sale: '51500.00', mrp: '71000.00', href: 'https://bigbmart.com/product/32mm-vizag-tmt-bars/', cat: 'tmt_steel' },
  { title: '25mm Vizag TMT Bars', sale: '51500.00', mrp: '71000.00', href: 'https://bigbmart.com/product/25mm-vizag-tmt-bars/', cat: 'tmt_steel' },
  { title: 'SHREE TMT XTRA 550 TMT Bars – 32mm', sale: '57800.00', mrp: '62100.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-550-tmt-bars-32mm/', cat: 'tmt_steel' },
  { title: 'SHREE TMT XTRA 550 TMT Bars – 25mm', sale: '56500.00', mrp: '61599.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-550-tmt-bars-25mm/', cat: 'tmt_steel' },
  { title: 'Shree TMT Xtra 20mm Steel Bars', sale: '56500.00', mrp: '61455.00', href: 'https://bigbmart.com/product/shree-tmt-xtra-20mm-steel-bars/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 25mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-25mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 20mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-20mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 16mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-16mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 10mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-10mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Dwaraka 550 8mm TMT Steel Bar', sale: '49500.00', mrp: '54000.00', href: 'https://bigbmart.com/product/dwaraka-550-8mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 32mm TMT Steel Bar', sale: '47200.00', mrp: '59000.00', href: 'https://bigbmart.com/product/sugna-fe-550-32mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 20mm TMT Steel Bar', sale: '46200.00', mrp: '56000.00', href: 'https://bigbmart.com/product/sugna-fe-550-20mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Sugna Fe 550 16mm TMT Steel Bar', sale: '46200.00', mrp: '56000.00', href: 'https://bigbmart.com/product/sugna-fe-550-16mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'AF Star Fe 550 25mm TMT Steel Bar', sale: '46500.00', mrp: '60500.00', href: 'https://bigbmart.com/product/af-star-fe-550-25mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600 20mm TMT Steel Bar', sale: '51250.00', mrp: '67000.00', href: 'https://bigbmart.com/product/ms-life-steel-600-20mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'MS Life Steel 600+ 8mm TMT Steel Bar', sale: '52450.00', mrp: '67000.00', href: 'https://bigbmart.com/product/ms-life-steel-600-8mm-tmt-steel-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Thermax Fe-550D 32mm TMT Steel Bar', sale: '55750.00', mrp: '76000.00', href: 'https://bigbmart.com/product/radha-thermax-fe-550d-32mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Thermax Fe-550D 12mm TMT Steel Bar', sale: '56000.00', mrp: '78000.00', href: 'https://bigbmart.com/product/radha-thermax-fe-550d-12mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Thermax Fe-550D 8mm TMT Steel Bar', sale: '56000.00', mrp: '78000.00', href: 'https://bigbmart.com/product/radha-thermax-fe-550d-8mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha Fe-550 8mm TMT Steel Bar', sale: '49500.00', mrp: '80000.00', href: 'https://bigbmart.com/product/radha-fe-550-8mm-tmt-steel-bar-radha-tmt-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 32mm Fe-550 Grade', sale: '48500.00', mrp: '64000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-32mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 28mm Fe-550 Grade', sale: '48500.00', mrp: '64000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-28mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 25mm Fe-550 Grade', sale: '48500.00', mrp: '64000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-25mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },
  { title: 'Radha TMT Bar 10mm Fe-550 Grade', sale: '49500.00', mrp: '65000.00', href: 'https://bigbmart.com/product/radha-tmt-bar-10mm-fe-550-grade-radha-rhino-tmt-bar-big-b-mart/', cat: 'tmt_steel' },

  // ── bricks & blocks (₹ per piece) ───────────────────────────────────────
  { title: 'ABP Red Brick', sale: '8.00', mrp: '9.50', href: 'https://bigbmart.com/product/abp-red-brick/', cat: 'bricks_blocks' },
  { title: 'Karimnagar SRB Red Bricks', sale: '9.00', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-srb-red-bricks/', cat: 'bricks_blocks' },
  { title: 'Birla Aerocon AAC Blocks', sale: '42.50', mrp: '96.50', href: 'https://bigbmart.com/product/birla-aerocon-aac-blocks/', cat: 'bricks_blocks' },
  { title: 'Fly Ash Bricks', sale: '7.50', mrp: '9.50', href: 'https://bigbmart.com/product/fly-ash-bricks/', cat: 'bricks_blocks' },
  { title: 'Karimnagar SVT Red Bricks', sale: '10.50', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-svt-red-bricks/', cat: 'bricks_blocks' },
  { title: 'Karimnagar PVC Red Brick', sale: '11.30', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-pvc-red-brick/', cat: 'bricks_blocks' },
  { title: 'Karnataka Red Bricks', sale: '9.00', mrp: '10.00', href: 'https://bigbmart.com/product/karnataka-red-bricks/', cat: 'bricks_blocks' },
  { title: 'Cement Solid Blocks', sale: '9.00', mrp: '', href: 'https://bigbmart.com/product/cement-solid-blocks/', cat: 'bricks_blocks' },
  { title: 'Aerobild AAC Blocks', sale: '38.00', mrp: '87.50', href: 'https://bigbmart.com/product/aerobild-aac-blocks/', cat: 'bricks_blocks' },
  { title: 'Karimnagar MBC Red Bricks', sale: '11.20', mrp: '13.50', href: 'https://bigbmart.com/product/karimnagar-mbc-red-bricks/', cat: 'bricks_blocks' },
  { title: 'Greenstone AAC Blocks', sale: '44.00', mrp: '96.00', href: 'https://bigbmart.com/product/greenstone-aac-blocks/', cat: 'bricks_blocks' },
  { title: 'Karimnagar VBS Red Brick', sale: '10.50', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-vbs-red-brick/', cat: 'bricks_blocks' },
  { title: 'Karimnagar VBI Red Brick', sale: '10.30', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-vbi-red-brick/', cat: 'bricks_blocks' },
  { title: 'Karimnagar ABP Red Brick', sale: '10.00', mrp: '12.00', href: 'https://bigbmart.com/product/karimnagar-abp-red-brick/', cat: 'bricks_blocks' },
  { title: 'Karimnagar ABN Bricks', sale: '10.00', mrp: '11.00', href: 'https://bigbmart.com/product/karimnagar-abn-bricks/', cat: 'bricks_blocks' },
];

/** The unit BigBMart actually quotes in, per category. */
const UNIT: Record<string, string> = {
  cement: 'Bag',
  bricks_blocks: 'Piece',
  tmt_steel: 'Ton',
};

/**
 * BigBMart is a Hyderabad-headquartered platform that also delivers into
 * coastal AP. Its rate is recorded for both target regions, and the freight
 * model then prices the actual distance to the entered pincode — which is the
 * whole point: the same seller rate lands at a different delivered price in
 * Vijayawada than in Hyderabad.
 */
export function toRawOffers(): RawOffer[] {
  const out: RawOffer[] = [];
  for (const r of ROWS) {
    const sale = Number(r.sale);
    if (!sale) continue;
    const mrp = Number(r.mrp) || null;
    const slug = r.href.split('/').filter(Boolean).pop() ?? r.title;

    for (const region_id of ['hyderabad', 'vijayawada']) {
      out.push({
        source_id: 'bigbmart',
        source_class: 'platform',
        fetch_mode: 'browser',
        source_url: r.href,
        source_ref: `bigbmart:${slug}:${region_id}`,
        fetched_at: CAPTURED_AT,
        region_id,
        category: r.cat,
        platform: 'BigBMart',
        title: r.title,
        brand: null,
        vendor_name: 'BigBMart',
        vendor_locality: 'Hyderabad',
        vendor_city: 'Hyderabad',
        vendor_profile_url: 'https://bigbmart.com/',
        seller_type: 'platform',
        price_text: `₹${r.sale} / ${UNIT[r.cat]}${mrp ? ` (struck-through reference ₹${r.mrp})` : ''}`,
        price_paise: Math.round(sale * 100),
        price_unit: UNIT[r.cat],
        // A retail platform quoting a consumer price in India is quoting a
        // tax-inclusive figure.
        gst_treatment: 'INCL',
        gst_note: 'Retail platform consumer price; treated as GST-inclusive and decomposed back to an ex-GST base for the landed calculation.',
        mrp_paise: mrp ? Math.round(mrp * 100) : null,
        stock_state: 'unknown',
        specs: {},
        images: [],
      });
    }
  }
  return out;
}
