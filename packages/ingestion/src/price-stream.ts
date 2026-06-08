/**
 * Price tiering + stream management — the fuller stream pipeline the design's
 * "Price tiering + WebSocket reconnect with backfill" section describes (task
 * 5.3). It builds on the minimal WebSocket-vs-polling decision seam from
 * `capability-gating.ts` (task 4.5), reusing {@link canStreamPrices} unchanged.
 *
 * Three responsibilities, mirroring the design pseudocode:
 *
 * 1. {@link classifyTier} — pure tiering policy: is a market `active` (stream it
 *    over WebSocket where capable) or `longTail` (poll on a slower cadence)?
 * 2. {@link onTick} — the per-tick side-effect pipeline: hot-cache write
 *    (Req 10.4), idempotent `PricePoint` append (Req 7.2 / 10.2), and fan-out
 *    publish (Req 9.2), while tracking `lastSeenTs`.
 * 3. {@link startPriceStream} — ties it together: routes a source to WebSocket
 *    (`subscribePrices`) or polling (`fetchPriceSnapshot`) via the capability
 *    gate, running every tick/snapshot through {@link onTick}.
 *
 * Reconnect-with-backfill is intentionally NOT implemented here — that is task
 * 5.4. The seam where it plugs in is the {@link PriceStreamHandle} returned by
 * {@link startPriceStream} (its open `subscription` + `lastSeenTs()`), called
 * out inline below.
 *
 * Requirements:
 * - 7.4: WebSocket for capable sources, tiered polling otherwise (via the
 *   reused capability gate); polling fallback keeps price history gap-free.
 * - 10.4: latest prices written to the Redis hot cache on every tick.
 * - 9.2: live price updates published to the WebSocket fan-out (Redis pub/sub).
 */

import type {
  Market,
  MarketSource,
  NormalizedPriceSnapshot,
  PricePoint,
  PriceTickHandler,
  Subscription,
} from "@pma/core";
import type { PricePayload } from "@pma/storage";
import { canStreamPrices } from "./capability-gating.js";

// ---------------------------------------------------------------------------
// 1. Tiering policy — classifyTier
// ---------------------------------------------------------------------------

/** A market's streaming tier. */
export type MarketTier = "active" | "longTail";

/**
 * Default "ends soon" window: an open market whose resolution cutoff is within
 * 24h of `now` is treated as active. 24h keeps soon-to-resolve markets (where
 * price moves fastest) on the live stream.
 */
export const DEFAULT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Default 24h-volume threshold at/above which an open market is active. A
 * busy market warrants live streaming even when its resolution is far off.
 */
export const DEFAULT_VOLUME_THRESHOLD = 10_000;

/** Tunable thresholds for {@link classifyTier}; each falls back to a default. */
export interface TierOptions {
  /**
   * Window (ms) before the resolution cutoff within which an open market counts
   * as active ("ends soon"). Defaults to {@link DEFAULT_ACTIVE_WINDOW_MS}.
   */
  activeWindowMs?: number;
  /**
   * 24h volume at or above which an open market counts as active. Defaults to
   * {@link DEFAULT_VOLUME_THRESHOLD}.
   */
  volumeThreshold?: number;
}

/**
 * Classify a market into a streaming tier (design "Price tiering"):
 *
 * > A market is **active** if its event ends soon, or recent volume/trade
 * > frequency is above a tier threshold; otherwise **longTail**.
 *
 * Concretely, a market is `active` iff it is **open** AND either:
 *
 * - **ends soon** — its `resolutionCriteria.cutoffTime` parses to an instant in
 *   the window `[now, now + activeWindowMs]` (in the future and imminent); or
 * - **busy** — its `volume24h` is at or above `volumeThreshold`.
 *
 * Otherwise it is `longTail`. In particular:
 *
 * - `closed`/`resolved` markets are always `longTail` — they no longer move, so
 *   there is nothing to stream live.
 * - A missing/unparseable `cutoffTime` simply means "not imminent" (it cannot
 *   make a market active on its own); a `null` `volume24h` is "not busy".
 * - A cutoff already in the past is NOT imminent (the event has ended), so it
 *   does not by itself keep the market active.
 *
 * Pure and deterministic given `(market, now, options)` — no I/O — so the
 * policy is trivially unit-testable across the boundaries.
 *
 * `Market` carries no event end-date directly, so imminence is derived from
 * `resolutionCriteria.cutoffTime` (the settlement cutoff), which is the closest
 * available proxy for "the event ends soon".
 */
