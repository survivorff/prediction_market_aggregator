import type { ResolutionCriteria } from "./resolution-criteria.js";

/** Lifecycle status of a market. */
export type MarketStatus = "open" | "closed" | "resolved";

/** All valid {@link MarketStatus} values. */
export const MARKET_STATUSES: readonly MarketStatus[] = ["open", "closed", "resolved"] as const;

/** Type guard: returns true when `value` is a valid {@link MarketStatus}. */
export function isMarketStatus(value: unknown): value is MarketStatus {
  return typeof value === "string" && (MARKET_STATUSES as readonly string[]).includes(value);
}

/**
 * The smallest unit of aggregation — a single question (on Polymarket, a
 * binary Yes/No question backed by two outcome tokens).
 *
 * Identified cross-system by `(sourceId, externalId)` (the idempotency key).
 * `spread` is best-ask minus best-bid on the Yes outcome and must be `>= 0`.
 * Numeric metadata fields are nullable to represent missing upstream data
 * explicitly (Requirement 1.5). See design.md "Model Definitions".
 */
export interface Market {
  /** Internal UUID. */
  id: string;
  sourceId: string;
  /** Owning platform-native event; null when ungrouped. */
  eventId: string | null;
  /** Set once linked cross-platform; null otherwise. */
  canonicalEventId: string | null;
  /** Platform-native market id (idempotency: source + external). */
  externalId: string;
  question: string;
  status: MarketStatus;
  /** 24h volume. Null when unavailable. */
  volume24h: number | null;
  /** Liquidity. Null when unavailable. */
  liquidity: number | null;
  /** Best-ask minus best-bid on the Yes outcome; `>= 0`. Null when unavailable. */
  spread: number | null;
  resolutionCriteria: ResolutionCriteria;
}
