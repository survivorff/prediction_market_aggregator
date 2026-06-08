import { describe, it, expect, vi } from "vitest";
import type {
  Market,
  MarketSource,
  NormalizedPriceSnapshot,
  PricePoint,
  PriceTickHandler,
  ResolutionCriteria,
  SourceCapabilities,
  SourceMeta,
  Subscription,
  Page,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPricePoint,
} from "@pma/core";
import type { PricePayload } from "@pma/storage";
import {
  classifyTier,
  onTick,
  startPriceStream,
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_VOLUME_THRESHOLD,
} from "./price-stream.js";
import type {
  HotPriceWriter,
  PricePointWriter,
  PricePublisher,
  ResolvedIds,
  SchedulePolling,
  StartPriceStreamDeps,
} from "./price-stream.js";

/**
 * Unit tests for price tiering + stream management (task 5.3 / Requirements
 * 7.4, 10.4, 9.2). Everything is in-memory: fake hot cache, fake price-point
 * repo, fake fan-out publisher, fake id resolver, and a scripted fake
 * {@link MarketSource}. No real Redis / DB / WebSockets.
 */

const NOW = new Date("2024-06-01T12:00:00.000Z");
const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeResolutionCriteria(overrides: Partial<ResolutionCriteria> = {}): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {}, ...overrides };
}

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "m-1",
    sourceId: SOURCE_ID,
    eventId: null,
    canonicalEventId: null,
    externalId: "ext-1",
    question: "Will it rain?",
    status: "open",
    volume24h: 0,
    liquidity: 100,
    spread: 0.02,
    resolutionCriteria: makeResolutionCriteria(),
    ...overrides,
  };
}

