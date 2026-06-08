import { describe, it, expect, vi } from "vitest";
import type {
  MarketSource,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPricePoint,
  NormalizedPriceSnapshot,
  Page,
  PricePoint,
  PriceTickHandler,
  SourceCapabilities,
  SourceMeta,
  Subscription,
  TimeRange,
} from "@pma/core";
import type { PricePayload } from "@pma/storage";
import { startResilientPriceStream, MaxReconnectsExceeded } from "./resilient-price-stream.js";
import type { ResilientStreamDeps, ScheduleHealthCheck } from "./resilient-price-stream.js";
import type {
  HotPriceWriter,
  PricePointWriter,
  PricePublisher,
  ResolvedIds,
} from "./price-stream.js";

/**
 * Unit tests for WebSocket reconnect-with-backfill (task 5.4 / Requirements
 * 7.6, 4.4). Everything is in-memory and deterministic: fake hot cache, fake
 * price-point repo, fake fan-out publisher, fake id resolver, a scripted fake
 * {@link MarketSource} whose {@link Subscription} `isOpen` flag is mutable, and
 * an injected health check / clock / sleep. No real Redis / DB / WebSockets /
 * timers.
 */

const T0 = "2024-06-01T00:00:00.000Z";

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makePoint(overrides: Partial<NormalizedPricePoint> = {}): NormalizedPricePoint {
  return {
    marketExternalId: "ext-1",
    outcomeLabel: "Yes",
    price: 0.6,
    volume: 1000,
    ts: T0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes (mirroring price-stream.test.ts)
// ---------------------------------------------------------------------------

interface HotPriceWrite {
  marketId: string;
  outcomeLabel: string;
  price: number;
  options?: { volume?: number | null; ts?: string; ttlMs?: number };
}

class FakeHotPriceCache implements HotPriceWriter {
  readonly writes: HotPriceWrite[] = [];
  setHotPrice(
    marketId: string,
    outcomeLabel: string,
    price: number,
    options?: { volume?: number | null; ts?: string; ttlMs?: number },
  ): Promise<void> {
    this.writes.push({ marketId, outcomeLabel, price, options });
    return Promise.resolve();
  }
}

class FakePricePointRepo implements PricePointWriter {
  readonly points: PricePoint[] = [];
  writePricePoint(point: PricePoint): Promise<void> {
    this.points.push(point);
    return Promise.resolve();
  }
}

interface PublishCall {
  marketId: string;
  payload: PricePayload;
}

class FakeFanoutPublisher implements PricePublisher {
  readonly published: PublishCall[] = [];
  publishPrice(marketId: string, payload: PricePayload): Promise<number> {
    this.published.push({ marketId, payload });
    return Promise.resolve(1);
  }
}

/** Resolver that maps any external id to deterministic internal ids. */
function makeResolver(): (marketExternalId: string, outcomeLabel: string) => ResolvedIds {
  return (marketExternalId, outcomeLabel) => ({
    marketId: `mid-${marketExternalId}`,
    outcomeId: `oid-${outcomeLabel}`,
  });
}

/** A test subscription with a mutable `isOpen` so disconnects can be simulated. */
interface TestSubscription {
  isOpen: boolean;
  close: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake {@link MarketSource} for the resilient stream:
 * - `subscribePrices` is a spy that captures the (single, reused) tick handler
 *   and returns a fresh {@link TestSubscription} (mutable `isOpen`, spied
 *   `close`) on each call; all created subscriptions are exposed so a test can
 *   flip `isOpen` to simulate a drop. With `failReconnect`, every call after the
 *   first throws (to exercise backoff/bounded attempts).
 * - `fetchPriceHistory` is a spy delegating to an injectable `fetchHistory`, so
 *   tests control the gap returned for each `(id, range)`.
 */
function makeFakeSource(opts: {
  websocketPrices: boolean;
  hasSubscribe: boolean;
  fetchHistory?: (id: string, range: TimeRange) => Promise<NormalizedPricePoint[]>;
  failReconnect?: boolean;
}): {
  source: MarketSource;
  subscribeSpy: ReturnType<typeof vi.fn>;
  fetchHistorySpy: ReturnType<typeof vi.fn>;
  subscriptions: TestSubscription[];
} {
  const meta: SourceMeta = {
    id: SOURCE_ID,
    key: "fake",
    name: "Fake Source",
    type: "onchain",
    baseCurrency: "USDC",
  };
  const capabilities: SourceCapabilities = {
    websocketPrices: opts.websocketPrices,
    priceHistory: true,
    orderBookDepth: false,
    keysetPagination: true,
  };

  const subscriptions: TestSubscription[] = [];
  let subscribeCalls = 0;
  const subscribeSpy = vi.fn((_ids: string[], _handler: PriceTickHandler) => {
    subscribeCalls += 1;
    if (opts.failReconnect && subscribeCalls > 1) {
      throw new Error(`ws subscribe failed (reconnect attempt ${subscribeCalls - 1})`);
    }
    const sub: TestSubscription = { isOpen: true, close: vi.fn() };
    subscriptions.push(sub);
    return sub as unknown as Subscription;
  });

  const fetchHistory =
    opts.fetchHistory ?? ((): Promise<NormalizedPricePoint[]> => Promise.resolve([]));
  const fetchHistorySpy = vi.fn((id: string, range: TimeRange) => fetchHistory(id, range));

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (): Promise<Page<NormalizedMarket>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
    fetchPriceHistory: fetchHistorySpy as unknown as MarketSource["fetchPriceHistory"],
    capabilities: () => capabilities,
  };
  if (opts.hasSubscribe) {
    source.subscribePrices = subscribeSpy as unknown as MarketSource["subscribePrices"];
  }

  return { source, subscribeSpy, fetchHistorySpy, subscriptions };
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------

function makeDeps(overrides: Partial<ResilientStreamDeps> = {}): {
  deps: ResilientStreamDeps;
  hotPriceCache: FakeHotPriceCache;
  pricePointRepo: FakePricePointRepo;
  fanoutPublisher: FakeFanoutPublisher;
  sleepDurations: number[];
  triggerHealthCheck: () => void;
  scheduleHealthCheckSpy: ReturnType<typeof vi.fn>;
  stopHealthCheckSpy: ReturnType<typeof vi.fn>;
  setNow: (ts: string) => void;
} {
  const hotPriceCache = new FakeHotPriceCache();
  const pricePointRepo = new FakePricePointRepo();
  const fanoutPublisher = new FakeFanoutPublisher();
  const sleepDurations: number[] = [];
  let nowValue = T0;
  let healthCheck: (() => void) | null = null;
  const stopHealthCheckSpy = vi.fn();
  const scheduleHealthCheckSpy = vi.fn<ScheduleHealthCheck>((check) => {
    healthCheck = check;
    return stopHealthCheckSpy;
  });

  const deps: ResilientStreamDeps = {
    hotPriceCache,
    pricePointRepo,
    fanoutPublisher,
    resolveIds: makeResolver(),
    schedulePolling: (poll) => {
      void poll();
      return () => undefined;
    },
    now: () => nowValue,
    sleep: (ms: number) => {
      sleepDurations.push(ms);
      return Promise.resolve();
    },
    scheduleHealthCheck: scheduleHealthCheckSpy,
    // Deterministic, zero jitter by default; overridden where delays are asserted.
    reconnect: { jitter: () => 0 },
    ...overrides,
  };

  return {
    deps,
    hotPriceCache,
    pricePointRepo,
    fanoutPublisher,
    sleepDurations,
    triggerHealthCheck: () => {
      if (healthCheck === null) {
        throw new Error("scheduleHealthCheck was not called");
      }
      healthCheck();
    },
    scheduleHealthCheckSpy,
    stopHealthCheckSpy,
    setNow: (ts: string) => {
      nowValue = ts;
    },
  };
}

// ---------------------------------------------------------------------------
// WebSocket path: disconnect detection + backoff + re-subscribe
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — disconnect → backoff → re-subscribe", () => {
  it("on a detected drop, backs off (sleeps) and re-subscribes", async () => {
    const { source, subscribeSpy, subscriptions } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    expect(handle.mode).toBe("websocket");
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(handle.reconnectCount()).toBe(0);

    // Simulate the socket dropping, then fire the recurring health check.
    subscriptions[0]!.isOpen = false;
    ctx.triggerHealthCheck();

    await vi.waitFor(() => {
      expect(handle.reconnectCount()).toBe(1);
    });

    // Backoff happened (default base 200ms, zero jitter) and we re-subscribed.
    expect(ctx.sleepDurations).toEqual([200]);
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    // The live subscription advanced to the fresh, open one.
    expect(subscriptions).toHaveLength(2);
    expect(handle.subscription).toBe(subscriptions[1] as unknown as Subscription);
  });

  it("ignores the health check while the subscription is still open", () => {
    const { source, subscribeSpy } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    // Subscription is open; the periodic check must be a no-op.
    ctx.triggerHealthCheck();
    ctx.triggerHealthCheck();

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(ctx.sleepDurations).toEqual([]);
    expect(handle.reconnectCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Backfill: fetchPriceHistory(from=lastSeen, to=now) per id, written via onTick
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — gap backfill via fetchPriceHistory", () => {
  it("backfills [lastSeen, now] for each active id and writes each gap point idempotently", async () => {
    const GAP_TS = "2024-06-01T00:05:00.000Z";
    const T1 = "2024-06-01T00:10:00.000Z";

    // Each id reports one missed point during the gap.
    const fetchHistory = (id: string): Promise<NormalizedPricePoint[]> =>
      Promise.resolve([
        makePoint({ marketExternalId: id, outcomeLabel: "Yes", price: 0.7, ts: GAP_TS }),
      ]);

    const { source, fetchHistorySpy, subscriptions } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
      fetchHistory,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1", "ext-2"], ctx.deps);

    // Drop after the clock has advanced; backfill upper bound should be `now`.
    ctx.setNow(T1);
    subscriptions[0]!.isOpen = false;
    ctx.triggerHealthCheck();

    await vi.waitFor(() => {
      expect(handle.reconnectCount()).toBe(1);
    });

    // fetchPriceHistory(id, { from: lastSeen=T0, to: now=T1 }) for each id.
    expect(fetchHistorySpy).toHaveBeenCalledTimes(2);
    expect(fetchHistorySpy).toHaveBeenNthCalledWith(1, "ext-1", { from: T0, to: T1 });
    expect(fetchHistorySpy).toHaveBeenNthCalledWith(2, "ext-2", { from: T0, to: T1 });

    // Each gap point flowed through the idempotent onTick pipeline:
    // hot cache + price-point repo + fan-out each saw both ids' points.
    expect(ctx.hotPriceCache.writes).toEqual([
      { marketId: "ext-1", outcomeLabel: "Yes", price: 0.7, options: { volume: 1000, ts: GAP_TS } },
      { marketId: "ext-2", outcomeLabel: "Yes", price: 0.7, options: { volume: 1000, ts: GAP_TS } },
    ]);
    expect(ctx.pricePointRepo.points).toEqual([
      { marketId: "mid-ext-1", outcomeId: "oid-Yes", ts: GAP_TS, price: 0.7, volume: 1000 },
      { marketId: "mid-ext-2", outcomeId: "oid-Yes", ts: GAP_TS, price: 0.7, volume: 1000 },
    ]);
    expect(ctx.fanoutPublisher.published.map((p) => p.marketId)).toEqual(["ext-1", "ext-2"]);
  });

  it("advances lastSeenTs across the gap so a second drop backfills from the new position", async () => {
    const GAP_TS = "2024-06-01T00:05:00.000Z";
    const T1 = "2024-06-01T00:10:00.000Z";
    const T2 = "2024-06-01T00:20:00.000Z";

    // First backfill yields one point at GAP_TS; the second yields nothing.
    let historyCall = 0;
    const fetchHistory = (id: string): Promise<NormalizedPricePoint[]> => {
      historyCall += 1;
      return Promise.resolve(
        historyCall === 1
          ? [makePoint({ marketExternalId: id, outcomeLabel: "Yes", ts: GAP_TS })]
          : [],
      );
    };

    const { source, fetchHistorySpy, subscriptions } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
      fetchHistory,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    // First drop: backfill from the open-time anchor T0 to T1.
    ctx.setNow(T1);
    subscriptions[0]!.isOpen = false;
    ctx.triggerHealthCheck();
    await vi.waitFor(() => {
      expect(handle.reconnectCount()).toBe(1);
    });
    expect(handle.lastSeenTs()).toBe(GAP_TS);

    // Second drop on the re-subscribed socket: backfill must start at GAP_TS.
    ctx.setNow(T2);
    subscriptions[1]!.isOpen = false;
    ctx.triggerHealthCheck();
    await vi.waitFor(() => {
      expect(handle.reconnectCount()).toBe(2);
    });

    expect(fetchHistorySpy).toHaveBeenNthCalledWith(1, "ext-1", { from: T0, to: T1 });
    expect(fetchHistorySpy).toHaveBeenNthCalledWith(2, "ext-1", { from: GAP_TS, to: T2 });
  });
});

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — reconnect backoff schedule", () => {
  it("sleeps min(base*2^i, max) + jitter before each attempt, clamped at max", async () => {
    const { source } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
      failReconnect: true, // every re-subscribe throws → exhaust attempts
    });
    const onReconnectFailed = vi.fn();
    const ctx = makeDeps({
      reconnect: {
        maxReconnectAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        jitter: () => 7,
      },
      onReconnectFailed,
    });

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    // Simulate a drop on the initial subscription, then fire the health check.
    (handle.subscription as unknown as TestSubscription).isOpen = false;
    ctx.triggerHealthCheck();

    await vi.waitFor(() => {
      expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    });

    // i = 0..4: 100, 200, 400, 800, min(1600,1000)=1000 — each + jitter(7).
    expect(ctx.sleepDurations).toEqual([107, 207, 407, 807, 1007]);
  });
});