export function classifyTier(market: Market, now: Date, options: TierOptions = {}): MarketTier {
  // Only open markets can be active; closed/resolved never stream.
  if (market.status !== "open") return "longTail";

  const activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  const volumeThreshold = options.volumeThreshold ?? DEFAULT_VOLUME_THRESHOLD;

  if (isBusy(market, volumeThreshold)) return "active";
  if (endsSoon(market, now, activeWindowMs)) return "active";
  return "longTail";
}

/** True when the market's 24h volume meets/exceeds the tier threshold. */
function isBusy(market: Market, volumeThreshold: number): boolean {
  return typeof market.volume24h === "number" && market.volume24h >= volumeThreshold;
}

/**
 * True when the market's resolution cutoff is a valid instant within
 * `[now, now + activeWindowMs]`. A missing/unparseable cutoff or one outside
 * the window returns false.
 */
function endsSoon(market: Market, now: Date, activeWindowMs: number): boolean {
  const cutoff = market.resolutionCriteria.cutoffTime;
  if (cutoff === null) return false;

  const cutoffMs = Date.parse(cutoff);
  if (Number.isNaN(cutoffMs)) return false;

  const nowMs = now.getTime();
  const delta = cutoffMs - nowMs;
  // In the future (or exactly now) AND no further out than the active window.
  return delta >= 0 && delta <= activeWindowMs;
}

// ---------------------------------------------------------------------------
// 2. Per-tick pipeline — onTick
// ---------------------------------------------------------------------------

/**
 * Internal ids a price tick maps to, resolved from its
 * `(marketExternalId, outcomeLabel)`. Needed to write the `PricePoint` row,
 * which is keyed on internal `(marketId, outcomeId, ts)` (Req 10.2).
 */
export interface ResolvedIds {
  marketId: string;
  outcomeId: string;
}

/**
 * Maps a tick's upstream `(marketExternalId, outcomeLabel)` to internal
 * `(marketId, outcomeId)`, or `null` when the market/outcome is unknown to the
 * system. May be synchronous or async.
 *
 * Resolution is expected to be **cached/precomputed by the orchestrator** (the
 * active-market set is already known when a stream is started), so this stays
 * off the hot path; the contract here only requires a lookup, not a DB round
 * trip per tick.
 */
export type IdResolver = (
  marketExternalId: string,
  outcomeLabel: string,
) => ResolvedIds | null | Promise<ResolvedIds | null>;

/**
 * Minimal hot-cache writer dependency (Req 10.4). Structurally satisfied by
 * `@pma/storage`'s `HotPriceCache`.
 */
export interface HotPriceWriter {
  setHotPrice(
    marketId: string,
    outcomeLabel: string,
    price: number,
    options?: { volume?: number | null; ts?: string; ttlMs?: number },
  ): Promise<void>;
}

/**
 * Minimal idempotent price-point writer dependency (Req 7.2 / 10.2).
 * Structurally satisfied by `@pma/storage`'s `PricePointRepository`.
 */
export interface PricePointWriter {
  writePricePoint(point: PricePoint): Promise<void>;
}

/**
 * Minimal fan-out publisher dependency (Req 9.2). Structurally satisfied by
 * `@pma/storage`'s `FanoutPublisher`.
 */
export interface PricePublisher {
  publishPrice(marketId: string, payload: PricePayload): Promise<number>;
}

/** Injected dependencies for {@link onTick} — all fakeable for tests. */
export interface OnTickDeps {
  /** Redis hot latest-price cache (Req 10.4). */
  hotPriceCache: HotPriceWriter;
  /** Idempotent TimescaleDB price-point append (Req 7.2 / 10.2). */
  pricePointRepo: PricePointWriter;
  /** WebSocket fan-out publisher (Req 9.2). */
  fanoutPublisher: PricePublisher;
  /** Maps the tick's external ids to internal ids for the price-point write. */
  resolveIds: IdResolver;
}

