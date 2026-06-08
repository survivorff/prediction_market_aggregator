/**
 * Centralized Predict.fun → normalized-domain mapping.
 *
 * ALL platform-specific field knowledge lives here so the exact REST field
 * mapping is easy to adjust as the upstream API evolves; the adapter
 * (index.ts) only does I/O and delegates shaping to these pure functions.
 *
 * Predict.fun model (https://dev.predict.fun, https://api.predict.fun/docs):
 * - Onchain prediction market on BNB Chain. Binary Yes/No markets; share prices
 *   trade between 0 and 1, so a **share price reads directly as an implied
 *   probability** (like Polymarket).
 * - An off-chain CLOB matches trades; the REST `GET /v1/markets/{id}/orderbook`
 *   exposes `asks`/`bids` ladders of `[price, size]` tuples. The **mid of the
 *   best bid/ask is the Yes implied probability**.
 * - A market lists its `outcomes` (`{ indexSet, name, onChainId }`); the
 *   `onChainId` is the ERC-1155 position token id (carried as `tokenId`).
 * - The markets list does NOT embed a current price — price comes from the
 *   orderbook — so metadata outcomes carry an explicit `null` probability until
 *   a price snapshot fills it (Requirement 1.5).
 *
 * Mapping rules honored here:
 * - Probabilities are kept within [0, 1] via the core normalization helpers
 *   (Requirement 1.3).
 * - `resolutionCriteria.raw` is ALWAYS preserved, even when structured fields
 *   cannot be parsed (Requirement 10.3).
 * - Missing/optional upstream fields become explicit `null` — never throw
 *   (Requirement 1.5).
 * - `externalId` is the platform-native market id (idempotency key component).
 *
 * These functions are PURE and have no I/O dependency.
 */

