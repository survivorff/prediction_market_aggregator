/**
 * Centralized Manifold → normalized-domain mapping.
 *
 * ALL platform-specific field knowledge lives here so the exact Manifold field
 * mapping is easy to adjust as the upstream API evolves. The adapter (index.ts)
 * only does I/O and delegates shaping to these pure functions.
 *
 * Mapping rules honored here (design "Manifold adapter notes"):
 * - Manifold "markets" are contracts. A binary contract's **`probability`
 *   field is the Yes implied probability**; the No probability is its
 *   complement. Probabilities are reconciled to sum to ≈ 1 and kept within
 *   [0, 1] via the core normalization helpers (Requirement 1.3).
 * - Manifold is play-money/off-chain: there are no on-chain outcome tokens, so
 *   every outcome's `tokenId` is `null`.
 * - `resolutionCriteria.raw` is ALWAYS preserved, even when structured fields
 *   cannot be parsed (Requirement 10.3). Manifold settles by creator
 *   resolution, so there is no external `dataSource` in the payload.
 * - Missing/optional upstream fields become explicit `null` — never throw
 *   (Requirement 1.5).
 * - `externalId` is the platform-native contract id (idempotency key component).
 *
 * These functions are PURE and have no I/O dependency. `now` is threaded in as
 * an explicit argument (not read from the global clock) so status derivation
 * stays deterministic and testable.
 */

import type {
  Category,
  NormalizedMarket,
  NormalizedOutcome,
  NormalizedPriceSnapshot,
  ResolutionCriteria,
} from "@pma/core";
import {
  isCategory,
  isMarketStatus,
  normalizeProbability,
  normalizeBinaryProbabilities,
  normalizeSpread,
  normalizeResolutionCriteria,
  type MarketStatus,
} from "@pma/core";
import {
  asArray,
  asBoolean,
  asFiniteNumberOrNull,
  asStringOrNull,
  getField,
  getFirstField,
  toIsoTimestampOrNull,
} from "./safe.js";

/** The canonical label used for the "Yes" outcome of a binary market. */
export const YES_LABEL = "Yes";
/** The canonical label used for the "No" outcome of a binary market. */
export const NO_LABEL = "No";

/**
 * Map a Manifold group slug / topic string onto the normalized {@link Category}
 * taxonomy. Unknown values fall back to `"other"` (design "Model Definitions").
 */
export function mapCategory(raw: unknown): Category {
  const value = asStringOrNull(raw);
  if (value === null) return "other";
  const lower = value.toLowerCase();
  if (isCategory(lower)) return lower;
  if (
    matchesAny(lower, [
      "politic",
      "politics",
      "election",
      "president",
      "presidential",
      "senate",
      "congress",
      "geopolitics",
      "trump",
      "biden",
    ])
  ) {
    return "politics";
  }
  if (matchesAny(lower, ["crypto", "bitcoin", "btc", "ethereum", "eth", "token", "coin", "defi"])) {
    return "crypto";
  }
  if (
    matchesAny(lower, [
      "sport",
      "sports",
      "nfl",
      "nba",
      "mlb",
      "soccer",
      "football",
      "tennis",
      "ufc",
      "olympics",
    ])
  ) {
    return "sports";
  }
  if (
    matchesAny(lower, [
      "economics",
      "economy",
      "inflation",
      "gdp",
      "fed",
      "rate",
      "cpi",
      "jobs",
      "recession",
      "finance",
    ])
  ) {
    return "economics";
  }
  if (
    matchesAny(lower, [
      "tech",
      "technology",
      "ai",
      "software",
      "apple",
      "google",
      "space",
      "science",
    ])
  ) {
    return "tech";
  }
  return "other";
}

/**
 * Whole-word keyword match against a free-text label.
 *
 * The label is split into alphanumeric word tokens. A keyword matches when a
 * token equals it, or — for keywords of length ≥ 4 — when a token begins with
 * it. This avoids substring false-positives where a short keyword would match
 * inside an unrelated word (e.g. "eth" inside "something").
 */
function matchesAny(label: string, keywords: readonly string[]): boolean {
  const tokens = label.split(/[^a-z0-9]+/i).filter((t) => t !== "");
  return tokens.some((token) =>
    keywords.some(
      (keyword) => token === keyword || (keyword.length >= 4 && token.startsWith(keyword)),
    ),
  );
}

