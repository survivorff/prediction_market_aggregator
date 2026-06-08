import { describe, it, expect, vi } from "vitest";
import type {
  Market,
  MarketSource,
  NormalizedMarket,
  NormalizedPriceSnapshot,
  Page,
  PageRequest,
  SourceCapabilities,
  TimeRange,
} from "@pma/core";
import type { Queryable } from "@pma/storage";
import {
  loadActiveMarketSet,
  resolveSourceId,
  startSourcePriceStream,
  syncSourceMetadata,
  type ActiveMarketSet,
  type IngestionRunnerDeps,
} from "./runner.js";
import { TokenBucketRateLimiter } from "./with-retry.js";

/**
 * Unit tests for the ingestion runner orchestration with INJECTED fakes — no
 * real Postgres/Redis/network/timers. They verify: source-id resolution upserts
 * and returns the id; metadata sync drives `syncMarkets` through the resilient
 * fetch wrapper and persists markets + outcomes; the active-market set is
 * selected via `classifyTier` with a working external→internal id resolver; and
 * the price stream is wired to the `onTick` pipeline (or skipped when no active
 * markets).
 */

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type QueryHandler = (sql: string, params?: unknown[]) => { rows: unknown[] };

/** A fake {@link Queryable} that routes by a substring of the SQL text. */
function fakeDb(handler: QueryHandler): Queryable & { calls: Array<{ sql: string; params?: unknown[] }> } {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: <T>(sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve(handler(sql, params) as { rows: T[] });
    },
  } as Queryable & { calls: Array<{ sql: string; params?: unknown[] }> };
}

/** Records of every onTick side effect, so tests can assert price wiring. */
interface SinkRecords {
  hot: Array<{ marketId: string; label: string; price: number }>;
  points: Array<{ marketId: string; outcomeId: string; price: number }>;
  published: Array<{ marketId: string; price: number }>;
}

function makeSinks(): {
  records: SinkRecords;
  hotPriceCache: IngestionRunnerDeps["hotPriceCache"];
  pricePointRepo: IngestionRunnerDeps["pricePointRepo"];
  fanoutPublisher: IngestionRunnerDeps["fanoutPublisher"];
} {
  const records: SinkRecords = { hot: [], points: [], published: [] };
  return {
    records,
    hotPriceCache: {
      setHotPrice: (marketId, label, price) => {
        records.hot.push({ marketId, label, price });
        return Promise.resolve();
      },
    },
    pricePointRepo: {
      writePricePoint: (p) => {
        records.points.push({ marketId: p.marketId, outcomeId: p.outcomeId, price: p.price });
        return Promise.resolve();
      },
    },
    fanoutPublisher: {
      publishPrice: (marketId, payload) => {
        records.published.push({ marketId, price: payload.price });
        return Promise.resolve(1);
      },
    },
  };
}

