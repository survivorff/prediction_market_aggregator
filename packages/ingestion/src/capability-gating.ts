/**
 * Capability gating for price streaming — the small, pure decision seam that
 * the price-stream orchestrator (task 5.3) builds on.
 *
 * The design's `managePriceStream` algorithm opens with a single, load-bearing
 * decision (design.md "Price tiering + WebSocket reconnect with backfill"):
 *
 * ```pascal
 * IF NOT source.capabilities().websocketPrices THEN
 *   schedulePolling(source, activeIds, INTERVAL_ACTIVE)   // fallback (e.g. Manifold)
 *   RETURN
 * END IF
 * sub ← source.subscribePrices(activeIds, onTick)
 * ```
 *
 * This module extracts exactly that gate — *should we stream via WebSocket, or
 * fall back to polling?* — as a dependency-injected pure function so it can be
 * exhaustively property-tested today, before the fuller stream management
 * (reconnect-with-backfill, `onTick` side effects, hot cache, fan-out) lands in
 * task 5.3. Task 5.3 composes its reconnect/backfill loop on top of (or
 * replaces) this seam without changing the gating semantics.
 *
 * Requirements:
 * - 7.4: stream active markets via WebSocket and invoke `subscribePrices` when
 *   `websocketPrices === true`; otherwise serve via tiered polling and NEVER
 *   invoke `subscribePrices`.
 * - 8.1: adapter isolation — this gate depends only on the `@pma/core`
 *   `MarketSource` port, never on a concrete adapter.
 * - 8.3: the orchestrator only calls optional methods the adapter's
 *   capabilities permit — i.e. never call `subscribePrices` unless it is both
 *   declared (`websocketPrices === true`) and actually present.
 *
 * Design correctness property: P7 (Capability gating).
 */

import type { MarketSource, PriceTickHandler, Subscription } from "@pma/core";

/** Which transport the gate chose for a source's active markets. */
export type PriceStreamMode = "websocket" | "polling";

/**
 * Dependencies the gate needs to actually wire up a transport, injected so the
 * decision is testable without real WebSockets, timers, or storage.
 *
 * `schedulePolling` is the long-tail/fallback poller the design references as
 * `schedulePolling(source, activeIds, INTERVAL_ACTIVE)`; the interval/cadence
 * policy is the orchestrator's concern (task 5.3), so it is intentionally not
 * part of this minimal gate. `onTick` is the per-tick handler passed straight
 * through to `subscribePrices` when streaming.
 */
export interface PriceStreamDeps {
  /** Start tiered polling for `marketIds` (the non-WebSocket path). */
  schedulePolling: (source: MarketSource, marketIds: string[]) => void;
  /** Handler invoked for each live tick when streaming over WebSocket. */
  onTick: PriceTickHandler;
}

/** Outcome of the gating decision: the chosen mode plus any live subscription. */
export interface PriceStreamDecision {
  mode: PriceStreamMode;
  /** Present only when `mode === "websocket"`; the open subscription handle. */
  subscription?: Subscription;
}

/**
 * Decide whether a source streams its active markets over WebSocket or falls
 * back to polling, and wire up the chosen transport.
 *
 * The single source of truth is the conjunction of *declared* and *present*:
 *
 * > stream  ⇔  `capabilities().websocketPrices === true`  AND  `subscribePrices` is a function
 *
 * - When that holds, `subscribePrices(activeIds, deps.onTick)` is invoked and
 *   polling is NOT scheduled — the WebSocket path (Requirement 7.4).
 * - Otherwise `deps.schedulePolling(source, activeIds)` runs and
 *   `subscribePrices` is NEVER called — the polling fallback (Requirements 7.4,
 *   8.3).
 *
 * **Edge case — `websocketPrices === true` but `subscribePrices` is absent.**
 * Per design, declaring the capability means the method is implemented, so this
 * is a misconfigured adapter. The safe, documented choice (consistent with
 * "never call what isn't there", Requirement 8.3) is to treat the missing
 * method as *not capable* and fall back to polling rather than throw. This
 * keeps the gate total: it never invokes an absent method and never crashes the
 * orchestrator on a malformed adapter.
 *
 * The function is pure aside from the injected side effects (it calls exactly
 * one of `subscribePrices` / `schedulePolling`), which is what makes the gating
 * invariant property-testable.
 */
export function managePriceStream(
  source: MarketSource,
  activeIds: string[],
  deps: PriceStreamDeps,
): PriceStreamDecision {
  if (canStreamPrices(source)) {
    // Safe: `canStreamPrices` guarantees `subscribePrices` is present.
    const subscription = source.subscribePrices!(activeIds, deps.onTick);
    return { mode: "websocket", subscription };
  }

  // Capability false/undeclared (or method missing): tiered-polling fallback.
  deps.schedulePolling(source, activeIds);
  return { mode: "polling" };
}

/**
 * True iff `source` may be streamed over WebSocket: it both declares the
 * `websocketPrices` capability AND actually provides a `subscribePrices`
 * method. This is the exact predicate the orchestrator must satisfy before
 * calling the optional method (Requirement 8.3).
 */
export function canStreamPrices(source: MarketSource): boolean {
  return (
    source.capabilities().websocketPrices === true && typeof source.subscribePrices === "function"
  );
}