/**
 * Derive a normalized {@link MarketStatus} from a Manifold contract.
 *
 * Manifold contracts are open until the creator resolves them. Precedence:
 * resolved (`isResolved`/`resolution`) → closed (a `closeTime` in the past) →
 * open. `now` is supplied explicitly so the function stays pure/deterministic.
 */
export function mapMarketStatus(raw: unknown, now: Date): MarketStatus {
  const explicit = asStringOrNull(getField(raw, "status"));
  if (explicit !== null && isMarketStatus(explicit.toLowerCase())) {
    return explicit.toLowerCase() as MarketStatus;
  }

  const resolved =
    asBoolean(getField(raw, "isResolved")) || asStringOrNull(getField(raw, "resolution")) !== null;
  if (resolved) return "resolved";

  const closeTime = toIsoTimestampOrNull(getField(raw, "closeTime"));
  if (closeTime !== null) {
    const closeMs = Date.parse(closeTime);
    if (!Number.isNaN(closeMs) && closeMs <= now.getTime()) return "closed";
  }
  return "open";
}

/**
 * Build a {@link ResolutionCriteria} from a Manifold contract, ALWAYS
 * preserving the raw criteria for auditability even when structured fields are
 * absent (Requirement 10.3).
 *
 * Manifold settles by **creator resolution**, so there is no external
 * `dataSource` in the payload (left `null`); the close time is captured as the
 * settlement `cutoffTime`. The resolution-relevant raw fields are preserved so
 * the matching engine (Layer 4) can inspect them later.
 */
export function mapResolutionCriteria(rawMarket: unknown): ResolutionCriteria {
  const cutoff = toIsoTimestampOrNull(getField(rawMarket, "closeTime"));

  const raw: Record<string, unknown> = {};
  for (const key of [
    "outcomeType",
    "mechanism",
    "isResolved",
    "resolution",
    "resolutionTime",
    "resolutionProbability",
    "closeTime",
    "textDescription",
    "description",
    "groupSlugs",
  ]) {
    const value = getField(rawMarket, key);
    if (value !== undefined) raw[key] = value;
  }

  return normalizeResolutionCriteria({
    dataSource: null,
    cutoffTime: cutoff,
    rounding: null,
    raw,
  });
}

/**
 * Map a Manifold contract's outcomes.
 *
 * - Multi-answer contracts (`answers: [{ text, probability }]`) map each answer
 *   to an outcome.
 * - Otherwise the contract is treated as **binary**: the `probability` field is
 *   the Yes implied probability and the No probability is its complement; the
 *   pair is reconciled to sum to ≈ 1 (Requirement 1.3).
 * - When no probability is available both outcomes carry `null` (Requirement
 *   1.5).
 *
 * Manifold is off-chain, so every `tokenId` is `null`.
 */
export function mapOutcomes(rawMarket: unknown): NormalizedOutcome[] {
  const answers = asArray(getField(rawMarket, "answers"));
  if (answers.length > 0) {
    return answers.map((answer, i) => {
      const label =
        asStringOrNull(getFirstField(answer, ["text", "answer", "label"])) ?? `Outcome ${i + 1}`;
      const prob = normalizeProbability(
        asFiniteNumberOrNull(getFirstField(answer, ["probability", "prob"])),
      );
      return makeOutcome(label, prob);
    });
  }

  const rawProb = asFiniteNumberOrNull(getFirstField(rawMarket, ["probability", "prob", "p"]));
  if (rawProb === null) {
    return [makeOutcome(YES_LABEL, null), makeOutcome(NO_LABEL, null)];
  }

  // Binary: Yes = probability, No = complement; reconcile to sum to ≈ 1.
  const { normalized } = normalizeBinaryProbabilities([rawProb, 1 - rawProb]);
  return [
    makeOutcome(YES_LABEL, normalized[0] ?? null),
    makeOutcome(NO_LABEL, normalized[1] ?? null),
  ];
}

