/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module: it must stay external to the server
  // bundle, and it is the reason the query path has no network hop at all.
  serverExternalPackages: ['better-sqlite3'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // The store is data, not code, so nothing imports it and the tracer cannot
  // see it. Without this the deployed functions ship without a database and
  // every query 500s on a missing file.
  outputFileTracingIncludes: {
    '/**': ['./data/buildo.prod.db'],
  },
  // Product thumbnails come from source CDNs and are rendered with a plain
  // <img>, so no remote loader configuration is needed. Nothing here is
  // fetched at request time on the server.
  images: { unoptimized: true },
};

export default nextConfig;
