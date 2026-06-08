/**
 * Layer 1 — rules/metadata pre-filter for the same-question matching engine
 * (design.md `matchMarket` → "Layer 1 — rules + metadata pre-filter"; the
 * "Same-Question Matching Flow" diagram; task 6.1).
 *
 * This layer cheaply narrows the universe of markets to a small candidate pool
 * before the (more expensive) Layer 2 semantic-similarity pass. It builds a
 * {@link CandidateQuery} from four deterministic signals derived from the
 * candidate market and hands it to {@link MatchingRepository.findCandidates}:
 *
 *   1. **category**      — the candidate's normalized {@link Category}.
 *   2. **time window**   — a window `around(endDate)` (design `around(...)`),
 *                          anchored on the resolution cutoff or the end date.
 *   3. **subject entity**— a rules-based subject extracted from the question
 *                          text (e.g. `"BTC"`, `"Donald Trump"`); see
 *                          {@link extractSubjectEntity}.
 *   4. **threshold**     — a numeric threshold extracted from the question
 *                          (e.g. `100000` from "$100,000"); see
 *                          {@link extractThreshold}.
 *
 * Everything here is **pure and deterministic** (no I/O, no clock, no
 * randomness) except {@link findCandidatePool}, which is the single seam that
 * calls the repository. That keeps the extraction heuristics trivially testable
 * and makes Layer 1's output reproducible for a given question string.
 *
 * The normalized {@link Market} domain type intentionally carries neither
 * `category` nor `endDate` (those live on the owning event / canonical event
 * and are denormalized at the storage layer — see design.md "Data Models").
 * Layer 1 therefore takes a {@link MatchCandidate} wrapper that supplies the
 * market plus its `category` and `endDate` context.
 *
 * Requirements: 11.1 (the matching engine evaluates a market via a
 * rules/metadata pre-filter — category, time window, subject entity, threshold
 * — before semantic similarity).
 */

import type { Category, CandidateQuery, Market, MatchingRepository, TimeWindow } from "@pma/core";

/**
 * Input to Layer 1: the candidate {@link Market} plus the `category` and
 * `endDate` context the normalized model does not carry on the market row.
 *
 * `endDate` is the owning event's resolution/end date (ISO 8601) and is used as
 * the time-window anchor when the market's `resolutionCriteria.cutoffTime` is
 * absent. Both may be `null`; see {@link resolveTimeAnchor} for the precedence.
 */
export interface MatchCandidate {
  /** The persisted candidate market (its `id` is excluded from the pool). */
  market: Market;
  /** The candidate's normalized category (denormalized from its event). */
  category: Category;
  /** ISO 8601 resolution/end date of the owning event; `null` when unknown. */
  endDate: string | null;
}

/** Tuning knobs for {@link buildCandidateQuery} / {@link findCandidatePool}. */
export interface Layer1Options {
  /**
   * Half-width of the time window, in days, applied on each side of the time
   * anchor (`around(anchor) = [anchor - windowDays, anchor + windowDays]`).
   * Defaults to {@link DEFAULT_WINDOW_DAYS}.
   */
  windowDays?: number;
}

/** Default time-window half-width (± days around the anchor). */
export const DEFAULT_WINDOW_DAYS = 7;

/** Milliseconds in one day. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Lower/upper bounds used when a candidate has no usable time anchor (no
 * cutoff and no end date, or an unparseable one). The window is left wide open
 * so candidates are not dropped purely for lacking a date — Layer 2 and the
 * other signals still constrain the pool. Documented behavior, not a sentinel
 * the caller must special-case.
 */
export const OPEN_WINDOW_FROM = "1900-01-01T00:00:00.000Z";
export const OPEN_WINDOW_TO = "9999-12-31T23:59:59.999Z";

// ---------------------------------------------------------------------------
// Subject-entity extraction
// ---------------------------------------------------------------------------

/**
 * Canonical crypto tickers keyed by the lowercase aliases (full names and
 * ticker symbols) that may appear in a question. Matching is by whole word so
 * "eth" matches in "Will ETH flip BTC?" but not inside "ethics". This curated
 * set is intentionally small and high-precision; unknown assets fall through
 * to the proper-noun heuristic or yield `null`.
 */
