import type { Metadata } from 'next';
import { Instrument_Serif, Inter_Tight, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * Type.
 *
 * next/font downloads these at BUILD time and serves them from this origin, so
 * the page makes no request to a font CDN at runtime and "nothing here touches
 * the cloud" stays true.
 *
 * Instrument Serif carries the display voice and the hero price; Inter Tight
 * every piece of UI text; JetBrains Mono every figure, because a column of
 * prices has to align on the decimal.
 */
const display = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  display: 'swap',
  variable: '--font-instrument-serif',
});

const ui = Inter_Tight({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter-tight',
});

const figure = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

export const metadata: Metadata = {
  title: 'BuildO Price Intelligence',
  description:
    'Delivered, pincode-resolved, GST-stated, unit-normalised, timestamped prices for construction materials in Hyderabad and Vijayawada.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // One appearance. There is no theme toggle and no prefers-color-scheme
    // branch — the palette is Alabaster, and it is the only one.
    <html lang="en" className={`${display.variable} ${ui.variable} ${figure.variable}`}>
      <body>{children}</body>
    </html>
  );
}
