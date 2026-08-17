import Link from 'next/link';

/**
 * A real 404, with a real status code — served for any path the catch-all
 * does not recognise, including a coming-soon category typed by hand.
 */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="mx-auto max-w-[56ch] text-center">
        <p className="eyebrow">Not found</p>
        <h1 className="display text-[26px] mt-2">There is no page here.</h1>
        <p className="mt-3 text-[14px]" style={{ color: 'var(--ink-2)' }}>
          The catalogue is one click away, and every category in it is a real listing.
        </p>
        <Link href="/" className="btn-primary inline-flex items-center mt-6 h-10 px-5 text-[13.5px]">
          Back to the catalogue
        </Link>
      </div>
    </main>
  );
}