/** Build runner deps over a fake db + sinks, with synchronous schedulers. */
function makeDeps(
  db: Queryable,
  overrides: Partial<IngestionRunnerDeps> = {},
): { deps: IngestionRunnerDeps; records: SinkRecords; runPoll: () => Promise<void> } {
  const sinks = makeSinks();
  let captured: (() => Promise<void>) | undefined;
  const deps: IngestionRunnerDeps = {
    db,
    // Minimal MarketRepository/OutcomeRepository stand-ins are not needed for
    // the tests that don't call syncMarkets; tests that do inject real-ish ones.
    marketRepo: overrides.marketRepo!,
    outcomeRepo: overrides.outcomeRepo!,
    pricePointRepo: sinks.pricePointRepo,
    hotPriceCache: sinks.hotPriceCache,
    fanoutPublisher: sinks.fanoutPublisher,
    rateLimiter: new TokenBucketRateLimiter({ capacity: 100, refillPerSecond: 100 }),
    schedulePolling: (poll) => {
      captured = poll;
      return () => undefined;
    },
    scheduleHealthCheck: () => () => undefined,
    sleep: () => Promise.resolve(),
    now: () => new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
  return {
    deps,
    records: sinks.records,
    runPoll: () => (captured ? captured() : Promise.resolve()),
  };
}

const CAPS_POLLING: SourceCapabilities = {
  websocketPrices: false,
  priceHistory: true,
  orderBookDepth: false,
  keysetPagination: true,
};

/** A minimal polling adapter whose snapshot returns one Yes tick per id. */
function pollingSource(key: string, id: string, snapshotPrice = 0.6): MarketSource {
  return {
    meta: { id, key, name: key, type: "onchain", baseCurrency: "USD" },
    capabilities: () => CAPS_POLLING,
    fetchEvents: (): Promise<Page<never>> => Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (_opts: PageRequest): Promise<Page<NormalizedMarket>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchPriceSnapshot: (ids: string[]): Promise<NormalizedPriceSnapshot[]> =>
      Promise.resolve(
        ids.map((marketExternalId) => ({
          marketExternalId,
          outcomeLabel: "Yes",
          price: snapshotPrice,
          volume: null,
          ts: "2025-01-01T00:00:00.000Z",
        })),
      ),
    fetchPriceHistory: (_id: string, _r: TimeRange) => Promise.resolve([]),
  };
}

// ---------------------------------------------------------------------------
// resolveSourceId
// ---------------------------------------------------------------------------

describe("resolveSourceId", () => {
  it("upserts the source row by key and returns its id", async () => {
    const db = fakeDb(() => ({ rows: [{ id: "src-123" }] }));
    const source = pollingSource("predictfun", "placeholder");
    const id = await resolveSourceId(db, source);
    expect(id).toBe("src-123");
    expect(db.calls[0]!.sql).toContain("INSERT INTO source");
    expect(db.calls[0]!.params).toEqual(["predictfun", "predictfun", "onchain", "USD"]);
  });
});

// ---------------------------------------------------------------------------
// syncSourceMetadata
// ---------------------------------------------------------------------------

describe("syncSourceMetadata", () => {
  it("persists markets + outcomes through syncMarkets and reports the result", async () => {
    const upsertMarket = vi.fn((m: { externalId: string }) =>
      Promise.resolve({ id: `mkt-${m.externalId}` } as Market),
    );
    const upsertOutcomes = vi.fn(() => Promise.resolve([]));
    const cursor: { value: string | null } = { value: null };

    const marketRepo = {
      loadCursor: () => Promise.resolve(cursor.value),
      saveCursor: (_id: string, c: string | null) => {
        cursor.value = c;
        return Promise.resolve();
      },
      upsertMarket,
    } as unknown as IngestionRunnerDeps["marketRepo"];
    const outcomeRepo = { upsertOutcomes } as unknown as IngestionRunnerDeps["outcomeRepo"];

    const source: MarketSource = {
      ...pollingSource("predictfun", "src-1"),
      fetchMarkets: (): Promise<Page<NormalizedMarket>> =>
        Promise.resolve({
          items: [
            {
              externalId: "472",
              eventExternalId: "btc-2025",
              question: "BTC > 100k?",
              status: "open",
              volume24h: 100,
              liquidity: 50,
              spread: 0.02,
              outcomes: [
                { label: "Yes", tokenId: "y", impliedProb: null, lastPrice: null },
                { label: "No", tokenId: "n", impliedProb: null, lastPrice: null },
              ],
              resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
            },
          ],
          nextCursor: null,
        }),
    };

    const { deps } = makeDeps(fakeDb(() => ({ rows: [] })), { marketRepo, outcomeRepo });
    const result = await syncSourceMetadata(source, deps);

    expect(result.processed).toBe(1);
    expect(upsertMarket).toHaveBeenCalledTimes(1);
    expect(upsertOutcomes).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// loadActiveMarketSet
// ---------------------------------------------------------------------------

describe("loadActiveMarketSet", () => {
  function marketRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "mkt-1",
      source_id: "src-1",
      event_id: null,
      canonical_event_id: null,
      external_id: "472",
      question: "Q",
      category: "crypto",
      status: "open",
      volume_24h: 50_000, // busy → active
      liquidity: 100,
      spread: 0.02,
      resolution_criteria: {},
      resolution_mismatch: false,
      updated_at: "2025-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("selects active (busy/open) markets and builds a working id resolver", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM market WHERE source_id")) {
        return {
          rows: [
            marketRow({ id: "mkt-1", external_id: "472", volume_24h: 50_000 }),
            // Low volume + no cutoff + open → long-tail (excluded).
            marketRow({ id: "mkt-2", external_id: "999", volume_24h: 1 }),
            // Resolved → long-tail (excluded).
            marketRow({ id: "mkt-3", external_id: "888", status: "resolved", volume_24h: 99_999 }),
          ],
        };
      }
      if (sql.includes("FROM outcome o")) {
        return {
          rows: [
            { market_id: "mkt-1", market_external_id: "472", label: "Yes", token_id: "t-yes", outcome_id: "o-yes" },
            { market_id: "mkt-1", market_external_id: "472", label: "No", token_id: "t-no", outcome_id: "o-no" },
          ],
        };
      }
      return { rows: [] };
    });
    const { deps } = makeDeps(db);
    const source = pollingSource("predictfun", "src-1");

    const active: ActiveMarketSet = await loadActiveMarketSet(source, deps);

    // Default strategy: stream by market external id.
    expect(active.activeIds).toEqual(["472"]);
    expect(await active.resolveIds("472", "Yes")).toEqual({ marketId: "mkt-1", outcomeId: "o-yes" });
    expect(await active.resolveIds("472", "No")).toEqual({ marketId: "mkt-1", outcomeId: "o-no" });
    // Unknown market/outcome → null (onTick then skips the durable write).
    expect(await active.resolveIds("nope", "Yes")).toBeNull();
  });

  it("streams by Yes token id under the yesTokenId strategy (Polymarket)", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM market WHERE source_id")) {
        return { rows: [marketRow({ id: "mkt-1", external_id: "gamma-1", volume_24h: 50_000 })] };
      }
      if (sql.includes("FROM outcome o")) {
        return {
          rows: [
            { market_id: "mkt-1", market_external_id: "gamma-1", label: "Yes", token_id: "tok-yes", outcome_id: "o-yes" },
            { market_id: "mkt-1", market_external_id: "gamma-1", label: "No", token_id: "tok-no", outcome_id: "o-no" },
          ],
        };
      }
      return { rows: [] };
    });
    const { deps } = makeDeps(db);
    const source = pollingSource("polymarket", "src-1");

    const active = await loadActiveMarketSet(source, deps, "yesTokenId");

    // Only the Yes token is streamed (it carries the implied probability).
    expect(active.activeIds).toEqual(["tok-yes"]);
    // The resolver is keyed by token id, matching the tick's marketExternalId.
    expect(await active.resolveIds("tok-yes", "Yes")).toEqual({ marketId: "mkt-1", outcomeId: "o-yes" });
    // The gamma market id is NOT a price id under this strategy.
    expect(await active.resolveIds("gamma-1", "Yes")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startSourcePriceStream
// ---------------------------------------------------------------------------

describe("startSourcePriceStream", () => {
  it("returns null when there are no active markets", () => {
    const { deps } = makeDeps(fakeDb(() => ({ rows: [] })));
    const handle = startSourcePriceStream(
      pollingSource("predictfun", "src-1"),
      { activeIds: [], resolveIds: () => null },
      deps,
    );
    expect(handle).toBeNull();
  });

  it("polls a non-WS source and runs each snapshot through the onTick pipeline", async () => {
    const { deps, records, runPoll } = makeDeps(fakeDb(() => ({ rows: [] })));
    const active: ActiveMarketSet = {
      activeIds: ["472"],
      resolveIds: (ext, label) =>
        ext === "472" && label === "Yes" ? { marketId: "mkt-1", outcomeId: "o-yes" } : null,
    };

    const handle = startSourcePriceStream(pollingSource("predictfun", "src-1", 0.6), active, deps);
    expect(handle).not.toBeNull();
    expect(handle!.mode).toBe("polling");

    // Drive one poll pass deterministically (captured by the fake scheduler).
    await runPoll();

    // onTick wrote to all three sinks for the resolved Yes tick.
    expect(records.hot).toEqual([{ marketId: "472", label: "Yes", price: 0.6 }]);
    expect(records.points).toEqual([{ marketId: "mkt-1", outcomeId: "o-yes", price: 0.6 }]);
    expect(records.published).toEqual([{ marketId: "472", price: 0.6 }]);
  });
});
