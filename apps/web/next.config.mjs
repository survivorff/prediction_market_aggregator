/**
 * Next.js configuration for @pma/web.
 *
 * The frontend talks ONLY to the project's own API gateway (`@pma/api`) over
 * HTTP via `NEXT_PUBLIC_API_BASE_URL` (Requirement 9.1) — it never imports a
 * server package or calls an upstream platform. `reactStrictMode` surfaces
 * effect bugs early. `eslint.ignoreDuringBuilds` keeps `next build` focused on
 * type/bundle correctness; linting runs as its own step (`next lint`).
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
