import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.tsbuildinfo",
      ".kiro/**",
      // apps/web is an isolated Next.js app (own tsconfig + `next lint`); it is
      // excluded from the backend's NodeNext flat config. See README "Frontend".
      "apps/web/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Disable stylistic rules that conflict with Prettier.
  prettier,
);
