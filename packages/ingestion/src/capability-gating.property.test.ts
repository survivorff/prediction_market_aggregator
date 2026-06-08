import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import type {
  MarketSource,
  SourceMeta,
  SourceCapabilities,
  Page,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  Subscription,
} from "@pma/core";
import { managePriceStream, canStreamPrices } from "./capability-gating.js";
import type { PriceStreamDeps } from "./capability-gating.js";

/**
 * Property-based tests for capability gating (design "Correctness Properties" →
 * Property 7: Capability gating; task 4.5).
 *
 * The universal rule, straight from the design's `managePriceStream` gate and
 * Requirement 7.4 / 8.3:
 *
 *   `subscribePrices` is invoked IFF the source both declares
 *   `capabilities().websocketPrices === true` AND actually provides the method;
 *   otherwise the source is served by polling and `subscribePrices` is NEVER
 *   called.
 *
 * The generators independently vary all four capability flags AND whether the
 * fake adapter actually exposes a `subscribePrices` method, so the "declared
 * but absent" misconfiguration is exercised alongside the well-formed cases.
 *
 * **Validates: Requirements 7.4, 8.1, 8.3**
 */

/** Pure/in-memory gate → cheap; run many cases to cover the flag combinations. */
const NUM_RUNS = 500;

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/** Arbitrary over the full 2^4 space of capability flag combinations. */
const arbCapabilities = (): fc.Arbitrary<SourceCapabilities> =>
  fc.record({
    websocketPrices: fc.boolean(),
    priceHistory: fc.boolean(),
    orderBookDepth: fc.boolean(),
    keysetPagination: fc.boolean(),
  });

/** Arbitrary list of active market ids (may be empty — gating is id-agnostic). */
const arbActiveIds = (): fc.Arbitrary<string[]> =>
  fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
    minLength: 0,
    maxLength: 6,
  });

/**
 * Build a fake {@link MarketSource} with the given capabilities, independently
 * controlling whether `subscribePrices` is actually present. Spies count how
 * often the optional method is invoked so the property can assert exact call
 * counts.
 */
function makeFakeSource(
  capabilities: SourceCapabilities,
  hasSubscribe: boolean,
): {
  source: MarketSource;
  subscribeSpy: ReturnType<typeof vi.fn>;
  subscription: Subscription;
} {
  const meta: SourceMeta = {
    id: PLACEHOLDER_ID,
    key: "fake",
    name: "Fake Source",
    type: "onchain",
    baseCurrency: "USDC",
  };

  const subscription: Subscription = { close: () => undefined, isOpen: true };
  const subscribeSpy = vi.fn(() => subscription);

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (): Promise<Page<NormalizedMarket>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
    fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
    capabilities: () => capabilities,
  };

  if (hasSubscribe) {
    source.subscribePrices = subscribeSpy;
  }

  return { source, subscribeSpy, subscription };
}

