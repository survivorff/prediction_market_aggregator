import { defineWorkspace } from "vitest/config";

/**
 * Vitest workspace: two projects with different environments so the strict
 * backend packages (node) and the Next.js frontend (jsdom + React) coexist
 * under a single `npm test` / `vitest run` at the repo root.
 *
 *  - "node": the `packages/*` backend (unchanged behavior from the original
 *    single-config setup). Pure Node environment.
 *  - "web":  `apps/web` React components + API client. Runs in jsdom with
 *    Testing Library, the jest-dom matchers, and the automatic JSX runtime.
 */
export default defineWorkspace([
  {
    test: {
      name: "node",
      include: ["packages/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      environment: "node",
      globals: false,
    },
  },
  {
    // Vite-level config for the web project (JSX transform via esbuild).
    esbuild: { jsx: "automatic", jsxImportSource: "react" },
    test: {
      name: "web",
      root: "./apps/web",
      include: ["src/**/*.test.{ts,tsx}"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
      environment: "jsdom",
      globals: true,
      setupFiles: ["./vitest.setup.ts"],
      css: false,
    },
  },
]);
