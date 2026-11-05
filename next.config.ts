import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Authenticated tenant pages are private/no-store by default (plan §4.4).
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