/** A single off-chain outcome (`tokenId` null) with `impliedProb === lastPrice`. */
function makeOutcome(label: string, prob: number | null): NormalizedOutcome {
  const normalized = normalizeProbability(prob);
  return {
    label,
    tokenId: null,
    impliedProb: normalized,
    // For a binary market the last price of the outcome equals its probability.
    lastPrice: normalized,
  };
}

/**
 * Map a single raw Manifold contract into a {@link NormalizedMarket}.
 *
 * `externalId` is the platform-native contract id (idempotency key component).
 * Manifold has no first-class cross-market "event" resource, so a market is
 * grouped by its first group slug when present (`eventExternalId`). Numeric
 * metadata is normalized; missing values stay explicitly `null` (Requirement
 * 1.5).
 */
export function mapMarket(rawMarket: unknown, now: Date): NormalizedMarket | null {
  const externalId = asStringOrNull(getField(rawMarket, "id"));
  // Without a stable native id there is no idempotency key — skip it.
  if (externalId === null) return null;

  const question = asStringOrNull(getFirstField(rawMarket, ["question", "title"])) ?? "";

  return {
    externalId,
    eventExternalId: extractEventExternalId(rawMarket),
    question,
    status: mapMarketStatus(rawMarket, now),
    volume24h: asFiniteNumberOrNull(
      getFirstField(rawMarket, ["volume24Hours", "volume24hr", "volume24h"]),
    ),
    liquidity: asFiniteNumberOrNull(getFirstField(rawMarket, ["totalLiquidity", "liquidity"])),
    // Manifold's AMM does not expose a Yes-outcome best-ask/best-bid spread in
    // the contract payload; represent it as missing rather than fabricating one.
    spread: normalizeSpread(asFiniteNumberOrNull(getField(rawMarket, "spread"))),
    outcomes: mapOutcomes(rawMarket),
    resolutionCriteria: mapResolutionCriteria(rawMarket),
  };
}

/** Group a Manifold market by its first group slug (its closest "event"), or null. */
function extractEventExternalId(rawMarket: unknown): string | null {
  const slugs = asArray(getField(rawMarket, "groupSlugs"));
  for (const slug of slugs) {
    const value = asStringOrNull(slug);
    if (value !== null) return value;
  }
  return null;
}

/**
 * Map a Manifold contract's current `probability` into a Yes-outcome
 * {@link NormalizedPriceSnapshot}. Returns `null` when the probability cannot
 * be parsed (Requirement 1.5).
 */
export function mapPriceSnapshot(input: {
  marketExternalId: string;
  rawProbability: unknown;
  volume?: unknown;
  ts: string;
}): NormalizedPriceSnapshot | null {
  const price = normalizeProbability(asFiniteNumberOrNull(input.rawProbability));
  if (price === null) return null;
  return {
    marketExternalId: input.marketExternalId,
    outcomeLabel: YES_LABEL,
    price,
    volume: asFiniteNumberOrNull(input.volume),
    ts: input.ts,
  };
}

/**
 * Map a Manifold `/v0/bets` payload into a Yes-outcome price series.
 *
 * Each bet carries `probAfter` (the market's Yes probability *after* the bet)
 * and `createdTime` (epoch ms). Manifold returns bets newest-first; the result
 * is sorted ascending by timestamp so it renders as a continuous probability
 * curve (Requirement 4.2). Bets with an unparseable probability/time are
 * skipped rather than throwing (Requirement 1.5).
 */
export function mapBetsToPriceHistory(input: {
  marketExternalId: string;
  rawBets: unknown;
}): NormalizedPriceSnapshot[] {
  const bets = asArray(input.rawBets);
  const points: NormalizedPriceSnapshot[] = [];
  for (const bet of bets) {
    const ts = toIsoTimestampOrNull(getFirstField(bet, ["createdTime", "createdtime", "time"]));
    const price = normalizeProbability(
      asFiniteNumberOrNull(getFirstField(bet, ["probAfter", "probafter"])),
    );
    if (ts === null || price === null) continue;
    points.push({
      marketExternalId: input.marketExternalId,
      outcomeLabel: YES_LABEL,
      price,
      volume: asFiniteNumberOrNull(getFirstField(bet, ["amount", "shares"])),
      ts,
    });
  }
  points.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return points;
}
