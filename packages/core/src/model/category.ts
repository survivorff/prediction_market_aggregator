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

/**
 * Keyword groups for {@link inferCategory}, in precedence order. Each maps a set
 * of lowercase keywords to a {@link Category}. Keywords of length ≥ 4 match a
 * token prefix ("politic" → "politics"); shorter keywords ("btc", "ai", "nba")
 * must match a whole token, so they never fire inside an unrelated word.
 */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  [
    "crypto",
    ["crypto", "bitcoin", "btc", "ethereum", "eth", "solana", "sol", "bnb", "doge", "xrp", "token", "coin", "defi", "blockchain", "nft", "stablecoin", "altcoin"],
  ],
  [
    "politics",
    ["politic", "politics", "election", "president", "presidential", "senate", "congress", "governor", "parliament", "geopolitic", "trump", "biden", "putin", "war", "ceasefire", "sanction", "vote", "referendum", "primary", "nato"],
  ],
  [
    "sports",
    ["sport", "sports", "nfl", "nba", "mlb", "nhl", "epl", "soccer", "football", "basketball", "baseball", "tennis", "golf", "ufc", "boxing", "olympic", "olympics", "fifa", "championship", "playoff", "playoffs", "cup", "league", "match", "tournament", "esports", "cs2", "valorant"],
  ],
  [
    "economics",
    ["economic", "economics", "economy", "inflation", "gdp", "fed", "rate", "rates", "cpi", "jobs", "recession", "unemployment", "interest", "treasury", "tariff", "stock", "nasdaq", "earnings", "ipo", "market"],
  ],
  [
    "tech",
    ["tech", "technology", "ai", "agi", "llm", "software", "apple", "google", "microsoft", "openai", "anthropic", "nvidia", "spacex", "tesla", "space", "science", "chip", "semiconductor", "robot", "quantum"],
  ],
];

/** Split free text into lowercase alphanumeric word tokens. */
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/i).filter((t) => t !== "");
}

/**
 * Infer a normalized {@link Category} from free text (a market question and/or a
 * platform category hint), using deterministic keyword matching. Returns the
 * first category (in {@link CATEGORY_KEYWORDS} precedence) whose keywords appear
 * as a whole word (or a ≥4-char prefix) in the text; `"other"` when none match.
 *
 * Pure and deterministic. Used by adapters to derive the denormalized market
 * category at ingestion (the normalized domain `Market` carries no category —
 * it is projected onto the storage row from this hint). A platform-specific
 * label, when available, should be prepended to the text so it is weighted.
 */
export function inferCategory(text: string): Category {
  if (typeof text !== "string" || text.trim() === "") return "other";
  // If the text is itself an exact category label, honor it directly.
  const direct = text.trim().toLowerCase();
  if (isCategory(direct)) return direct;

  const tokens = tokenize(text);
  if (tokens.length === 0) return "other";
  const tokenSet = new Set(tokens);

  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    const hit = keywords.some((keyword) =>
      keyword.length >= 4
        ? tokens.some((token) => token === keyword || token.startsWith(keyword))
        : tokenSet.has(keyword),
    );
    if (hit) return category;
  }
  return "other";
}