describe("Property 7: capability gating — subscribePrices iff websocketPrices", () => {
  it("invokes subscribePrices IFF websocketPrices===true AND the method is present; otherwise polls", () => {
    fc.assert(
      fc.property(
        arbCapabilities(),
        fc.boolean(),
        arbActiveIds(),
        (capabilities, hasSubscribe, activeIds) => {
          const { source, subscribeSpy } = makeFakeSource(capabilities, hasSubscribe);
          const schedulePolling = vi.fn<PriceStreamDeps["schedulePolling"]>();
          const onTick = vi.fn();

          // The gate must never throw — even for the misconfigured
          // "declared true but method absent" case (Requirement 8.3).
          const decision = managePriceStream(source, activeIds, {
            schedulePolling,
            onTick,
          });

          const shouldStream = capabilities.websocketPrices === true && hasSubscribe;

          if (shouldStream) {
            // WebSocket path: subscribe exactly once, with the active ids and
            // the injected tick handler; polling is NOT used (Requirement 7.4).
            expect(decision.mode).toBe("websocket");
            expect(subscribeSpy).toHaveBeenCalledTimes(1);
            expect(subscribeSpy).toHaveBeenCalledWith(activeIds, onTick);
            expect(schedulePolling).not.toHaveBeenCalled();
            expect(decision.subscription).toBeDefined();
          } else {
            // Polling path: subscribePrices is NEVER called; polling runs once
            // with the active ids (Requirements 7.4, 8.3).
            expect(decision.mode).toBe("polling");
            expect(subscribeSpy).not.toHaveBeenCalled();
            expect(schedulePolling).toHaveBeenCalledTimes(1);
            expect(schedulePolling).toHaveBeenCalledWith(source, activeIds);
            expect(decision.subscription).toBeUndefined();
          }

          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("never invokes subscribePrices when websocketPrices===false (regardless of method presence)", () => {
    fc.assert(
      fc.property(
        arbCapabilities().map((c) => ({ ...c, websocketPrices: false })),
        fc.boolean(),
        arbActiveIds(),
        (capabilities, hasSubscribe, activeIds) => {
          const { source, subscribeSpy } = makeFakeSource(capabilities, hasSubscribe);
          const schedulePolling = vi.fn<PriceStreamDeps["schedulePolling"]>();

          const decision = managePriceStream(source, activeIds, {
            schedulePolling,
            onTick: vi.fn(),
          });

          expect(decision.mode).toBe("polling");
          expect(subscribeSpy).not.toHaveBeenCalled();
          expect(schedulePolling).toHaveBeenCalledTimes(1);
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("websocketPrices===true but method absent: falls back to polling and never throws", () => {
    fc.assert(
      fc.property(
        arbCapabilities().map((c) => ({ ...c, websocketPrices: true })),
        arbActiveIds(),
        (capabilities, activeIds) => {
          // Misconfigured adapter: declares the capability, omits the method.
          const { source } = makeFakeSource(capabilities, /* hasSubscribe */ false);
          const schedulePolling = vi.fn<PriceStreamDeps["schedulePolling"]>();

          let decision;
          // Must not throw / must not call a missing method.
          expect(() => {
            decision = managePriceStream(source, activeIds, {
              schedulePolling,
              onTick: vi.fn(),
            });
          }).not.toThrow();

          expect(decision!.mode).toBe("polling");
          expect(schedulePolling).toHaveBeenCalledTimes(1);
          expect(canStreamPrices(source)).toBe(false);
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("exactly one transport is wired per call (WebSocket XOR polling)", () => {
    fc.assert(
      fc.property(
        arbCapabilities(),
        fc.boolean(),
        arbActiveIds(),
        (capabilities, hasSubscribe, activeIds) => {
          const { source, subscribeSpy } = makeFakeSource(capabilities, hasSubscribe);
          const schedulePolling = vi.fn<PriceStreamDeps["schedulePolling"]>();

          managePriceStream(source, activeIds, {
            schedulePolling,
            onTick: vi.fn(),
          });

          const streamed = subscribeSpy.mock.calls.length;
          const polled = schedulePolling.mock.calls.length;
          // Mutually exclusive and exhaustive: precisely one path runs once.
          expect(streamed + polled).toBe(1);
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("canStreamPrices", () => {
  it("agrees with the gate's chosen mode across all flag/method combinations", () => {
    fc.assert(
      fc.property(
        arbCapabilities(),
        fc.boolean(),
        arbActiveIds(),
        (capabilities, hasSubscribe, activeIds) => {
          const { source } = makeFakeSource(capabilities, hasSubscribe);
          const decision = managePriceStream(source, activeIds, {
            schedulePolling: vi.fn(),
            onTick: vi.fn(),
          });

          const expected = capabilities.websocketPrices === true && hasSubscribe;
          expect(canStreamPrices(source)).toBe(expected);
          expect(decision.mode).toBe(expected ? "websocket" : "polling");
          return true;
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