/** Outcome of processing a single tick through {@link onTick}. */
export interface OnTickResult {
  /** The tick's timestamp — the new `lastSeenTs` (drives 5.4 backfill). */
  lastSeenTs: string;
  /** True when a `PricePoint` row was written (i.e. `resolveIds` succeeded). */
  persisted: boolean;
}

/**
 * Run one price tick through the side-effect pipeline (design `onTick`):
 *
 * 1. **Hot cache** — `hotPriceCache.setHotPrice(...)` records the latest price
 *    so the API serves hot-path reads from Redis (Req 10.4).
 * 2. **Idempotent price write** — `pricePointRepo.writePricePoint(...)` appends
 *    the point, upserting on `(marketId, outcomeId, ts)` so reconnect backfill
 *    never duplicates (Req 7.2 / 10.2). This is the only step that needs
 *    internal ids, so it is gated on {@link IdResolver}.
 * 3. **Fan-out** — `fanoutPublisher.publishPrice(...)` pushes the update to
 *    subscribed WebSocket clients via Redis pub/sub (Req 9.2).
 *
 * Finally it reports `lastSeenTs = tick.ts`.
 *
 * **Keying decision (hot cache + fan-out by external id).** The hot cache and
 * fan-out are keyed by the tick's `marketExternalId` exactly as the design's
 * `onTick` specifies (`setHotPrice(tick.marketExternalId, …)`,
 * `fanout.publish(channelFor(tick.marketExternalId), …)`). Only the durable
 * `PricePoint` write requires internal `(marketId, outcomeId)`. This is what
 * lets the documented null-resolution behavior work:
 *
 * **Unknown market/outcome (`resolveIds` → null).** The durable price-point
 * write is **skipped** (we have no `(marketId, outcomeId)` to key it on and must
 * not fabricate one), but the hot-cache write and fan-out publish **still run**
 * — they only need the external id, which the tick always carries. A live price
 * is therefore never dropped from the cache/stream just because internal-id
 * resolution lags behind ingestion; only the time-series persistence waits.
 * `result.persisted` reflects whether the row was written.
 */
export async function onTick(
  tick: NormalizedPriceSnapshot,
  deps: OnTickDeps,
): Promise<OnTickResult> {
  // (a) Hot cache — keyed by external id; always runs (Req 10.4).
  await deps.hotPriceCache.setHotPrice(tick.marketExternalId, tick.outcomeLabel, tick.price, {
    volume: tick.volume,
    ts: tick.ts,
  });

  // (b) Idempotent price write — needs internal ids (Req 7.2 / 10.2).
  const ids = await deps.resolveIds(tick.marketExternalId, tick.outcomeLabel);
  let persisted = false;
  if (ids !== null) {
    await deps.pricePointRepo.writePricePoint({
      marketId: ids.marketId,
      outcomeId: ids.outcomeId,
      ts: tick.ts,
      price: tick.price,
      volume: tick.volume,
    });
    persisted = true;
  }

  // (c) Fan-out publish — keyed by external id; always runs (Req 9.2).
  const payload: PricePayload = {
    marketId: tick.marketExternalId,
    outcomeLabel: tick.outcomeLabel,
    price: tick.price,
    volume: tick.volume,
    ts: tick.ts,
  };
  await deps.fanoutPublisher.publishPrice(tick.marketExternalId, payload);

  // lastSeenTs ← tick.ts (consumed by the 5.4 reconnect-backfill seam).
  return { lastSeenTs: tick.ts, persisted };
}

// ---------------------------------------------------------------------------
// 3. Stream manager — startPriceStream
// ---------------------------------------------------------------------------

/** Stops an active poll loop. */
export type StopPolling = () => void;

/**
 * Schedules a poll loop. Given a `poll` action (one fetch-snapshot-and-process
 * pass), it is responsible for invoking `poll` on a cadence and returns a stop
 * handle. Injected so the cadence/timer policy stays out of the stream manager
 * and tests can drive `poll` deterministically without real timers.
 */
