import type { Metadata } from 'next';
import { ExplorerRoute, metadataFor, type Search } from '../_routes/explorer';

/** /c/<category> and /search — every path that is not "/". Anything the
    catalogue does not name is a real 404. See app/_routes/explorer.tsx. */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Params = { slug: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  return metadataFor((await params).slug);
}

export default async function Page({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<Search> }) {
  const { slug } = await params;
  return <ExplorerRoute slug={slug} searchParams={await searchParams} />;
}
