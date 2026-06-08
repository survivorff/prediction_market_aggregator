/**
 * Channel naming scheme and the typed message envelope for the Redis pub/sub
 * that feeds the WebSocket fan-out (design.md "WebSocket fan-out" + "Storage
 * Schemas"; Requirement 9.2).
 *
 * The design's WS protocol lets clients subscribe to three kinds of channel and
 * receive a uniform message envelope:
 *
 * ```text
 * WS /ws
 *   → subscribe   { channel: "market", id }
 *   → subscribe   { channel: "canonical", id }
 *   → subscribe   { channel: "alerts" }
 *   ← message     { channel, type: "price"|"spread"|"alert", payload }
 * ```
 *
 * Redis carries the same updates on per-target channels named (per design):
 *   - `chan:market:{id}`     — live price ticks for a single market
 *   - `chan:canonical:{id}`  — live spread updates for a canonical grouping
 *   - `chan:alerts`          — user alert notifications
 *
 * The {@link FanoutMessage} envelope keeps the design's exact three-field shape
 * (`channel`, `type`, `payload`); `channel` is the full Redis channel name, so
 * the target kind/id is recoverable via {@link parseChannel}.
 */

/** The kinds of pub/sub channel a client can subscribe to. */
export type ChannelKind = "market" | "canonical" | "alerts";

/** The kind of update carried in a {@link FanoutMessage}. */
export type MessageType = "price" | "spread" | "alert";

/** Prefix applied to every Redis channel name (matches design `chan:*`). */
export const CHANNEL_PREFIX = "chan" as const;

/** Build the Redis channel name for a single market's live price ticks. */
export function marketChannel(marketId: string): string {
  return `${CHANNEL_PREFIX}:market:${marketId}`;
}

/** Build the Redis channel name for a canonical grouping's spread updates. */
export function canonicalChannel(canonicalEventId: string): string {
  return `${CHANNEL_PREFIX}:canonical:${canonicalEventId}`;
}

/** The single, shared Redis channel name for user alert notifications. */
export const ALERTS_CHANNEL = `${CHANNEL_PREFIX}:alerts` as const;

/** Build the Redis channel name for the alerts feed. */
export function alertsChannel(): string {
  return ALERTS_CHANNEL;
}

/** A decoded channel name: its {@link ChannelKind} plus the target id (null for alerts). */
export interface ParsedChannel {
  kind: ChannelKind;
  /** Target id for `market`/`canonical`; `null` for the global `alerts` channel. */
  id: string | null;
}

/**
 * Decode a Redis channel name produced by {@link marketChannel} /
 * {@link canonicalChannel} / {@link alertsChannel}. Returns `null` for any name
 * that does not match the scheme.
 */
export function parseChannel(channel: string): ParsedChannel | null {
  if (channel === ALERTS_CHANNEL) return { kind: "alerts", id: null };
  const marketPrefix = `${CHANNEL_PREFIX}:market:`;
  const canonicalPrefix = `${CHANNEL_PREFIX}:canonical:`;
  if (channel.startsWith(marketPrefix)) {
    const id = channel.slice(marketPrefix.length);
    return id.length > 0 ? { kind: "market", id } : null;
  }
  if (channel.startsWith(canonicalPrefix)) {
    const id = channel.slice(canonicalPrefix.length);
    return id.length > 0 ? { kind: "canonical", id } : null;
  }
  return null;
}

/**
 * Payload for a `price` message: the latest normalized price observation for a
 * market outcome (mirrors `NormalizedPriceSnapshot` from `@pma/core`, the shape
 * the ingestion `onTick` path publishes).
 */
export interface PricePayload {
  marketId: string;
  outcomeLabel: string;
  /** 0..1 for binary. */
  price: number;
  volume: number | null;
  /** ISO 8601 capture time. */
  ts: string;
}

/**
 * Payload for a `spread` message: a canonical event's latest cross-platform
 * implied-probability gap (display-only; mirrors the design's `SpreadSignal`).
 */
export interface SpreadPayload {
  canonicalEventId: string;
  /** Max cross-platform implied-probability gap (max - min). */
  gap: number;
  /** Per-platform implied probabilities that produced the gap. */
  probabilities: Array<{ source: string; impliedProb: number }>;
}

/**
 * The uniform fan-out envelope published to Redis and relayed to WS clients.
 * Keeps the design's three-field shape; `channel` is the full Redis channel
 * name (decode with {@link parseChannel}).
 */
export interface FanoutMessage<T = unknown> {
  /** Full Redis channel name this message was published to (e.g. `chan:market:{id}`). */
  channel: string;
  type: MessageType;
  payload: T;
}

/** A `price` fan-out message. */
export type PriceMessage = FanoutMessage<PricePayload> & { type: "price" };

/** A `spread` fan-out message. */
export type SpreadMessage = FanoutMessage<SpreadPayload> & { type: "spread" };
