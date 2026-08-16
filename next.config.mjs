/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module: it must stay external to the server
  // bundle, and it is the reason the query path has no network hop at all.
  serverExternalPackages: ['better-sqlite3'],
  typescript: { ignoreBuildErrors: true },
  // No "N" badge in the corner. It is Next's dev-tools indicator, dev-only and
  // never in a production build — but it sits on top of the page during a
  // local demo, and this is a page people are shown.
  devIndicators: false,
  // The store is data, not code, so nothing imports it and the tracer cannot
  // see it. Without this the deployed functions ship without a database and
  // every query 500s on a missing file.
  outputFileTracingIncludes: {
    '/**': ['./data/buildobjects.prod.db'],
  },
  // Product thumbnails come from source CDNs and are rendered with a plain
  // <img>, so no remote loader configuration is needed. Nothing here is
  // fetched at request time on the server.
  images: { unoptimized: true },
};

export default nextConfig;
