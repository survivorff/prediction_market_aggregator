/**
 * Centralized Polymarket → normalized-domain mapping.
 *
 * ALL platform-specific field knowledge lives here so the exact Gamma/CLOB
 * field mapping is easy to adjust as the upstream API evolves (task 4.4 will
 * pin these with recorded-fixture tests). The adapter (index.ts) only does I/O
 * and delegates shaping to these pure functions.
 *
 * Mapping rules honored here:
 * - A binary Yes/No market = two Polygon outcome tokens; the **Yes-token price
 *   is the implied probability** (design "Polymarket adapter notes").
 * - Probabilities are kept within [0, 1] and binary outcomes are reconciled to
 *   sum to ≈ 1 via the core normalization helpers (Requirement 1.3).
 * - `resolutionCriteria.raw` is ALWAYS preserved, even when structured fields
 *   cannot be parsed (Requirement 10.3).
 * - Missing/optional upstream fields become explicit `null` — never throw
 *   (Requirement 1.5).
 * - `externalId` is the platform-native id (idempotency key component).
 *
 * These functions are PURE and have no I/O dependency.
 */

import type {
  Category,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedOutcome,
  NormalizedPriceSnapshot,
  ResolutionCriteria,
} from "@pma/core";
import {
  isCategory,
  isMarketStatus,
  inferCategory,
  normalizeProbability,
  normalizeBinaryProbabilities,
  normalizeSpread,
  normalizeResolutionCriteria,
  type MarketStatus,
} from "@pma/core";
import {
  asArray,
  asFiniteNumberOrNull,
  asStringOrNull,
  asBoolean,
  getField,
  getFirstField,
  isRecord,
  parseStringifiedArray,
  toIsoTimestampOrNull,
} from "./safe.js";

/** The canonical label used for the "Yes" outcome of a binary market. */
export const YES_LABEL = "Yes";
/** The canonical label used for the "No" outcome of a binary market. */
export const NO_LABEL = "No";

/**
 * Map a Polymarket tag/category string onto the normalized {@link Category}
 * taxonomy. Unknown values fall back to `"other"` (design "Model
 * Definitions").
 */
