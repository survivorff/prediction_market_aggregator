/**
 * WebSocket reconnect-with-backfill — the `ON disconnect` block of the design's
 * `managePriceStream` algorithm (task 5.4). It layers resilience on top of the
 * task-5.3 stream pipeline ({@link startPriceStream} / {@link onTick}) without
 * changing that pipeline's behavior.
 *
 * The design pseudocode this implements:
 *
 * ```pascal
 * sub ← source.subscribePrices(activeIds, onTick)
 * lastSeenTs ← now()
 *
 * ON disconnect:
 *   backoffReconnect()                        // exponential backoff
 *   sub ← source.subscribePrices(activeIds, onTick)
 *   // backfill the gap so the price curve has no holes
 *   FOR each id IN activeIds DO
 *     gap ← source.fetchPriceHistory(id, { from: lastSeenTs, to: now() })
 *     FOR each p IN gap DO writePricePoint(p) END FOR
 *   END FOR
 * ```
 *
 * Each numbered concern below maps to a task-5.4 requirement:
 *
 * 1. **Disconnect detection.** `MarketSource.subscribePrices` only hands back a
 *    {@link Subscription} whose `isOpen` flips to `false` on close/error. We
 *    therefore detect drops by observing that flag: an injected
 *    {@link ResilientStreamDeps.scheduleHealthCheck} drives a recurring check
 *    (production: a `setInterval`; tests: a captured callback) that fires the
 *    reconnect flow when the *current* subscription is no longer open. Injecting
 *    the scheduler keeps detection deterministic — no real timers or sockets.
 * 2. **Backoff reconnect.** On a drop we sleep `min(base · 2^i, max) + jitter`
 *    before each re-subscribe attempt (the same jittered-exponential shape as
 *    {@link withRetry}; `sleep`/`random`/`jitter` are injected for determinism),
 *    then call `subscribePrices(activeIds, handler)` again.
 * 3. **Gap backfill.** After re-subscribing, for each active id we call
 *    `fetchPriceHistory(id, { from: lastSeenTs, to: now() })` and run every
 *    returned point through {@link onTick} (reusing the idempotent
 *    `(market_id, outcome_id, ts)` write), so overlapping points dedupe and the
 *    curve has no holes (Req 4.4 / 7.6 / 7.2). `lastSeenTs` advances across the
 *    gap, so a subsequent drop backfills from the new position.
 * 4. **Bounded attempts.** Reconnect attempts are capped
 *    ({@link ReconnectOptions.maxReconnectAttempts}); exhaustion surfaces a
 *    terminal {@link MaxReconnectsExceeded} via
 *    {@link ResilientStreamDeps.onReconnectFailed}.
 * 5. **Polling untouched.** Non-WebSocket sources have no connection to drop, so
 *    this delegates straight to {@link startPriceStream}'s polling path.
 *
 * Requirements: 7.6 (reconnect-with-backoff + backfill on a WS drop) and 4.4
 * (price history for a market that had a streaming gap is continuous).
 */

import type { MarketSource, NormalizedPricePoint, PriceTickHandler, Subscription } from "@pma/core";
import { canStreamPrices } from "./capability-gating.js";
import {
  onTick,
  startPriceStream,
  type PriceStreamHandle,
  type StartPriceStreamDeps,
  type StopPolling,
} from "./price-stream.js";

// ---------------------------------------------------------------------------
// Defaults (mirroring with-retry's backoff vocabulary)
// ---------------------------------------------------------------------------

/** Max re-subscribe attempts before surfacing a terminal failure. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/** `BASE_DELAY` (ms): the first reconnect's un-jittered backoff. */
export const DEFAULT_RECONNECT_BASE_DELAY_MS = 200;

/** `MAX_DELAY` (ms): upper bound on the exponential term (jitter adds on top). */
export const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Terminal failure
// ---------------------------------------------------------------------------

/**
 * Surfaced via {@link ResilientStreamDeps.onReconnectFailed} once reconnect
 * attempts are exhausted. The final underlying error is preserved both as
 * {@link lastError} and the standard `Error` `cause`.
 */
export class MaxReconnectsExceeded extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(`WebSocket reconnect failed after ${attempts} attempt(s)`, {
      cause: lastError,
    });
    this.name = "MaxReconnectsExceeded";
  }
}

// ---------------------------------------------------------------------------
// Options + dependencies
// ---------------------------------------------------------------------------