export type SchedulePolling = (poll: () => Promise<void>) => StopPolling;

/** Injected dependencies for {@link startPriceStream}. */
export interface StartPriceStreamDeps extends OnTickDeps {
  /** Poll scheduler used on the non-WebSocket (fallback) path (Req 7.4). */
  schedulePolling: SchedulePolling;
  /**
   * Optional sink for errors thrown while processing a tick/snapshot. The
   * WebSocket {@link PriceTickHandler} is synchronous (`=> void`), so async
   * tick failures are surfaced here rather than thrown into the adapter.
   */
  onError?: (error: unknown) => void;
}

/** Handle to a running price stream. */
export interface PriceStreamHandle {
  /** Which transport was chosen by the capability gate. */
  mode: "websocket" | "polling";
  /** The open subscription on the WebSocket path; `undefined` when polling. */
  subscription?: Subscription;
  /**
   * The most recent tick timestamp processed (ISO 8601), or `null` before any
   * tick. This is the 5.4 reconnect-backfill anchor: on a WebSocket drop, 5.4
   * re-subscribes and backfills `fetchPriceHistory({ from: lastSeenTs(), to:
   * now })` so the curve has no holes (Req 7.6 / 4.4).
   */
  lastSeenTs(): string | null;
  /** Tear down the stream: close the subscription or stop the poll loop. */
  stop(): void;
}

/**
 * Start managing a source's price stream for its `activeIds`, routing transport
 * via the reused capability gate (design `managePriceStream`):
 *
 * - {@link canStreamPrices}`(source) === true` → WebSocket path:
 *   `source.subscribePrices(activeIds, handler)`, where `handler` runs each live
 *   tick through {@link onTick} (Req 7.4, 10.4, 9.2).
 * - otherwise → polling fallback: `deps.schedulePolling(poll)` drives a loop
 *   that calls `source.fetchPriceSnapshot(activeIds)` and runs each snapshot
 *   through {@link onTick}. `subscribePrices` is never invoked, ensuring history
 *   stays gap-free via polling (Req 7.4).
 *
 * **Task 5.4 seam.** Reconnect-with-backoff and gap backfill are out of scope
 * here. They attach to the returned {@link PriceStreamHandle}: on a disconnect
 * (observed via `subscription.isOpen`), 5.4 reconnects with backoff, re-calls
 * `subscribePrices`, and backfills `fetchPriceHistory` from `lastSeenTs()` to
 * `now` — exactly the design's `ON disconnect` block. Keeping `lastSeenTs` and
 * the live `subscription` on the handle is what makes that a localized 5.4 add.
 */
export function startPriceStream(
  source: MarketSource,
  activeIds: string[],
  deps: StartPriceStreamDeps,
): PriceStreamHandle {
  let lastSeen: string | null = null;

  // Shared tick path for both transports: process, then advance lastSeenTs.
  const runTick = async (tick: NormalizedPriceSnapshot): Promise<void> => {
    const result = await onTick(tick, deps);
    lastSeen = result.lastSeenTs;
  };

  if (canStreamPrices(source)) {
    // WebSocket path. The handler is synchronous per `PriceTickHandler`; the
    // async tick work runs detached, with failures routed to `onError`.
    const handler: PriceTickHandler = (tick) => {
      void runTick(tick).catch((error) => deps.onError?.(error));
    };
    // Safe: `canStreamPrices` guarantees `subscribePrices` is present.
    const subscription = source.subscribePrices!(activeIds, handler);
    return {
      mode: "websocket",
      subscription,
      lastSeenTs: () => lastSeen,
      stop: () => subscription.close(),
    };
  }

  // Polling fallback (e.g. Manifold): one pass = fetch snapshots + process each.
  const poll = async (): Promise<void> => {
    const snapshots = await source.fetchPriceSnapshot(activeIds);
    for (const snapshot of snapshots) {
      await runTick(snapshot);
    }
  };
  const stopPolling = deps.schedulePolling(poll);
  return {
    mode: "polling",
    lastSeenTs: () => lastSeen,
    stop: stopPolling,
  };
}