import type {
  NormalizedMarket,
  NormalizedOutcome,
  NormalizedPriceSnapshot,
  ResolutionCriteria,
} from "@pma/core";
import {
  normalizeProbability,
  normalizeSpread,
  normalizeResolutionCriteria,
  type MarketStatus,
} from "@pma/core";
import {
  asArray,
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
 * Derive a normalized {@link MarketStatus} from a Predict.fun market.
 *
 * Predict.fun encodes lifecycle in `tradingStatus` (e.g. `OPEN`, `PAUSED`,
 * `CLOSED`, `RESOLVED`/`SETTLED`). Precedence: resolved → closed → open. An
 * unknown/absent status defaults to `open` (the common case for a listed
 * market).
 */
export function mapTradingStatus(raw: unknown): MarketStatus {
  const status = asStringOrNull(getFirstField(raw, ["tradingStatus", "status"]))?.toUpperCase();
  if (status === null || status === undefined) return "open";
  if (status === "RESOLVED" || status === "SETTLED" || status === "FINALIZED") return "resolved";
  if (status === "CLOSED" || status === "PAUSED" || status === "SUSPENDED" || status === "HALTED") {
    return "closed";
  }
  return "open";
}

/**
 * Build a {@link ResolutionCriteria} from a Predict.fun market, ALWAYS
 * preserving the raw criteria for auditability even when structured fields are
 * absent (Requirement 10.3). The on-chain `conditionId`, `resolverAddress`, and
 * `categorySlug` are retained so matching Layer 4 can detect resolution
 * mismatches (e.g. a market that mirrors a Kalshi ticker vs. a native one).
 */
export function mapResolutionCriteria(rawMarket: unknown): ResolutionCriteria {
  const description = asStringOrNull(
    getFirstField(rawMarket, ["description", "resolverAddress", "resolutionSource"]),
  );
  const cutoff = toIsoTimestampOrNull(
    getFirstField(rawMarket, ["endDate", "closeTime", "resolutionTime", "targetDate"]),
  );

  const raw: Record<string, unknown> = {};
  for (const key of [
    "conditionId",
    "resolverAddress",
    "categorySlug",
    "kalshiMarketTicker",
    "description",
    "feeRateBps",
    "isNegRisk",
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
 * Map a binary Predict.fun market's `outcomes` array to normalized outcomes.
 *
 * Each upstream outcome is `{ indexSet, name, onChainId, status }`. The
 * `onChainId` (ERC-1155 position token id) is carried as `tokenId`. The markets
 * list carries no price, so `impliedProb`/`lastPrice` are explicitly `null`
 * here (Requirement 1.5) — the price-snapshot path fills them from the
 * orderbook mid. When no outcomes are present, default to a binary Yes/No pair.
 */
export function mapOutcomes(rawMarket: unknown): NormalizedOutcome[] {
  const rawOutcomes = asArray(getField(rawMarket, "outcomes"));
  if (rawOutcomes.length === 0) {
    return [makeOutcome(YES_LABEL, null), makeOutcome(NO_LABEL, null)];
  }
  return rawOutcomes.map((o, i) => {
    const label = asStringOrNull(getFirstField(o, ["name", "label", "title"])) ?? defaultLabel(i);
    const tokenId = asStringOrNull(getFirstField(o, ["onChainId", "tokenId", "token_id"]));
    return makeOutcome(label, tokenId);
  });
}

/** A single outcome with an explicit null probability (filled from orderbook). */
function makeOutcome(label: string, tokenId: string | null): NormalizedOutcome {
  return { label, tokenId, impliedProb: null, lastPrice: null };
}

/** Default outcome label by index (binary convention first). */
function defaultLabel(index: number): string {
  if (index === 0) return YES_LABEL;
  if (index === 1) return NO_LABEL;
  return `Outcome ${index + 1}`;
}

/**
 * Map a single raw Predict.fun market object into a {@link NormalizedMarket}.
 *
 * `externalId` is the platform-native market id (`id`, an integer, stringified).
 * The owning "event" is Predict.fun's `categorySlug` (a real-world event group);
 * we carry it as `eventExternalId` so same-event markets cluster. Numeric
 * metadata is normalized; missing values stay explicitly `null` (Requirement
 * 1.5).
 */
export function mapMarket(rawMarket: unknown): NormalizedMarket | null {
  const externalId = asStringOrNull(getFirstField(rawMarket, ["id", "marketId", "conditionId"]));
  // Without a stable native id there is no idempotency key — skip it.
  if (externalId === null) return null;

  const question = asStringOrNull(getFirstField(rawMarket, ["question", "title"])) ?? "";

  return {
    externalId,
    eventExternalId: asStringOrNull(
      getFirstField(rawMarket, ["categorySlug", "eventId", "event_id"]),
    ),
    question,
    status: mapTradingStatus(rawMarket),
    volume24h: asFiniteNumberOrNull(
      getFirstField(rawMarket, ["volume24h", "volume24hr", "volume_24h"]),
    ),
    liquidity: asFiniteNumberOrNull(getFirstField(rawMarket, ["liquidity", "liquidityNum"])),
    spread: normalizeSpread(
      asFiniteNumberOrNull(getFirstField(rawMarket, ["spread", "spreadThreshold"])),
    ),
    outcomes: mapOutcomes(rawMarket),
    resolutionCriteria: mapResolutionCriteria(rawMarket),
  };
}

/** A single side of an order book (price/size ladder). */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Normalized order-book depth for a market (Requirement 4.3). */
export interface NormalizedDepth {
  /** Market id the book belongs to. */
  marketId: string | null;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/**
 * Map a Predict.fun `/v1/markets/{id}/orderbook` payload into normalized depth.
 * The endpoint returns `{ marketId, asks: [[price,size]], bids: [[price,size]] }`
 * where each level is a `[price, size]` tuple. Malformed levels are dropped
 * (never throws).
 */
export function mapOrderBookDepth(rawBook: unknown): NormalizedDepth {
  return {
    marketId: asStringOrNull(getFirstField(rawBook, ["marketId", "market_id", "id"])),
    bids: mapBookLevels(getField(rawBook, "bids")),
    asks: mapBookLevels(getField(rawBook, "asks")),
  };
}

/**
 * Map an order-book ladder, dropping unparseable levels. Accepts both the
 * tuple form `[price, size]` and an object form `{ price, size }` for
 * resilience to API shape changes.
 */
function mapBookLevels(raw: unknown): OrderBookLevel[] {
  const levels: OrderBookLevel[] = [];
  for (const level of asArray(raw)) {
    let price: number | null;
    let size: number | null;
    if (Array.isArray(level)) {
      price = asFiniteNumberOrNull(level[0]);
      size = asFiniteNumberOrNull(level[1]);
    } else {
      price = asFiniteNumberOrNull(getField(level, "price"));
      size = asFiniteNumberOrNull(getFirstField(level, ["size", "amount"]));
    }
    if (price === null || size === null) continue;
    levels.push({ price, size });
  }
  return levels;
}

/**
 * Derive the Yes implied probability from a normalized order book.
 *
 * Ladders are sorted best-first, so `asks[0]`/`bids[0]` are the best ask/bid.
 * When both sides exist the mid `(best_ask + best_bid) / 2` is the implied
 * probability; with only one side present that side's best price is used; an
 * empty book yields `null` (Requirement 1.5). The result is clamped to [0, 1].
 */
export function midImpliedProbability(depth: NormalizedDepth): number | null {
  const bestAsk = depth.asks.length > 0 ? depth.asks[0]!.price : null;
  const bestBid = depth.bids.length > 0 ? depth.bids[0]!.price : null;
  if (bestAsk !== null && bestBid !== null) {
    return normalizeProbability((bestAsk + bestBid) / 2);
  }
  if (bestAsk !== null) return normalizeProbability(bestAsk);
  if (bestBid !== null) return normalizeProbability(bestBid);
  return null;
}

/**
 * Map a Predict.fun price reading into a {@link NormalizedPriceSnapshot} for the
 * Yes outcome. Returns `null` when the price cannot be parsed (Requirement 1.5).
 */
export function mapPriceSnapshot(input: {
  marketExternalId: string;
  outcomeLabel: string;
  price: number | null;
  volume?: unknown;
  ts: string;
}): NormalizedPriceSnapshot | null {
  const price = normalizeProbability(input.price);
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
 * Map a Predict.fun `/v1/markets/{id}/timeseries` payload into normalized Yes
 * price points (Requirement 4.2). The endpoint returns `{ data: [points] }`;
 * each point carries a timestamp (`t`/`timestamp`) and a Yes share price
 * (`p`/`price`/`value`). Points with unparseable price/time are skipped.
 */
export function mapPriceHistory(input: {
  marketExternalId: string;
  outcomeLabel: string;
  rawHistory: unknown;
}): NormalizedPriceSnapshot[] {
  const container = getFirstField(input.rawHistory, ["data", "history", "timeseries", "points"]);
  const points = asArray(container ?? input.rawHistory);
  const result: NormalizedPriceSnapshot[] = [];
  for (const point of points) {
    const ts = toIsoTimestampOrNull(getFirstField(point, ["t", "timestamp", "time", "ts"]));
    const price = normalizeProbability(
      asFiniteNumberOrNull(getFirstField(point, ["p", "price", "value", "mid"])),
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