/** Tuning for the reconnect backoff schedule; each field falls back to a default. */
export interface ReconnectOptions {
  /**
   * Max re-subscribe attempts before giving up and invoking
   * `onReconnectFailed`. Defaults to {@link DEFAULT_MAX_RECONNECT_ATTEMPTS}.
   */
  maxReconnectAttempts?: number;
  /** `BASE_DELAY` in ms. Defaults to {@link DEFAULT_RECONNECT_BASE_DELAY_MS}. */
  baseDelayMs?: number;
  /** `MAX_DELAY` in ms — caps the exponential term. Defaults to {@link DEFAULT_RECONNECT_MAX_DELAY_MS}. */
  maxDelayMs?: number;
  /**
   * Injectable `[0, 1)` random source for the default jitter. Ignored when a
   * custom {@link jitter} is supplied. Defaults to {@link Math.random}.
   */
  random?: () => number;
  /**
   * Jitter (ms) added to each clamped backoff delay. Defaults to
   * `random() * baseDelayMs`. Override to assert exact delays in tests.
   */
  jitter?: () => number;
}

/**
 * Schedules a recurring disconnect check. Given a `check` callback it must
 * invoke it on a cadence and return a handle that stops the schedule. Injected
 * so disconnect detection runs without real timers in tests (production wires
 * it to `setInterval`).
 */
export type ScheduleHealthCheck = (check: () => void) => StopPolling;

/** Injected dependencies for {@link startResilientPriceStream}. */
export interface ResilientStreamDeps extends StartPriceStreamDeps {
  /** ISO-8601 clock for the backfill upper bound + initial `lastSeenTs` anchor. */
  now: () => string;
  /** Sleep used between reconnect attempts (the backoff). */
  sleep: (ms: number) => Promise<void>;
  /** Drives the recurring `subscription.isOpen` disconnect check (Req 7.6). */
  scheduleHealthCheck: ScheduleHealthCheck;
  /** Reconnect backoff tuning. */
  reconnect?: ReconnectOptions;
  /** Terminal-failure sink: called with {@link MaxReconnectsExceeded} on exhaustion. */
  onReconnectFailed?: (error: MaxReconnectsExceeded) => void;
}

/** Handle to a running resilient price stream. */
export interface ResilientPriceStreamHandle extends PriceStreamHandle {
  /** Successful reconnects performed so far (always 0 on the polling path). */
  reconnectCount(): number;
}

// ---------------------------------------------------------------------------
// Backoff delay (focused reuse of with-retry's jittered-exponential shape)
// ---------------------------------------------------------------------------

/**
 * `min(base · 2^attemptIndex, max) + jitter` for 0-based `attemptIndex`. Jitter
 * is added after the clamp, matching {@link withRetry}'s schedule, so the first
 * reconnect waits `base · 2^0 (+ jitter)`.
 */
function computeReconnectDelay(
  attemptIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: () => number,
): number {
  const exponential = baseDelayMs * 2 ** attemptIndex;
  return Math.min(exponential, maxDelayMs) + jitter();
}

// ---------------------------------------------------------------------------
// startResilientPriceStream
// ---------------------------------------------------------------------------

/**
 * Start a price stream that, on the WebSocket path, automatically reconnects
 * with backoff and backfills the missed interval so the price curve has no
 * holes (design `managePriceStream` `ON disconnect`; Req 7.6 / 4.4).
 *
 * Transport is chosen by the reused capability gate ({@link canStreamPrices}):
 *
 * - **Polling fallback** (`canStreamPrices(source) === false`): there is no
 *   connection to drop, so this delegates verbatim to {@link startPriceStream}
 *   — the polling path is entirely unaffected — and reports
 *   `reconnectCount() === 0`.
 * - **WebSocket** (`true`): subscribes, anchors `lastSeenTs` to `now()`, and
 *   arms an injected health check. When the current {@link Subscription}'s
 *   `isOpen` flips to `false`, it runs the reconnect-with-backfill flow:
 *   exponential backoff → `subscribePrices` again → `fetchPriceHistory` from the
 *   last-seen ts to now for each id, each point written idempotently through
 *   {@link onTick}. Attempts are bounded; exhaustion calls `onReconnectFailed`.
 *
 * All non-determinism (`now`, `sleep`, `random`/`jitter`, `scheduleHealthCheck`,
 * `schedulePolling`) is injected, so the whole flow is unit-testable without
 * real timers or sockets.
 */