export function mapCategory(raw: unknown): Category {
  const value = asStringOrNull(raw);
  if (value === null) return "other";
  const lower = value.toLowerCase();
  if (isCategory(lower)) return lower;
  // Common Polymarket label aliases → normalized taxonomy. Matching is
  // word-boundary aware so short tokens (eth, btc, ai) do not false-match
  // substrings of unrelated words (e.g. "som-eth-ing").
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
 * it (so "politic" matches "politics" but the short token "ai" never matches
 * inside "aid"/"air"). This avoids substring false-positives where a short
 * keyword would otherwise match inside an unrelated word (e.g. "eth" in
 * "something").
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
 * Derive a normalized {@link MarketStatus} from a Gamma market object.
 *
 * Gamma encodes lifecycle via boolean flags (`active`, `closed`, `archived`)
 * and sometimes an explicit string. Precedence: resolved → closed → open.
 */
export function mapMarketStatus(raw: unknown): MarketStatus {
  const explicit = asStringOrNull(getField(raw, "status"));
  if (explicit !== null && isMarketStatus(explicit.toLowerCase())) {
    return explicit.toLowerCase() as MarketStatus;
  }

  const closed = asBoolean(getField(raw, "closed"));
  const archived = asBoolean(getField(raw, "archived"));
  const resolved =
    getField(raw, "umaResolutionStatus") !== undefined
      ? asStringOrNull(getField(raw, "umaResolutionStatus"))?.toLowerCase() === "resolved"
      : asBoolean(getFirstField(raw, ["resolved", "isResolved"]));

  if (resolved) return "resolved";
  if (closed || archived) return "closed";
  return "open";
}

/**
 * Build a {@link ResolutionCriteria} from a Gamma market, ALWAYS preserving the
 * raw criteria for auditability even when structured fields are absent
 * (Requirement 10.3). Structured fields are best-effort.
 */
export function mapResolutionCriteria(rawMarket: unknown): ResolutionCriteria {
  const description = asStringOrNull(getFirstField(rawMarket, ["resolutionSource", "description"]));
  const cutoff = toIsoTimestampOrNull(
    getFirstField(rawMarket, ["endDate", "endDateIso", "closedTime"]),
  );

  // Preserve a focused, auditable subset of the raw criteria. Unknown shape →
  // still preserved as a record so matching Layer 4 can inspect it later.
  const raw: Record<string, unknown> = {};
  for (const key of [
    "resolutionSource",
    "description",
    "umaResolutionStatus",
    "endDate",
    "endDateIso",
  ]) {
    const value = getField(rawMarket, key);
    if (value !== undefined) raw[key] = value;
  }

  return normalizeResolutionCriteria({
    dataSource: description,
    cutoffTime: cutoff,
    rounding: null,
    raw,
  });
}

/**
 * Map a binary Yes/No Gamma market to two normalized outcomes.
 *
 * The **Yes-token price is the implied probability**. Gamma provides parallel
 * arrays `outcomes` (labels), `outcomePrices` (prices), and `clobTokenIds`
 * (Polygon token ids), each frequently JSON-stringified. When a usable price
 * pair is present the two probabilities are reconciled to sum to ≈ 1 via the
 * core helper (Requirement 1.3); otherwise each is normalized independently and
 * missing values stay `null` (Requirement 1.5).
 */
export function mapOutcomes(rawMarket: unknown): NormalizedOutcome[] {
  const labels = parseStringifiedArray(getField(rawMarket, "outcomes"));
  const prices = parseStringifiedArray(getField(rawMarket, "outcomePrices"));
  const tokenIds = parseStringifiedArray(getField(rawMarket, "clobTokenIds"));

  // Determine the outcome count from whichever array is populated; default to a
  // binary Yes/No pair when nothing is present.
  const count = Math.max(labels.length, prices.length, tokenIds.length);
  if (count === 0) {
    return [
      makeOutcome(YES_LABEL, tokenAt(tokenIds, 0), null),
      makeOutcome(NO_LABEL, tokenAt(tokenIds, 1), null),
    ];
  }

  const rawProbs = Array.from({ length: count }, (_, i) => asFiniteNumberOrNull(prices[i]));

  // For a clean binary pair with both prices present, reconcile to sum ≈ 1.
  let probs: Array<number | null> = rawProbs;
  const yes = rawProbs[0];
  const no = rawProbs[1];
  if (count === 2 && yes !== null && yes !== undefined && no !== null && no !== undefined) {
    const { normalized } = normalizeBinaryProbabilities([yes, no]);
    probs = normalized;
  } else {
    probs = rawProbs.map((p) => normalizeProbability(p));
  }

  return Array.from({ length: count }, (_, i) => {
    const label = asStringOrNull(labels[i]) ?? defaultLabel(i);
    const prob = probs[i] ?? null;
    return makeOutcome(label, tokenAt(tokenIds, i), prob);
  });
}

/** A single outcome with `impliedProb === lastPrice` (Yes-token convention). */
function makeOutcome(
  label: string,
  tokenId: string | null,
  prob: number | null,
): NormalizedOutcome {
  const normalized = normalizeProbability(prob);
  return {
    label,
    tokenId,
    impliedProb: normalized,
    // For a binary market the last price of the token equals its probability.
    lastPrice: normalized,
  };
}

/** Default outcome label by index (binary convention first). */
function defaultLabel(index: number): string {
  if (index === 0) return YES_LABEL;
  if (index === 1) return NO_LABEL;
  return `Outcome ${index + 1}`;
}

/** Read the token id at an index as a string, or `null`. */
function tokenAt(tokenIds: unknown[], index: number): string | null {
  return asStringOrNull(tokenIds[index]);
}

/**
 * Map a single raw Gamma market object into a {@link NormalizedMarket}.
 *
 * `externalId` is the platform-native market id. The owning event id is
 * captured when Gamma nests/embeds it. Numeric metadata is normalized; missing
 * values stay explicitly `null` (Requirement 1.5).
 */
export function mapMarket(rawMarket: unknown): NormalizedMarket | null {
  const externalId = asStringOrNull(getFirstField(rawMarket, ["id", "conditionId", "questionID"]));
  // Without a stable native id there is no idempotency key — skip it.
  if (externalId === null) return null;

  const question = asStringOrNull(getFirstField(rawMarket, ["question", "title"])) ?? "";

  return {
    externalId,
    eventExternalId: extractEventExternalId(rawMarket),
    question,
    status: mapMarketStatus(rawMarket),
    // Category hint for the denormalized column: prefer an explicit category
    // tag/label when present, else infer from the question text.
    category: inferCategory(`${polymarketCategoryHint(rawMarket)} ${question}`),
    volume24h: asFiniteNumberOrNull(
      getFirstField(rawMarket, ["volume24hr", "volume24Hr", "volume_24hr"]),
    ),
    liquidity: asFiniteNumberOrNull(getFirstField(rawMarket, ["liquidity", "liquidityNum"])),
    spread: normalizeSpread(asFiniteNumberOrNull(getField(rawMarket, "spread"))),
    outcomes: mapOutcomes(rawMarket),
    resolutionCriteria: mapResolutionCriteria(rawMarket),
  };
}

/**
 * Best category hint string from a Gamma market: any explicit `category` field
 * plus the labels of any embedded event tags. Joined into a single string that
 * {@link inferCategory} keyword-matches (alongside the question).
 */
function polymarketCategoryHint(rawMarket: unknown): string {
  const parts: string[] = [];
  const direct = asStringOrNull(getField(rawMarket, "category"));
  if (direct !== null) parts.push(direct);
  // Tags may live on the market or on its embedded events.
  for (const tag of asArray(getField(rawMarket, "tags"))) {
    const label = asStringOrNull(getFirstField(tag, ["label", "slug", "name"]));
    if (label !== null) parts.push(label);
  }
  const events = asArray(getField(rawMarket, "events"));
  if (events.length > 0) {
    for (const tag of asArray(getField(events[0], "tags"))) {
      const label = asStringOrNull(getFirstField(tag, ["label", "slug", "name"]));
      if (label !== null) parts.push(label);
    }
  }
  return parts.join(" ");
}

/** Extract the owning event's native id from a Gamma market, or `null`. */
function extractEventExternalId(rawMarket: unknown): string | null {
  const direct = asStringOrNull(getFirstField(rawMarket, ["eventId", "event_id"]));
  if (direct !== null) return direct;
  // Gamma may embed an `events` array on the market.
  const events = asArray(getField(rawMarket, "events"));
  if (events.length > 0) {
    return asStringOrNull(getField(events[0], "id"));
  }
  const event = getField(rawMarket, "event");
  if (isRecord(event)) return asStringOrNull(getField(event, "id"));
  return null;
}

/**
 * Map a single raw Gamma event object into a {@link NormalizedEvent}. The event
 * category is derived from its first tag/category label. `endDate` is parsed to
 * ISO when present, else `null` (Requirement 1.5).
 */
export function mapEvent(rawEvent: unknown): NormalizedEvent | null {
  const externalId = asStringOrNull(getField(rawEvent, "id"));
  if (externalId === null) return null;

  const title = asStringOrNull(getFirstField(rawEvent, ["title", "name"])) ?? "";
  const endDate = toIsoTimestampOrNull(
    getFirstField(rawEvent, ["endDate", "endDateIso", "end_date"]),
  );

  return {
    externalId,
    title,
    category: mapEventCategory(rawEvent),
    endDate,
    rawResolution: buildEventRawResolution(rawEvent),
  };
}

/** Derive an event category from its `category` field or first tag label. */
function mapEventCategory(rawEvent: unknown): Category {
  const direct = getField(rawEvent, "category");
  if (direct !== undefined) return mapCategory(direct);

  const tags = asArray(getField(rawEvent, "tags"));
  if (tags.length > 0) {
    const first = tags[0];
    const label = getFirstField(first, ["label", "slug", "name"]);
    return mapCategory(label ?? first);
  }
  return "other";
}

/** Preserve an event's raw resolution-relevant fields for auditability. */
function buildEventRawResolution(rawEvent: unknown): Record<string, unknown> | undefined {
  const raw: Record<string, unknown> = {};
  for (const key of ["description", "resolutionSource", "endDate"]) {
    const value = getField(rawEvent, key);
    if (value !== undefined) raw[key] = value;
  }
  return Object.keys(raw).length > 0 ? raw : undefined;
}

/**
 * Map a CLOB price-snapshot reading into a {@link NormalizedPriceSnapshot}.
 *
 * The CLOB `/price` endpoint returns the price of a single token (the Yes
 * token for the Yes-probability). `marketExternalId` and `outcomeLabel` are
 * resolved by the caller (which knows the token→market mapping). Returns `null`
 * when the price cannot be parsed (Requirement 1.5).
 */
export function mapPriceSnapshot(input: {
  marketExternalId: string;
  outcomeLabel: string;
  rawPrice: unknown;
  volume?: unknown;
  ts: string;
}): NormalizedPriceSnapshot | null {
  const price = normalizeProbability(asFiniteNumberOrNull(input.rawPrice));
  if (price === null) return null;
  return {
    marketExternalId: input.marketExternalId,
    outcomeLabel: input.outcomeLabel,
    price,
    volume: asFiniteNumberOrNull(input.volume),
    ts: input.ts,
  };
}

/**
 * Map a CLOB `/prices-history` payload into normalized price points.
 *
 * The endpoint returns `{ history: [{ t: <epoch seconds>, p: <price> }, ...] }`.
 * Each point's price is the Yes-token price (the implied probability). Points
 * with unparseable price/time are skipped rather than throwing.
 */
export function mapPriceHistory(input: {
  marketExternalId: string;
  outcomeLabel: string;
  rawHistory: unknown;
}): NormalizedPriceSnapshot[] {
  const container = getFirstField(input.rawHistory, ["history", "data"]);
  const points = asArray(container ?? input.rawHistory);
  const result: NormalizedPriceSnapshot[] = [];
  for (const point of points) {
    const ts = toIsoTimestampOrNull(getFirstField(point, ["t", "timestamp", "time"]));
    const price = normalizeProbability(
      asFiniteNumberOrNull(getFirstField(point, ["p", "price", "value"])),
    );
    if (ts === null || price === null) continue;
    result.push({
      marketExternalId: input.marketExternalId,
      outcomeLabel: input.outcomeLabel,
      price,
      volume: asFiniteNumberOrNull(getField(point, "volume")),
      ts,
    });
  }
  return result;
}

/** A single side of an order book (price/size ladder). */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Normalized order-book depth for a token (Requirement 4.3). */
export interface NormalizedDepth {
  /** Token id the book belongs to. */
  tokenId: string | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/**
 * Map a CLOB `/book` payload into normalized depth. The endpoint returns
 * `{ asset_id, bids: [{price,size}], asks: [{price,size}] }` with stringified
 * numbers. Malformed levels are dropped (never throws).
 */
export function mapOrderBookDepth(rawBook: unknown): NormalizedDepth {
  return {
    tokenId: asStringOrNull(getFirstField(rawBook, ["asset_id", "assetId", "token_id", "tokenId"])),
    bids: mapBookLevels(getField(rawBook, "bids")),
    asks: mapBookLevels(getField(rawBook, "asks")),
  };
}

/** Map and filter an order-book ladder, dropping unparseable levels. */
function mapBookLevels(raw: unknown): OrderBookLevel[] {
  const levels: OrderBookLevel[] = [];
  for (const level of asArray(raw)) {
    const price = asFiniteNumberOrNull(getField(level, "price"));
    const size = asFiniteNumberOrNull(getFirstField(level, ["size", "amount"]));
    if (price === null || size === null) continue;
    levels.push({ price, size });
  }
  return levels;
}