const CRYPTO_ALIASES: ReadonlyMap<string, string> = new Map([
  ["btc", "BTC"],
  ["bitcoin", "BTC"],
  ["eth", "ETH"],
  ["ethereum", "ETH"],
  ["sol", "SOL"],
  ["solana", "SOL"],
  ["doge", "DOGE"],
  ["dogecoin", "DOGE"],
  ["ada", "ADA"],
  ["cardano", "ADA"],
  ["xrp", "XRP"],
  ["ripple", "XRP"],
  ["ltc", "LTC"],
  ["litecoin", "LTC"],
  ["bnb", "BNB"],
  ["matic", "MATIC"],
  ["polygon", "MATIC"],
  ["avax", "AVAX"],
  ["avalanche", "AVAX"],
]);

/**
 * Capitalized words that should NOT seed a proper-noun run. These are common
 * question-leading words (capitalized only because they start the sentence)
 * and frequent function words, so dropping them avoids mistaking "Will" /
 * "The" for a subject. Compared case-insensitively.
 */
const PROPER_NOUN_STOPWORDS: ReadonlySet<string> = new Set([
  "will",
  "who",
  "what",
  "which",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "the",
  "a",
  "an",
  "does",
  "do",
  "did",
  "has",
  "have",
  "had",
  "can",
  "could",
  "would",
  "should",
  "by",
  "in",
  "on",
  "at",
  "of",
  "to",
  "for",
  "and",
  "or",
  "but",
  "if",
  "than",
  "then",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
]);

/** A word token (letters plus internal apostrophes/periods) with its offset. */
interface WordToken {
  text: string;
  start: number;
  end: number;
}

/** Matches word tokens such as "Donald", "McConnell", "U.S", "O'Brien". */
const WORD_TOKEN_RE = /[A-Za-z][A-Za-z'’.]*/g;

/** True when a token is Title-case ("Donald", "Fed") — not an acronym ("NASA"). */
function isTitleCaseWord(text: string): boolean {
  return /^[A-Z][a-z]/.test(text);
}

/** Find the earliest crypto alias mention; returns its canonical ticker or null. */
function findCryptoTicker(question: string): string | null {
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestTicker: string | null = null;
  for (const [alias, ticker] of CRYPTO_ALIASES) {
    // Whole-word, case-insensitive match.
    const re = new RegExp(`\\b${alias}\\b`, "i");
    const m = re.exec(question);
    if (m !== null && m.index < bestIndex) {
      bestIndex = m.index;
      bestTicker = ticker;
    }
  }
  return bestTicker;
}

/** Find the leftmost contiguous run of Title-case, non-stopword words. */
function findProperNounRun(question: string): string | null {
  const tokens: WordToken[] = [];
  WORD_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TOKEN_RE.exec(question)) !== null) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const run: WordToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;

    const qualifies =
      isTitleCaseWord(token.text) && !PROPER_NOUN_STOPWORDS.has(token.text.toLowerCase());

    if (!qualifies) {
      if (run.length > 0) break; // first completed run wins
      continue;
    }

    // Only extend the run when the previous token is separated by whitespace
    // alone (so punctuation between two names breaks the run).
    const prev = run[run.length - 1];
    if (prev !== undefined) {
      const between = question.slice(prev.end, token.start);
      if (!/^\s+$/.test(between)) {
        break; // punctuation boundary ends the leftmost run
      }
    }
    run.push(token);
  }

  if (run.length === 0) return null;
  return run.map((t) => t.text).join(" ");
}

/**
 * Extract a subject entity from a question using deterministic, rule-based
 * heuristics. Returns `null` when nothing is confidently found.
 *
 * Heuristics, applied in order of precedence:
 *
 *  1. **Crypto assets** — a curated map of well-known names/tickers
 *     ({@link CRYPTO_ALIASES}) matched by whole word, normalized to the
 *     canonical uppercase ticker ("Bitcoin" / "btc" → `"BTC"`). The earliest
 *     mention in the string wins. This runs first because crypto subjects are
 *     high-precision and often lowercase ("will bitcoin hit 100k").
 *  2. **Proper-noun run** — the leftmost contiguous run of Title-case words
 *     that are not common question/function words ("Will Donald Trump win?" →
 *     `"Donald Trump"`). A punctuation boundary ends the run.
 *
 * Limits (documented, deliberate): acronyms ("NASA", "FED" in all caps) and
 * subjects written lower-case outside the crypto map are NOT recognized;
 * Title-case detection is English-oriented; the extractor returns at most one
 * subject (the leftmost) and never guesses across punctuation. These false
 * negatives are safe for a pre-filter — Layer 2 still compares full question
 * text — and the `null` result simply widens the candidate pool on that signal.
 *
 * @param question Raw market question text.
 * @returns A canonical subject string, or `null` when none is confident.
 */