export function startResilientPriceStream(
  source: MarketSource,
  activeIds: string[],
  deps: ResilientStreamDeps,
): ResilientPriceStreamHandle {
  // Polling path: no disconnects to handle — reuse 5.3 unchanged.
  if (!canStreamPrices(source)) {
    const handle = startPriceStream(source, activeIds, deps);
    return { ...handle, reconnectCount: () => 0 };
  }

  const reconnectOpts = deps.reconnect ?? {};
  const maxReconnectAttempts = reconnectOpts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  const baseDelayMs = reconnectOpts.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs = reconnectOpts.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const random = reconnectOpts.random ?? Math.random;
  const jitter = reconnectOpts.jitter ?? (() => random() * baseDelayMs);

  // `lastSeen` is the backfill anchor. Per the design it starts at the stream's
  // open time (`lastSeenTs ← now()`), so a drop before any tick still backfills
  // from when the stream began. Each processed tick/backfill point advances it.
  let lastSeen: string = deps.now();
  let reconnectCount = 0;
  // Guards against overlapping reconnects (a health check firing mid-reconnect)
  // and against work continuing after stop().
  let reconnecting = false;
  let stopped = false;

  // Shared tick path for live ticks AND backfilled points: process through the
  // 5.3 pipeline, then advance the backfill anchor.
  const runTick = async (tick: NormalizedPricePoint): Promise<void> => {
    const result = await onTick(tick, deps);
    lastSeen = result.lastSeenTs;
  };

  // One stable handler instance, reused across every (re)subscribe.
  const handler: PriceTickHandler = (tick) => {
    void runTick(tick).catch((error) => deps.onError?.(error));
  };

  const subscribe = (): Subscription =>
    // Safe: `canStreamPrices` guarantees `subscribePrices` is present.
    source.subscribePrices!(activeIds, handler);

  let currentSub: Subscription = subscribe();

  /**
   * Backfill `[from, to]` for every active id, writing each point through the
   * idempotent {@link onTick} pipeline so overlaps dedupe (Req 4.4 / 7.2).
   */
  const backfill = async (from: string, to: string): Promise<void> => {
    for (const id of activeIds) {
      const gap = await source.fetchPriceHistory(id, { from, to });
      for (const point of gap) {
        await runTick(point);
      }
    }
  };

  /** The design's `ON disconnect` block: backoff → re-subscribe → backfill. */
  const reconnect = async (): Promise<void> => {
    reconnecting = true;
    // Anchor the gap's lower bound at the disconnect point (frozen while
    // disconnected — no ticks advance `lastSeen` until we re-subscribe).
    const from = lastSeen;
    let attempt = 0;
    for (;;) {
      if (stopped) {
        reconnecting = false;
        return;
      }
      // Backoff BEFORE each re-subscribe attempt (design `backoffReconnect()`).
      await deps.sleep(computeReconnectDelay(attempt, baseDelayMs, maxDelayMs, jitter));
      attempt += 1;

      if (stopped) {
        reconnecting = false;
        return;
      }

      let attemptSub: Subscription | undefined;
      try {
        attemptSub = subscribe();
        // `to` is captured as late as possible (after re-subscribe) to minimize
        // any residual hole before live ticks resume.
        await backfill(from, deps.now());
        currentSub = attemptSub;
        handle.subscription = attemptSub;
        reconnectCount += 1;
        reconnecting = false;
        return;
      } catch (error) {
        // Avoid leaking the half-open subscription before the next attempt.
        attemptSub?.close();
        if (attempt >= maxReconnectAttempts) {
          reconnecting = false;
          stopped = true;
          stopHealthCheck();
          deps.onReconnectFailed?.(new MaxReconnectsExceeded(attempt, error));
          return;
        }
        // else: loop and retry after a longer backoff.
      }
    }
  };

  // Disconnect detection: fire the reconnect flow when the current subscription
  // is no longer open (and we're neither already reconnecting nor stopped).
  const stopHealthCheck = deps.scheduleHealthCheck(() => {
    if (stopped || reconnecting) return;
    if (!currentSub.isOpen) {
      void reconnect().catch((error) => deps.onError?.(error));
    }
  });

  const handle: ResilientPriceStreamHandle = {
    mode: "websocket",
    subscription: currentSub,
    lastSeenTs: () => lastSeen,
    reconnectCount: () => reconnectCount,
    stop: () => {
      stopped = true;
      stopHealthCheck();
      currentSub.close();
    },
  };

  return handle;
}
