import { describe, it, expect, vi } from "vitest";
import type {
  Market,
  MarketRepository,
  MarketSource,
  MarketUpsert,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPricePoint,
  NormalizedPriceSnapshot,
  Page,
  PageRequest,
  PricePoint,
  PriceTickHandler,
  SourceCapabilities,
  SourceMeta,
  Subscription,
  TimeRange,
} from "@pma/core";
import type { PricePayload } from "@pma/storage";
import { syncMarkets } from "./sync-markets.js";
import {
  createFetchWrapper,
  HttpError,
  MaxRetriesExceeded,
  TokenBucketRateLimiter,
  type RateLimiter,
} from "./with-retry.js";
import { startResilientPriceStream } from "./resilient-price-stream.js";
import type { ResilientStreamDeps, ScheduleHealthCheck } from "./resilient-price-stream.js";
import type {
  HotPriceWriter,
  PricePointWriter,
  PricePublisher,
  ResolvedIds,
} from "./price-stream.js";

/**
 * Integration test: resilience of the ingestion pipeline against a scripted
 * "mock adapter server" (task 5.6 / Requirements 7.5, 7.6, 4.4).
 *
 * Rather than poke individual units in isolation, this test wires the *real*
 * ingestion components together — `createFetchWrapper` (token-bucket rate
 * limiter + jittered exponential backoff) → `syncMarkets`, and
 * `startResilientPriceStream` (reconnect-with-backfill) — against a single
 * in-memory upstream that can be told to misbehave on cue:
 *
 *   1. METADATA RESILIENCE (Req 7.5): the server injects 429s/5xx on some page
 *      fetch attempts before serving the recorded page. We assert the failures
 *      are retried with backoff (the injected `sleep` records the schedule),
 *      the sync still ingests every recorded market, and a non-retryable 400
 *      propagates without advancing the cursor.
 *   2. CRASH-SAFE RESUME (Req 7.5 / 7.3): the server EXHAUSTS retries on a later
 *      page so `syncMarkets` aborts; we assert the persisted cursor did not move
 *      past the last durably-written page, then run `syncMarkets` AGAIN (the
 *      server is now healthy because its scripted faults are spent) and assert
 *      it resumes from the persisted cursor and completes with no duplicate rows
 *      and no backward reprocessing.
 *   3. WS RECONNECT-BACKFILL (Req 7.6 / 4.4): the server's WebSocket drops
 *      (subscription `isOpen → false`) after a live tick; we assert the stream
 *      backs off (sleeps), re-subscribes, and backfills the missed interval via
 *      the server's recorded `fetchPriceHistory` so the persisted price series
 *      is continuous (no holes) and idempotent (an overlapping point does not
 *      duplicate).
 *
 * Everything is deterministic and timer-/network-/socket-free: the clock,
 * `sleep`, jitter, the health-check scheduler, and the rate limiter's clock are
 * all injected, and the repo / hot-cache / fan-out / price-point repo are
 * in-memory fakes.
 */

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";
const SOURCE_KEY = "mock";

// Stream timeline (ISO 8601).
const T_OPEN = "2024-06-01T00:00:00.000Z";
const T_LIVE_1 = "2024-06-01T00:01:00.000Z";
const T_GAP_2 = "2024-06-01T00:02:00.000Z";
const T_GAP_3 = "2024-06-01T00:03:00.000Z";
const T_DROP_NOW = "2024-06-01T00:03:30.000Z";
const T_LIVE_4 = "2024-06-01T00:04:00.000Z";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Build a binary {@link NormalizedMarket} with sensible defaults. */
function makeMarket(
  externalId: string,
  overrides: Partial<NormalizedMarket> = {},
): NormalizedMarket {
  return {
    externalId,
    eventExternalId: null,
    question: `Question ${externalId}?`,
    status: "open",
    volume24h: 1000,
    liquidity: 500,
    spread: 0.02,
    outcomes: [
      { label: "Yes", tokenId: null, impliedProb: 0.6, lastPrice: 0.6 },
      { label: "No", tokenId: null, impliedProb: 0.4, lastPrice: 0.4 },
    ],
    resolutionCriteria: {
      dataSource: null,
      cutoffTime: null,
      rounding: null,
      raw: {},
    },
    ...overrides,
  };
}