export function extractSubjectEntity(question: string): string | null {
  if (typeof question !== "string" || question.trim() === "") return null;

  const ticker = findCryptoTicker(question);
  if (ticker !== null) return ticker;

  return findProperNounRun(question);
}

// ---------------------------------------------------------------------------
// Threshold extraction
// ---------------------------------------------------------------------------

/** Multipliers for magnitude suffixes (letter and word forms). */
const MAGNITUDE_SUFFIXES: ReadonlyMap<string, number> = new Map([
  ["thousand", 1e3],
  ["k", 1e3],
  ["million", 1e6],
  ["mn", 1e6],
  ["m", 1e6],
  ["billion", 1e9],
  ["bn", 1e9],
  ["b", 1e9],
  ["trillion", 1e12],
  ["t", 1e12],
]);

/**
 * Matches a numeric threshold with optional `$` prefix, comma grouping,
 * decimal, magnitude suffix, and trailing `%`. The suffix is `\b`-anchored so a
 * stray letter from the next word ("100 marbles") is not read as a multiplier.
 */
const THRESHOLD_RE =
  /(\$)?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*(thousand|million|billion|trillion|bn|mn|k|m|b|t)\b)?(?:\s*(%))?/gi;

/** A single parsed numeric candidate from the question. */
interface ThresholdMatch {
  value: number;
  /** "Strong" matches carry a `$`, a magnitude suffix, or a `%`. */
  strong: boolean;
  /** Whether the bare integer looks like a calendar year (1900–2099). */
  looksLikeYear: boolean;
}

/** Parse one regex match into a {@link ThresholdMatch}, or null if unusable. */
function parseThresholdMatch(m: RegExpExecArray): ThresholdMatch | null {
  const dollar = m[1];
  const numberRaw = m[2];
  const suffix = m[3];
  const percent = m[4];
  if (numberRaw === undefined) return null;

  const digits = numberRaw.replace(/,/g, "");
  const base = Number.parseFloat(digits);
  if (!Number.isFinite(base)) return null;

  const multiplier = suffix !== undefined ? (MAGNITUDE_SUFFIXES.get(suffix.toLowerCase()) ?? 1) : 1;

  const hasDollar = dollar !== undefined;
  const hasPercent = percent !== undefined;
  const hasSuffix = suffix !== undefined;
  const strong = hasDollar || hasPercent || hasSuffix;

  // A percentage is returned as written ("5%" → 5), not as a fraction.
  const value = base * multiplier;

  const isInteger = !digits.includes(".");
  const looksLikeYear = !strong && isInteger && base >= 1900 && base <= 2099 && digits.length === 4;

  return { value, strong, looksLikeYear };
}

/**
 * Extract a numeric threshold from a question. Deterministic; returns `null`
 * when no usable number is present.
 *
 * Supported forms: `$100,000`, `100,000`, `$100k`, `1.5m`, `$2bn`, `50 million`,
 * `5%`. Magnitude suffixes (`k`, `m`/`mn`/`million`, `b`/`bn`/`billion`,
 * `t`/`trillion`) and the thousands separator are applied; a `$` prefix, a
 * magnitude suffix, or a trailing `%` mark a match as **strong**.
 *
 * Selection rules (to avoid common false positives):
 *  - The leftmost **strong** match wins ("$100,000" beats a later bare number).
 *  - With no strong match, the leftmost plain number wins, **except** bare
 *    4-digit integers in 1900–2099, which are treated as calendar years and
 *    skipped ("Will Trump win the 2024 election?" → `null`).
 *  - Percentages return the percent value itself ("5%" → `5`).
 *
 * Limits: this is a syntactic extractor, not a unit-aware parser. It does not
 * disambiguate currencies, infer implied units, or read spelled-out numbers
 * ("one hundred"). A `null` result simply leaves the threshold unconstrained
 * for the pre-filter.
 *
 * @param question Raw market question text.
 * @returns The extracted threshold, or `null` when none is found.
 */
