import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";
import prettier from "eslint-config-prettier";

/**
 * Flat ESLint config for the isolated Next.js app (`@pma/web`).
 *
 * The repo root `eslint .` ignores `apps/web/**` (the backend uses a strict
 * NodeNext config that doesn't fit a React/JSX app). This config layers the
 * React Hooks rules + Next.js core-web-vitals rules on top of the shared
 * TS/JS recommended sets, scoped to this package. Generated output and Next's
 * own `.next/` artifacts are ignored.
 */
export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", ".next/**", "next-env.d.ts"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // The data-fetching effects here intentionally reset to a "loading" state
      // when their inputs change before kicking off an aborted async fetch — a
      // standard, correct pattern. react-hooks v7's new `set-state-in-effect`
      // rule flags this; disable it (the cascading-render concern doesn't apply
      // to a one-shot loading reset guarded by an AbortController).
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  prettier,
);