/** Build a normalized price point/snapshot. */
function makePoint(overrides: Partial<NormalizedPricePoint> = {}): NormalizedPricePoint {
  return {
    marketExternalId: "ext-1",
    outcomeLabel: "Yes",
    price: 0.6,
    volume: 1000,
    ts: T_LIVE_1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock adapter server — a scripted, in-memory upstream
// ---------------------------------------------------------------------------

/** A transient fault the server can inject on a given fetch attempt. */
type InjectedFault = { kind: "http"; status: number } | { kind: "network"; message?: string };

/** A recorded metadata page keyed by the request cursor that returns it. */
interface RecordedPage {
  /** The request cursor that returns this page (`null` = start of the window). */
  requestCursor: string | null;
  items: NormalizedMarket[];
  nextCursor: string | null;
}

/** A test subscription whose `isOpen` flag is mutable so drops can be simulated. */
class MockSubscription implements Subscription {
  isOpen = true;
  readonly close = vi.fn(() => {
    this.isOpen = false;
  });
}

const START_KEY = "__START__";
function cursorKey(cursor: string | null | undefined): string {
  return cursor === undefined || cursor === null ? START_KEY : cursor;
}

function toThrowable(fault: InjectedFault): unknown {
  return fault.kind === "http"
    ? new HttpError(fault.status, `HTTP ${fault.status}`)
    : new Error(fault.message ?? "network error");
}

interface MockServerOptions {
  /** Recorded metadata pages, in fetch order. */
  pages?: RecordedPage[];
  /**
   * Faults to inject per page (keyed by request cursor; `null` → start). The
   * faults are consumed one-per-fetch-attempt: once spent, the page is served
   * normally — modeling an upstream that recovers / "heals".
   */
  metadataFaults?: Array<{ requestCursor: string | null; faults: InjectedFault[] }>;
  /** Recorded price history returned by `fetchPriceHistory(id, range)`. */
  priceHistory?: Record<string, NormalizedPricePoint[]>;
  /** Whether the source declares (and implements) WebSocket prices. */
  websocketPrices?: boolean;
}

/**
 * A scripted, in-memory upstream that fronts BOTH the metadata sync path
 * (`fetchMarkets`, with injectable transient faults that THROW so
 * `withRetry`/`createFetchWrapper` backoff actually engages) AND the price
 * stream path (`subscribePrices` returning a controllable subscription +
 * recorded `fetchPriceHistory` for backfill). Exposed to the pipeline as a real
 * {@link MarketSource}.
 */
class MockAdapterServer {
  private readonly pages = new Map<string, RecordedPage>();
  private readonly faults = new Map<string, InjectedFault[]>();
  private readonly attempts = new Map<string, number>();
  private readonly priceHistory: Map<string, NormalizedPricePoint[]>;
  private readonly websocketPrices: boolean;

  /** The request cursor of every `fetchMarkets` call, in order. */
  readonly fetchMarketsCursors: Array<string | undefined> = [];
  /** Every `fetchPriceHistory` call, in order. */
  readonly fetchHistoryCalls: Array<{ id: string; range: TimeRange }> = [];
  /** Every subscription handed out (latest is the live one). */
  readonly subscriptions: MockSubscription[] = [];
  subscribeCount = 0;

  private liveHandler: PriceTickHandler | null = null;

  constructor(options: MockServerOptions = {}) {
    for (const page of options.pages ?? []) {
      this.pages.set(cursorKey(page.requestCursor), page);
    }
    for (const entry of options.metadataFaults ?? []) {
      this.faults.set(cursorKey(entry.requestCursor), [...entry.faults]);
    }
    this.priceHistory = new Map(Object.entries(options.priceHistory ?? {}));
    this.websocketPrices = options.websocketPrices ?? false;
  }

  /** Expose the server as a {@link MarketSource} the pipeline consumes. */
  asMarketSource(): MarketSource {
    const meta: SourceMeta = {
      id: SOURCE_ID,
      key: SOURCE_KEY,
      name: "Mock Source",
      type: "onchain",
      baseCurrency: "USDC",
    };
    const capabilities: SourceCapabilities = {
      websocketPrices: this.websocketPrices,
      priceHistory: true,
      orderBookDepth: false,
      keysetPagination: true,
    };

    const source: MarketSource = {
      meta,
      fetchEvents: (): Promise<Page<NormalizedEvent>> =>
        Promise.resolve({ items: [], nextCursor: null }),
      fetchMarkets: (opts: PageRequest) => this.fetchMarkets(opts),
      fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
      fetchPriceHistory: (id: string, range: TimeRange) => this.fetchPriceHistory(id, range),
      capabilities: () => capabilities,
    };

    if (this.websocketPrices) {
      source.subscribePrices = (ids: string[], handler: PriceTickHandler) =>
        this.subscribePrices(ids, handler);
    }

    return source;
  }

  // --- metadata path -------------------------------------------------------

  private fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>> {
    this.fetchMarketsCursors.push(opts.cursor);
    const key = cursorKey(opts.cursor);

    // Inject a scripted fault for this attempt (if any remain unspent).
    const faults = this.faults.get(key);
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    if (faults && attempt < faults.length) {
      return Promise.reject(toThrowable(faults[attempt]!));
    }

    const page = this.pages.get(key);
    if (page === undefined) {
      return Promise.reject(new Error(`mock server: no recorded page for cursor "${key}"`));
    }
    return Promise.resolve({ items: page.items, nextCursor: page.nextCursor });
  }

  // --- price path ----------------------------------------------------------

  private subscribePrices(_ids: string[], handler: PriceTickHandler): Subscription {
    this.subscribeCount += 1;
    this.liveHandler = handler;
    const sub = new MockSubscription();
    this.subscriptions.push(sub);
    return sub;
  }

  private fetchPriceHistory(id: string, range: TimeRange): Promise<NormalizedPricePoint[]> {
    this.fetchHistoryCalls.push({ id, range });
    return Promise.resolve(this.priceHistory.get(id) ?? []);
  }

  /** Push a live tick through the captured stream handler. */
  emitTick(tick: NormalizedPriceSnapshot): void {
    if (this.liveHandler === null) {
      throw new Error("mock server: no subscriber to emit to");
    }
    this.liveHandler(tick);
  }

  /** Simulate the live WebSocket dropping. */
  dropConnection(): void {
    const current = this.subscriptions[this.subscriptions.length - 1];
    if (current === undefined) throw new Error("mock server: no live subscription");
    current.isOpen = false;
  }
}

// ---------------------------------------------------------------------------
// In-memory fakes (repo / hot cache / fan-out / price-point repo)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link MarketRepository} keyed by `(sourceId, externalId)` so
 * re-upserting the same market replaces (never duplicates) the row — modeling
 * the `ON CONFLICT DO UPDATE` idempotency.
 */
class FakeMarketRepository implements MarketRepository {
  readonly markets = new Map<string, Market>();
  readonly savedCursors: Array<string | null> = [];
  cursor: string | null = null;
  private idSeq = 0;

  constructor(initialCursor: string | null = null) {
    this.cursor = initialCursor;
  }

  loadCursor(): Promise<string | null> {
    return Promise.resolve(this.cursor);
  }
  saveCursor(_sourceId: string, cursor: string | null): Promise<void> {
    this.cursor = cursor;
    this.savedCursors.push(cursor);
    return Promise.resolve();
  }
  upsertMarket(market: MarketUpsert): Promise<Market> {
    const key = `${market.sourceId}\u0000${market.externalId}`;
    const existing = this.markets.get(key);
    const id = existing ? existing.id : `m-${this.idSeq++}`;
    const persisted: Market = { ...market, id };
    this.markets.set(key, persisted);
    return Promise.resolve(persisted);
  }
  findByExternalId(sourceId: string, externalId: string): Promise<Market | null> {
    return Promise.resolve(this.markets.get(`${sourceId}\u0000${externalId}`) ?? null);
  }
  getById(id: string): Promise<Market | null> {
    for (const m of this.markets.values()) {
      if (m.id === id) return Promise.resolve(m);
    }
    return Promise.resolve(null);
  }

  externalIds(): string[] {
    return [...this.markets.values()].map((m) => m.externalId).sort();
  }
}

class FakeHotPriceCache implements HotPriceWriter {
  readonly writes: Array<{ marketId: string; outcomeLabel: string; price: number }> = [];
  setHotPrice(marketId: string, outcomeLabel: string, price: number): Promise<void> {
    this.writes.push({ marketId, outcomeLabel, price });
    return Promise.resolve();
  }
}

/**
 * In-memory {@link PricePointWriter} that is idempotent on
 * `(marketId, outcomeId, ts)` — exactly the real hypertable key — so an
 * overlapping backfill point collapses onto the live one. `allWrites` records
 * every call (including overlaps) so a test can prove dedup actually happened.
 */
class FakePricePointRepo implements PricePointWriter {
  readonly allWrites: PricePoint[] = [];
  private readonly rows = new Map<string, PricePoint>();

  writePricePoint(point: PricePoint): Promise<void> {
    this.allWrites.push(point);
    this.rows.set(`${point.marketId}\u0000${point.outcomeId}\u0000${point.ts}`, point);
    return Promise.resolve();
  }

  /** Unique rows sorted by timestamp — the persisted price series. */
  series(): PricePoint[] {
    return [...this.rows.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  }
}

class FakeFanoutPublisher implements PricePublisher {
  readonly published: Array<{ marketId: string; payload: PricePayload }> = [];
  publishPrice(marketId: string, payload: PricePayload): Promise<number> {
    this.published.push({ marketId, payload });
    return Promise.resolve(1);
  }
}

/** Deterministic external→internal id resolver. */
const resolveIds = (marketExternalId: string, outcomeLabel: string): ResolvedIds => ({
  marketId: `mid-${marketExternalId}`,
  outcomeId: `oid-${outcomeLabel}`,
});

// ---------------------------------------------------------------------------
// Scenario 1 — metadata resilience (Req 7.5)
// ---------------------------------------------------------------------------

describe("ingestion resilience — metadata sync over a flaky mock server", () => {
  it("retries injected 429/5xx with backoff and still ingests every recorded market", async () => {
    const server = new MockAdapterServer({
      pages: [
        {
          requestCursor: null,
          items: [makeMarket("a"), makeMarket("b")],
          nextCursor: "c1",
        },
        { requestCursor: "c1", items: [makeMarket("c")], nextCursor: null },
      ],
      metadataFaults: [
        // Start page: one 429 then succeed.
        { requestCursor: null, faults: [{ kind: "http", status: 429 }] },
        // Page c1: two 5xx then succeed.
        {
          requestCursor: "c1",
          faults: [
            { kind: "http", status: 503 },
            { kind: "http", status: 500 },
          ],
        },
      ],
    });
    const source = server.asMarketSource();
    const repo = new FakeMarketRepository();

    // Rate limiter with its own (no-op) clock + headroom so it never throttles;
    // the only recorded sleeps are the retry backoffs.
    const limiter = new TokenBucketRateLimiter({
      capacity: 100,
      refillPerSecond: 100,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    const acquireCalls: string[] = [];
    const spyLimiter: RateLimiter = {
      acquire: (key) => {
        acquireCalls.push(key);
        return limiter.acquire(key);
      },
    };

    const backoffSleeps: number[] = [];
    const fetchWrapper = createFetchWrapper({
      sourceKey: source.meta.key,
      rateLimiter: spyLimiter,
      baseDelayMs: 100,
      maxDelayMs: 100_000,
      jitter: () => 0,
      sleep: (ms) => {
        backoffSleeps.push(ms);
        return Promise.resolve();
      },
    });

    const result = await syncMarkets(source, repo, { fetchWrapper });

    // Every recorded market ingested across the two pages.
    expect(result.processed).toBe(3);
    expect(repo.externalIds()).toEqual(["a", "b", "c"]);
    expect(repo.cursor).toBeNull(); // terminal page reached

    // Backoff engaged: 1 retry on the start page (100ms) + 2 retries on c1
    // (100ms, 200ms) = the jittered-exponential schedule.
    expect(backoffSleeps).toEqual([100, 100, 200]);

    // Rate limiting was applied before every attempt (3 fetch attempts on the
    // start page+c1 boundary: start = 2 attempts, c1 = 3 attempts = 5 total).
    expect(acquireCalls.length).toBe(5);
    for (const key of acquireCalls) expect(key).toBe(SOURCE_KEY);

    // The cursor only advanced after each page was durably written.
    expect(repo.savedCursors).toEqual(["c1", null]);
  });

  it("propagates a non-retryable 400 without advancing the cursor", async () => {
    // The repo resumes from "prior-cursor", so the page+fault are keyed there
    // (that is the cursor `syncMarkets` will actually request).
    const server = new MockAdapterServer({
      pages: [{ requestCursor: "prior-cursor", items: [makeMarket("a")], nextCursor: null }],
      metadataFaults: [{ requestCursor: "prior-cursor", faults: [{ kind: "http", status: 400 }] }],
    });
    const source = server.asMarketSource();
    const repo = new FakeMarketRepository("prior-cursor");

    const backoffSleeps: number[] = [];
    const fetchWrapper = createFetchWrapper({
      sourceKey: source.meta.key,
      jitter: () => 0,
      sleep: (ms) => {
        backoffSleeps.push(ms);
        return Promise.resolve();
      },
    });

    await expect(syncMarkets(source, repo, { fetchWrapper })).rejects.toBeInstanceOf(HttpError);

    // A 4xx (other than 429) is not retried and never slept on.
    expect(backoffSleeps).toEqual([]);
    // Requirement 7.5: the cursor is untouched on failure.
    expect(repo.cursor).toBe("prior-cursor");
    expect(repo.savedCursors).toEqual([]);
    expect(repo.markets.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — crash-safe cursor resume (Req 7.5 / 7.3)
// ---------------------------------------------------------------------------

describe("ingestion resilience — crash-safe cursor resume after exhausted retries", () => {
  it("aborts without advancing the cursor, then resumes from it and completes without duplicates", async () => {
    // 3 pages. The LAST page (requested with cursor "c2") fails with a network
    // error on every attempt enough times to exhaust retries on the first run.
    const MAX_ATTEMPTS = 3;
    const server = new MockAdapterServer({
      pages: [
        {
          requestCursor: null,
          items: [makeMarket("a"), makeMarket("b")],
          nextCursor: "c1",
        },
        { requestCursor: "c1", items: [makeMarket("c")], nextCursor: "c2" },
        { requestCursor: "c2", items: [makeMarket("d")], nextCursor: null },
      ],
      metadataFaults: [
        {
          requestCursor: "c2",
          // Exactly MAX_ATTEMPTS faults → run 1 exhausts retries here; they are
          // then spent, so run 2 serves the page cleanly ("healed").
          faults: Array.from({ length: MAX_ATTEMPTS }, () => ({
            kind: "network" as const,
            message: "ECONNRESET",
          })),
        },
      ],
    });
    const source = server.asMarketSource();
    const repo = new FakeMarketRepository();

    const makeWrapper = () =>
      createFetchWrapper({
        sourceKey: source.meta.key,
        maxAttempts: MAX_ATTEMPTS,
        jitter: () => 0,
        sleep: () => Promise.resolve(),
      });

    // --- Run 1: crashes on page c2 after exhausting retries. ---------------
    await expect(syncMarkets(source, repo, { fetchWrapper: makeWrapper() })).rejects.toBeInstanceOf(
      MaxRetriesExceeded,
    );

    // Cursor advanced only as far as the last durably-written page (c1 → "c2"),
    // never past the failed page (Req 7.3: no temporary advancement/rollback).
    expect(repo.cursor).toBe("c2");
    expect(repo.savedCursors).toEqual(["c1", "c2"]);
    // Page d (behind the failing fetch) was never ingested.
    expect(repo.externalIds()).toEqual(["a", "b", "c"]);

    const fetchCursorsRun1 = [...server.fetchMarketsCursors];

    // --- Run 2: server healed; resume from the persisted cursor. -----------
    const result = await syncMarkets(source, repo, { fetchWrapper: makeWrapper() });

    // Resumed at the persisted cursor "c2" — did NOT restart from the window
    // start, so earlier pages are not reprocessed backward.
    const fetchCursorsRun2 = server.fetchMarketsCursors.slice(fetchCursorsRun1.length);
    expect(fetchCursorsRun2[0]).toBe("c2");
    expect(fetchCursorsRun2).not.toContain(undefined); // never re-fetched the start page

    // All four markets now present, exactly once each (idempotent upsert).
    expect(result.processed).toBe(1); // run 2 only wrote the final page
    expect(repo.externalIds()).toEqual(["a", "b", "c", "d"]);
    expect(repo.markets.size).toBe(4);
    expect(repo.cursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — WS reconnect + gap backfill (Req 7.6 / 4.4)
// ---------------------------------------------------------------------------

interface ResilientCtx {
  deps: ResilientStreamDeps;
  pricePointRepo: FakePricePointRepo;
  sleeps: number[];
  triggerHealthCheck: () => void;
  setNow: (ts: string) => void;
}

function makeResilientCtx(): ResilientCtx {
  const pricePointRepo = new FakePricePointRepo();
  const sleeps: number[] = [];
  let nowValue = T_OPEN;
  let healthCheck: (() => void) | null = null;

  const scheduleHealthCheck: ScheduleHealthCheck = (check) => {
    healthCheck = check;
    return () => undefined;
  };

  const deps: ResilientStreamDeps = {
    hotPriceCache: new FakeHotPriceCache(),
    pricePointRepo,
    fanoutPublisher: new FakeFanoutPublisher(),
    resolveIds,
    schedulePolling: (poll) => {
      void poll();
      return () => undefined;
    },
    now: () => nowValue,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    scheduleHealthCheck,
    reconnect: { baseDelayMs: 100, jitter: () => 0 },
  };

  return {
    deps,
    pricePointRepo,
    sleeps,
    triggerHealthCheck: () => {
      if (healthCheck === null) throw new Error("scheduleHealthCheck not called");
      healthCheck();
    },
    setNow: (ts) => {
      nowValue = ts;
    },
  };
}

describe("ingestion resilience — WebSocket drop → reconnect-with-backfill", () => {
  it("backs off, re-subscribes, and backfills the gap so the series is continuous and idempotent", async () => {
    // The server's recorded history for the gap. Note it OVERLAPS the live tick
    // at T_LIVE_1 (the reconnect backfills [lastSeen, now], inclusive), which
    // must dedupe rather than duplicate (Req 7.2 / 4.4).
    const server = new MockAdapterServer({
      websocketPrices: true,
      priceHistory: {
        "ext-1": [
          makePoint({ ts: T_LIVE_1, price: 0.6 }), // overlap with the live tick
          makePoint({ ts: T_GAP_2, price: 0.62 }),
          makePoint({ ts: T_GAP_3, price: 0.64 }),
        ],
      },
    });
    const source = server.asMarketSource();
    const ctx = makeResilientCtx();

    const handle = startResilientPriceStream(source, ["ext-1"], ctx.deps);
    expect(handle.mode).toBe("websocket");
    expect(server.subscribeCount).toBe(1);

    // A live tick arrives before the drop; lastSeen advances to T_LIVE_1.
    server.emitTick(makePoint({ ts: T_LIVE_1, price: 0.6 }));
    await vi.waitFor(() => {
      expect(handle.lastSeenTs()).toBe(T_LIVE_1);
    });

    // The socket drops; the clock has advanced to T_DROP_NOW.
    ctx.setNow(T_DROP_NOW);
    server.dropConnection();
    ctx.triggerHealthCheck();

    await vi.waitFor(() => {
      expect(handle.reconnectCount()).toBe(1);
    });

    // Backed off once (base 100ms, zero jitter) and re-subscribed.
    expect(ctx.sleeps).toEqual([100]);
    expect(server.subscribeCount).toBe(2);

    // Backfilled [lastSeen=T_LIVE_1, now=T_DROP_NOW] for the active id.
    expect(server.fetchHistoryCalls).toEqual([
      { id: "ext-1", range: { from: T_LIVE_1, to: T_DROP_NOW } },
    ]);

    // A post-reconnect live tick continues the series on the fresh socket.
    server.emitTick(makePoint({ ts: T_LIVE_4, price: 0.66 }));
    await vi.waitFor(() => {
      expect(handle.lastSeenTs()).toBe(T_LIVE_4);
    });

    // Continuity (Req 4.4): the persisted series has every point with no holes.
    const series = ctx.pricePointRepo.series();
    expect(series.map((p) => p.ts)).toEqual([T_LIVE_1, T_GAP_2, T_GAP_3, T_LIVE_4]);

    // Idempotency (Req 7.2): the overlapping T_LIVE_1 point was written twice
    // (once live, once via backfill) but collapses to a single row.
    expect(ctx.pricePointRepo.allWrites).toHaveLength(5); // 1 live + 3 backfill + 1 live
    expect(series).toHaveLength(4); // deduped
    const liveOneRows = series.filter((p) => p.ts === T_LIVE_1);
    expect(liveOneRows).toHaveLength(1);
  });
});