export function extractThreshold(question: string): number | null {
  if (typeof question !== "string" || question === "") return null;

  THRESHOLD_RE.lastIndex = 0;
  let firstNonYear: number | null = null;
  let match: RegExpExecArray | null;

  while ((match = THRESHOLD_RE.exec(question)) !== null) {
    // Guard against zero-length matches (shouldn't happen: group 2 needs a
    // digit) so the loop always advances.
    if (match[0] === "") {
      THRESHOLD_RE.lastIndex += 1;
      continue;
    }

    const parsed = parseThresholdMatch(match);
    if (parsed === null) continue;

    if (parsed.strong) return parsed.value; // leftmost strong match wins
    if (!parsed.looksLikeYear && firstNonYear === null) {
      firstNonYear = parsed.value; // remember leftmost plain (non-year) number
    }
  }

  return firstNonYear;
}

// ---------------------------------------------------------------------------
// Time window + query assembly
// ---------------------------------------------------------------------------

/**
 * Choose the time anchor: the market's resolution `cutoffTime` when present,
 * otherwise the supplied `endDate`. Returns `null` when neither is a parseable
 * ISO 8601 instant.
 */
export function resolveTimeAnchor(candidate: MatchCandidate): string | null {
  const cutoff = candidate.market.resolutionCriteria.cutoffTime;
  for (const value of [cutoff, candidate.endDate]) {
    if (value !== null && value !== undefined) {
      const ms = Date.parse(value);
      if (Number.isFinite(ms)) return value;
    }
  }
  return null;
}

/**
 * Build the time window `around(anchor)` (design `around(...)`): a symmetric
 * `± windowDays` interval around the resolution cutoff / end date. When the
 * candidate has no parseable anchor, returns the wide-open
 * `[OPEN_WINDOW_FROM, OPEN_WINDOW_TO]` window so a missing date never empties
 * the pool by itself.
 *
 * @param candidate The candidate supplying the anchor.
 * @param windowDays Half-width in days (defaults to {@link DEFAULT_WINDOW_DAYS}).
 */
export function buildTimeWindow(
  candidate: MatchCandidate,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): TimeWindow {
  const anchor = resolveTimeAnchor(candidate);
  if (anchor === null) {
    return { from: OPEN_WINDOW_FROM, to: OPEN_WINDOW_TO };
  }
  const anchorMs = Date.parse(anchor);
  const deltaMs = Math.abs(windowDays) * MS_PER_DAY;
  return {
    from: new Date(anchorMs - deltaMs).toISOString(),
    to: new Date(anchorMs + deltaMs).toISOString(),
  };
}

/**
 * Assemble the Layer-1 {@link CandidateQuery} for a candidate market: its
 * category, a time window around the end date, the extracted subject entity and
 * threshold, and `excludeMarketId` set to the candidate's own id so it never
 * matches itself.
 *
 * Pure and deterministic for a given candidate + options.
 */
export function buildCandidateQuery(
  candidate: MatchCandidate,
  options: Layer1Options = {},
): CandidateQuery {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  return {
    category: candidate.category,
    timeWindow: buildTimeWindow(candidate, windowDays),
    subjectEntity: extractSubjectEntity(candidate.market.question),
    threshold: extractThreshold(candidate.market.question),
    excludeMarketId: candidate.market.id,
  };
}

/**
 * Layer 1 entry point: build the {@link CandidateQuery} for `candidate` and run
 * it through {@link MatchingRepository.findCandidates}, returning the candidate
 * pool that Layer 2 (semantic similarity, task 6.2) consumes.
 *
 * This is the only function in the module that performs I/O.
 *
 * @param candidate The new/updated market being matched.
 * @param repo The matching repository (candidate search seam).
 * @param options Pre-filter tuning (time-window half-width).
 * @returns The pre-filtered candidate pool (possibly empty).
 */
export function findCandidatePool(
  candidate: MatchCandidate,
  repo: MatchingRepository,
  options: Layer1Options = {},
): Promise<Market[]> {
  const query = buildCandidateQuery(candidate, options);
  return repo.findCandidates(query);
}
