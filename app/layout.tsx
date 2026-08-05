import type { Metadata, Viewport } from 'next';
import { Fraunces, Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * Type.
 *
 * next/font downloads these at BUILD time and serves them from this origin, so
 * the page makes no request to a font CDN at runtime and "nothing here touches
 * the cloud" stays true.
 *
 * Geist sets every piece of UI text and Geist Mono every figure — one family
 * for the label and the number under it. Fraunces carries the display voice and
 * the hero price, and nothing else: it was asked to set 13 px table numerals
 * under the old arrangement, which is the one thing a display serif is worst at.
 *
 * These were measured before they were chosen, against next's own bundled
 * capsize metrics. The number that decided it: Geist Mono's average advance is
 * 0.6000 em, identical to the JetBrains Mono it replaces, so every fixed-width
 * money column keeps its budget exactly.
 *
 * `latin-ext` is not decoration. **₹ is U+20B9, which Google serves from the
 * latin-ext partition, not latin.** Naming it here means a face that lacks it
 * fails at build time; leaving it implicit means the leading glyph of every
 * price on the site silently falls back to a system font at an unrelated
 * advance width, inside right-aligned columns that exist to align.
 *
 * Weight is omitted on all three, which selects the variable font. The design
 * is single-weight, but eleven <strong> elements resolve through Preflight's
 * `bolder` to a real 700 rather than a synthesised one.
 */
const display = Fraunces({
  subsets: ['latin', 'latin-ext'],
  // Optical size, 9-144. This is why Fraunces and not a static serif: .display
  // spans 15-24 px and the hero spans 19-38 px, and an opsz axis draws each of
  // those properly instead of scaling one cut and correcting it by hand with
  // negative tracking. SOFT and WONK are left at their 0 defaults — the
  // restrained end, which is the register this page is in.
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-display-face',
});

const ui = Geist({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-ui-face',
});

const figure = Geist_Mono({
  subsets: ['latin', 'latin-ext'],
  display: 'swap',
  variable: '--font-figure-face',
});

export const metadata: Metadata = {
  title: 'BuildO Price Intelligence',
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
