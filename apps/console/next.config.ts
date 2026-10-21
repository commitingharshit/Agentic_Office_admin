import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Package uploads (Marketplace > Publish New) go through a server action; the API caps a package at 64 MiB.
  experimental: { serverActions: { bodySizeLimit: '64mb' } },
};
export default config;
