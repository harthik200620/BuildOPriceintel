import type { Metadata } from 'next';
import { ExplorerRoute, metadataFor, type Search } from './_routes/explorer';

/** "/" — the catalogue. See app/_routes/explorer.tsx. */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = metadataFor([]);

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  return <ExplorerRoute slug={[]} searchParams={await searchParams} />;
}
