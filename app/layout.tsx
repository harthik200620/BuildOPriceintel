import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * Type — the Build Objects type program.
 *
 * Three families, all served from public/fonts on this origin. The files ship
 * with their SIL OFL licences in public/fonts/LICENSES, which the licence
 * requires to travel with the fonts. No request leaves for a font CDN, so
 * "nothing here touches the cloud" stays true.
 *
 *   Display 2 (Audiowide)     — the title voice: the wordmark and headings.
 *   Sans 5    (Encode Sans)   — the sub-title voice, and every figure.
 *   Sans 3    (Arimo, Arial-metric) — every piece of body and UI text.
 *
 * Two constraints decided the mapping, and both come from the type program's
 * own README rather than taste:
 *
 *   Audiowide has NO rupee sign. It ships 369 glyphs of basic Latin and stops
 *   there. Put it on a price and every ₹ falls back to a system font at an
 *   unrelated advance width, inside right-aligned columns that exist to align.
 *   So it sets titles — Latin words — and never a number.
 *
 *   Arial cannot be shipped. Windows' copy is licensed for Windows use only.
 *   Sans 3 is Arimo, Google's Arial-metric-compatible font (ChromeOS's Arial):
 *   identical metrics, so nothing reflows, and it is free to bundle.
 *
 * Figures move from a monospace to Encode Sans with tabular-nums. A monospace
 * earned its constant advance in the money COLUMN, where rows align on the
 * decimal; tabular figures give the same per-digit alignment in a proportional
 * face, and Encode Sans carries a full-weight ₹. Verified by
 * scripts/typography-probe.ts, not assumed.
 */
const display = localFont({
  src: [{ path: '../public/fonts/BuildObjectsDisplay2-Regular.woff2', weight: '400', style: 'normal' }],
  display: 'swap',
  variable: '--font-display-face',
  // Single-word fallbacks ONLY. next/font writes this list into the CSS
  // variable UNQUOTED, and an unquoted multi-word family name ("Build Objects
  // Sans 5") is invalid CSS — which does not skip that one entry, it discards
  // the whole font-family declaration, and the element silently inherits the
  // body face. That is exactly how the wordmark shipped in Arimo instead of
  // Audiowide once. The ₹-bearing fallback lives in --font-display in
  // globals.css instead, where it can be quoted.
  fallback: ['system-ui', 'sans-serif'],
});

const ui = localFont({
  src: [
    { path: '../public/fonts/BuildObjectsSans3-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans3-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans3-SemiBold.woff2', weight: '600', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans3-Bold.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-ui-face',
  fallback: ['Arial', 'Helvetica', 'system-ui', 'sans-serif'],
});

const figure = localFont({
  src: [
    { path: '../public/fonts/BuildObjectsSans5-Light.woff2', weight: '300', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans5-Regular.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans5-Medium.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans5-SemiBold.woff2', weight: '600', style: 'normal' },
    { path: '../public/fonts/BuildObjectsSans5-Bold.woff2', weight: '700', style: 'normal' },
  ],
  display: 'swap',
  variable: '--font-figure-face',
  fallback: ['system-ui', 'sans-serif'],
});

export const metadata: Metadata = {
  title: 'Build Objects Price Intelligence',
  description:
    'Delivered, pincode-resolved, GST-stated, unit-normalised, timestamped prices for construction materials in Hyderabad and Vijayawada.',
};

/**
 * Without this the mobile browser chrome stays white above a page that is not.
 * The value is --abyss, the same floor the aurora is painted onto.
 *
 * It lives on `viewport`, not `metadata` — Next moved themeColor there in 14
 * and warns at build time if it is left on the metadata export.
 */
export const viewport: Viewport = {
  themeColor: '#04141a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // One appearance. There is no theme toggle and no prefers-color-scheme
    // branch — the palette is Patina, and it is the only one.
    <html lang="en" className={`${display.variable} ${ui.variable} ${figure.variable}`}>
      <body>
        {/* The ground, on its own compositor layer. Real elements rather than
            pseudo-elements on html/body: the stacking there depends on which
            ancestor happens to carry a background, which is precisely how the
            previous theme's blooms ended up painted over and invisible.
            Order matters — .grain sits above .aurora and below everything. */}
        <div className="aurora" aria-hidden="true" />
        <div className="grain" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