// ---------------------------------------------------------------------------
// Bounded attempts
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — bounded reconnect attempts", () => {
  it("surfaces MaxReconnectsExceeded once attempts are exhausted", async () => {
    const { source, subscribeSpy } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
      failReconnect: true,
    });
    const onReconnectFailed = vi.fn();
    const ctx = makeDeps({
      reconnect: { maxReconnectAttempts: 3, baseDelayMs: 10, jitter: () => 0 },
      onReconnectFailed,
    });

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    (handle.subscription as unknown as TestSubscription).isOpen = false;
    ctx.triggerHealthCheck();

    await vi.waitFor(() => {
      expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    });

    const error = onReconnectFailed.mock.calls[0]![0] as MaxReconnectsExceeded;
    expect(error).toBeInstanceOf(MaxReconnectsExceeded);
    expect(error.attempts).toBe(3);
    expect(error.lastError).toBeInstanceOf(Error);

    // The initial subscribe + 3 failed re-subscribe attempts.
    expect(subscribeSpy).toHaveBeenCalledTimes(1 + 3);
    expect(ctx.sleepDurations).toHaveLength(3);
    // No successful reconnect, and the health check was torn down on giving up.
    expect(handle.reconnectCount()).toBe(0);
    expect(ctx.stopHealthCheckSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Polling path is unaffected
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — polling path", () => {
  it("delegates to the polling stream and never arms reconnect", () => {
    const { source, subscribeSpy } = makeFakeSource({
      websocketPrices: false,
      hasSubscribe: false,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    expect(handle.mode).toBe("polling");
    expect(handle.reconnectCount()).toBe(0);
    expect(handle.subscription).toBeUndefined();
    // No WebSocket and no disconnect machinery on the polling path.
    expect(subscribeSpy).not.toHaveBeenCalled();
    expect(ctx.scheduleHealthCheckSpy).not.toHaveBeenCalled();
    expect(ctx.sleepDurations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stop()
// ---------------------------------------------------------------------------

describe("startResilientPriceStream — stop()", () => {
  it("halts the health check, closes the subscription, and ignores later drops", () => {
    const { source, subscribeSpy, subscriptions } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
    });
    const ctx = makeDeps();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);

    handle.stop();

    expect(ctx.stopHealthCheckSpy).toHaveBeenCalledTimes(1);
    expect(subscriptions[0]!.close).toHaveBeenCalledTimes(1);

    // A drop after stop() must not trigger any reconnect work.
    subscriptions[0]!.isOpen = false;
    ctx.triggerHealthCheck();
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(ctx.sleepDurations).toEqual([]);
    expect(handle.reconnectCount()).toBe(0);
  });
});
