/**
 * Normalized market/event category.
 *
 * Platform-agnostic taxonomy used across discovery filters, the matching
 * engine's Layer-1 pre-filter, and the comparison view. Adapters map their
 * native categories onto this closed set; anything that does not fit maps to
 * `"other"` (see design.md "Model Definitions").
 */
export type Category = "politics" | "crypto" | "sports" | "economics" | "tech" | "other";

/** All valid {@link Category} values, useful for validation and iteration. */
export const CATEGORIES: readonly Category[] = [
  "politics",
  "crypto",
  "sports",
  "economics",
  "tech",
  "other",
] as const;

/** Type guard: returns true when `value` is a valid {@link Category}. */
export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}