function makeTick(overrides: Partial<NormalizedPriceSnapshot> = {}): NormalizedPriceSnapshot {
  return {
    marketExternalId: "ext-1",
    outcomeLabel: "Yes",
    price: 0.6,
    volume: 1000,
    ts: "2024-06-01T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fakes
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
function makeResolver(
  table: Record<string, ResolvedIds | null> = {},
): (marketExternalId: string, outcomeLabel: string) => ResolvedIds | null {
  return (marketExternalId, outcomeLabel) => {
    const key = `${marketExternalId}\u0000${outcomeLabel}`;
    if (key in table) return table[key] ?? null;
    return { marketId: `mid-${marketExternalId}`, outcomeId: `oid-${outcomeLabel}` };
  };
}

function makeDeps(overrides: Partial<StartPriceStreamDeps> = {}): StartPriceStreamDeps & {
  hotPriceCache: FakeHotPriceCache;
  pricePointRepo: FakePricePointRepo;
  fanoutPublisher: FakeFanoutPublisher;
} {
  const hotPriceCache = new FakeHotPriceCache();
  const pricePointRepo = new FakePricePointRepo();
  const fanoutPublisher = new FakeFanoutPublisher();
  return {
    hotPriceCache,
    pricePointRepo,
    fanoutPublisher,
    resolveIds: makeResolver(),
    schedulePolling: (poll) => {
      void poll();
      return () => undefined;
    },
    ...overrides,
  } as StartPriceStreamDeps & {
    hotPriceCache: FakeHotPriceCache;
    pricePointRepo: FakePricePointRepo;
    fanoutPublisher: FakeFanoutPublisher;
  };
}

/** Build a fake source, controlling capability + presence of subscribePrices. */
function makeFakeSource(opts: {
  websocketPrices: boolean;
  hasSubscribe: boolean;
  snapshots?: NormalizedPriceSnapshot[];
}): {
  source: MarketSource;
  subscribeSpy: ReturnType<typeof vi.fn>;
  fetchSnapshotSpy: ReturnType<typeof vi.fn>;
  emit: (tick: NormalizedPriceSnapshot) => void;
  subscription: Subscription;
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

  const subscription: Subscription = { close: vi.fn(), isOpen: true };
  let captured: PriceTickHandler | null = null;
  const subscribeSpy = vi.fn((_ids: string[], handler: PriceTickHandler) => {
    captured = handler;
    return subscription;
  });
  const fetchSnapshotSpy = vi.fn(() => Promise.resolve(opts.snapshots ?? []));

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (): Promise<Page<NormalizedMarket>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchPriceSnapshot: fetchSnapshotSpy as unknown as MarketSource["fetchPriceSnapshot"],
    fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
    capabilities: () => capabilities,
  };
  if (opts.hasSubscribe) {
    source.subscribePrices = subscribeSpy as unknown as MarketSource["subscribePrices"];
  }

  return {
    source,
    subscribeSpy,
    fetchSnapshotSpy,
    emit: (tick) => {
      if (captured === null) throw new Error("subscribePrices was not called");
      captured(tick);
    },
    subscription,
  };
}

// ---------------------------------------------------------------------------
// classifyTier
// ---------------------------------------------------------------------------

describe("classifyTier", () => {
  it("classifies an open market with an imminent cutoff as active", () => {
    const cutoff = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(); // +1h
    const market = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: cutoff }),
    });
    expect(classifyTier(market, NOW)).toBe("active");
  });

  it("classifies an open market with high 24h volume as active (cutoff far off)", () => {
    const farCutoff = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const market = makeMarket({
      volume24h: DEFAULT_VOLUME_THRESHOLD + 1,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: farCutoff }),
    });
    expect(classifyTier(market, NOW)).toBe("active");
  });

  it("treats volume exactly at the threshold as active (boundary)", () => {
    const market = makeMarket({ volume24h: DEFAULT_VOLUME_THRESHOLD });
    expect(classifyTier(market, NOW)).toBe("active");
  });

  it("treats volume just below the threshold (and no imminent cutoff) as longTail", () => {
    const market = makeMarket({ volume24h: DEFAULT_VOLUME_THRESHOLD - 1 });
    expect(classifyTier(market, NOW)).toBe("longTail");
  });

  it("treats a cutoff exactly at the window edge as active (boundary)", () => {
    const edge = new Date(NOW.getTime() + DEFAULT_ACTIVE_WINDOW_MS).toISOString();
    const market = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: edge }),
    });
    expect(classifyTier(market, NOW)).toBe("active");
  });

  it("treats a cutoff just beyond the window as longTail", () => {
    const beyond = new Date(NOW.getTime() + DEFAULT_ACTIVE_WINDOW_MS + 1000).toISOString();
    const market = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: beyond }),
    });
    expect(classifyTier(market, NOW)).toBe("longTail");
  });

  it("treats a cutoff already in the past as longTail (event ended)", () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    const market = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: past }),
    });
    expect(classifyTier(market, NOW)).toBe("longTail");
  });

  it("classifies closed and resolved markets as longTail regardless of volume/cutoff", () => {
    const imminent = new Date(NOW.getTime() + 60 * 1000).toISOString();
    const base = {
      volume24h: DEFAULT_VOLUME_THRESHOLD * 100,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: imminent }),
    };
    expect(classifyTier(makeMarket({ ...base, status: "closed" }), NOW)).toBe("longTail");
    expect(classifyTier(makeMarket({ ...base, status: "resolved" }), NOW)).toBe("longTail");
  });

  it("treats a null/unparseable cutoff with low volume as longTail", () => {
    const nullCutoff = makeMarket({ volume24h: 0 });
    expect(classifyTier(nullCutoff, NOW)).toBe("longTail");

    const badCutoff = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: "not-a-date" }),
    });
    expect(classifyTier(badCutoff, NOW)).toBe("longTail");
  });

  it("treats a null volume24h as not-busy", () => {
    const market = makeMarket({ volume24h: null });
    expect(classifyTier(market, NOW)).toBe("longTail");
  });

  it("respects custom thresholds via options", () => {
    // Lower the volume threshold so a small volume becomes active.
    const lowVol = makeMarket({ volume24h: 5 });
    expect(classifyTier(lowVol, NOW, { volumeThreshold: 5 })).toBe("active");

    // Widen the active window so a far-off cutoff becomes imminent.
    const farCutoff = new Date(NOW.getTime() + 48 * 60 * 60 * 1000).toISOString();
    const market = makeMarket({
      volume24h: 0,
      resolutionCriteria: makeResolutionCriteria({ cutoffTime: farCutoff }),
    });
    expect(classifyTier(market, NOW, { activeWindowMs: 72 * 60 * 60 * 1000 })).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// onTick
// ---------------------------------------------------------------------------

describe("onTick", () => {
  it("performs all three side effects with correctly mapped values", async () => {
    const deps = makeDeps();
    const tick = makeTick({
      marketExternalId: "ext-42",
      outcomeLabel: "No",
      price: 0.37,
      volume: 2500,
      ts: "2024-06-01T13:00:00.000Z",
    });

    const result = await onTick(tick, deps);

    // (a) hot cache, keyed by external id, with volume + ts.
    expect(deps.hotPriceCache.writes).toEqual([
      {
        marketId: "ext-42",
        outcomeLabel: "No",
        price: 0.37,
        options: { volume: 2500, ts: "2024-06-01T13:00:00.000Z" },
      },
    ]);

    // (b) idempotent price write, keyed by RESOLVED internal ids.
    expect(deps.pricePointRepo.points).toEqual([
      {
        marketId: "mid-ext-42",
        outcomeId: "oid-No",
        ts: "2024-06-01T13:00:00.000Z",
        price: 0.37,
        volume: 2500,
      },
    ]);

    // (c) fan-out publish, keyed by external id, full payload.
    expect(deps.fanoutPublisher.published).toEqual([
      {
        marketId: "ext-42",
        payload: {
          marketId: "ext-42",
          outcomeLabel: "No",
          price: 0.37,
          volume: 2500,
          ts: "2024-06-01T13:00:00.000Z",
        },
      },
    ]);

    // lastSeenTs advanced to the tick ts; row was persisted.
    expect(result).toEqual({ lastSeenTs: "2024-06-01T13:00:00.000Z", persisted: true });
  });

  it("skips the DB write when resolveIds returns null but still caches and publishes", async () => {
    const deps = makeDeps({
      resolveIds: makeResolver({ "unknown\u0000Yes": null }),
    });
    const tick = makeTick({ marketExternalId: "unknown", outcomeLabel: "Yes" });

    const result = await onTick(tick, deps);

    // No price-point row written.
    expect(deps.pricePointRepo.points).toHaveLength(0);
    expect(result.persisted).toBe(false);

    // Hot cache + fan-out still ran (they only need the external id).
    expect(deps.hotPriceCache.writes).toHaveLength(1);
    expect(deps.fanoutPublisher.published).toHaveLength(1);
    expect(result.lastSeenTs).toBe(tick.ts);
  });

  it("supports an async resolveIds", async () => {
    const deps = makeDeps({
      resolveIds: (ext, label) =>
        Promise.resolve({ marketId: `mid-${ext}`, outcomeId: `oid-${label}` }),
    });
    const tick = makeTick();

    const result = await onTick(tick, deps);

    expect(result.persisted).toBe(true);
    expect(deps.pricePointRepo.points[0]).toMatchObject({
      marketId: "mid-ext-1",
      outcomeId: "oid-Yes",
    });
  });

  it("forwards a null volume through every side effect", async () => {
    const deps = makeDeps();
    const tick = makeTick({ volume: null });

    await onTick(tick, deps);

    expect(deps.hotPriceCache.writes[0]?.options?.volume).toBeNull();
    expect(deps.pricePointRepo.points[0]?.volume).toBeNull();
    expect(deps.fanoutPublisher.published[0]?.payload.volume).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startPriceStream — transport routing via the capability gate
// ---------------------------------------------------------------------------

describe("startPriceStream", () => {
  it("routes a WebSocket-capable source to subscribePrices and runs ticks through onTick", async () => {
    const { source, subscribeSpy, fetchSnapshotSpy, emit, subscription } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
    });
    const deps = makeDeps();

    const handle = startPriceStream(source, ["ext-1"], deps);

    expect(handle.mode).toBe("websocket");
    expect(handle.subscription).toBe(subscription);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(["ext-1"], expect.any(Function));
    expect(fetchSnapshotSpy).not.toHaveBeenCalled();

    // Emitting a tick drives the full onTick pipeline.
    emit(makeTick({ ts: "2024-06-01T14:00:00.000Z" }));
    await vi.waitFor(() => {
      expect(deps.pricePointRepo.points).toHaveLength(1);
    });
    expect(deps.hotPriceCache.writes).toHaveLength(1);
    expect(deps.fanoutPublisher.published).toHaveLength(1);
    expect(handle.lastSeenTs()).toBe("2024-06-01T14:00:00.000Z");

    handle.stop();
    expect(subscription.close).toHaveBeenCalledTimes(1);
  });

  it("routes a non-WebSocket source to polling and runs each snapshot through onTick", async () => {
    const snapshots = [
      makeTick({ marketExternalId: "ext-1", outcomeLabel: "Yes", price: 0.6 }),
      makeTick({ marketExternalId: "ext-2", outcomeLabel: "No", price: 0.4 }),
    ];
    const { source, subscribeSpy, fetchSnapshotSpy } = makeFakeSource({
      websocketPrices: false,
      hasSubscribe: false,
      snapshots,
    });

    // Capture the poll action and invoke it once deterministically.
    let captured: (() => Promise<void>) | null = null;
    const schedulePolling: SchedulePolling = (poll) => {
      captured = poll;
      return () => undefined;
    };
    const deps = makeDeps({ schedulePolling });

    const handle = startPriceStream(source, ["ext-1", "ext-2"], deps);

    expect(handle.mode).toBe("polling");
    expect(handle.subscription).toBeUndefined();
    expect(subscribeSpy).not.toHaveBeenCalled();

    // Drive one poll pass.
    expect(captured).not.toBeNull();
    await captured!();

    expect(fetchSnapshotSpy).toHaveBeenCalledWith(["ext-1", "ext-2"]);
    expect(deps.hotPriceCache.writes).toHaveLength(2);
    expect(deps.pricePointRepo.points).toHaveLength(2);
    expect(deps.fanoutPublisher.published).toHaveLength(2);
    expect(handle.lastSeenTs()).toBe(snapshots[1]!.ts);
  });

  it("falls back to polling when websocketPrices is true but subscribePrices is absent", () => {
    const { source, fetchSnapshotSpy } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: false, // misconfigured adapter
    });
    let scheduled = false;
    const deps = makeDeps({
      schedulePolling: () => {
        scheduled = true;
        return () => undefined;
      },
    });

    const handle = startPriceStream(source, ["ext-1"], deps);

    expect(handle.mode).toBe("polling");
    expect(scheduled).toBe(true);
    expect(fetchSnapshotSpy).not.toHaveBeenCalled(); // not until the poll fires
  });

  it("routes async tick errors on the WebSocket path to onError", async () => {
    const { source, emit } = makeFakeSource({
      websocketPrices: true,
      hasSubscribe: true,
    });
    const failing = new FakePricePointRepo();
    vi.spyOn(failing, "writePricePoint").mockRejectedValue(new Error("db down"));
    const onError = vi.fn();
    const deps = makeDeps({ pricePointRepo: failing, onError });

    startPriceStream(source, ["ext-1"], deps);
    emit(makeTick());

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/db down/);
  });

  it("stop() halts the poll loop on the polling path", () => {
    const { source } = makeFakeSource({
      websocketPrices: false,
      hasSubscribe: false,
    });
    const stopPolling = vi.fn();
    const deps = makeDeps({
      schedulePolling: () => stopPolling,
    });

    const handle = startPriceStream(source, ["ext-1"], deps);
    handle.stop();

    expect(stopPolling).toHaveBeenCalledTimes(1);
  });
});
