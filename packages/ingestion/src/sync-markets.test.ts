import { describe, it, expect, vi } from "vitest";
import type {
  Market,
  MarketRepository,
  MarketSource,
  MarketUpsert,
  NormalizedMarket,
  Outcome,
  OutcomeRepository,
  OutcomeUpsert,
  Page,
  PageRequest,
  SourceMeta,
  SourceCapabilities,
  NormalizedEvent,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
} from "@pma/core";
import { syncMarkets, normalizeAndValidate, DEFAULT_PAGE_SIZE } from "./sync-markets.js";

/**
 * Unit tests for `syncMarkets` (task 5.1 / Requirements 7.1, 7.3, 11.1).
 *
 * Everything is in-memory: a scripted fake {@link MarketSource} returns a
 * controlled multi-page sequence (with an optional failing page), and a fake
 * {@link MarketRepository} records upserts + cursor saves. No database, no
 * network. The tests verify:
 *   - idempotent upsert calls (re-running over the same state is a no-op);
 *   - the cursor is saved only AFTER a page's writes succeed;
 *   - the cursor is NOT advanced when a page write throws (prior cursor stays);
 *   - `enqueueForMatching` is invoked once per market;
 *   - termination when `nextCursor` is null.
 */

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Build a {@link NormalizedMarket} with sensible binary-outcome defaults. */
function makeNormalizedMarket(
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
    resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
    ...overrides,
  };
}

/**
 * A scripted fake source. `pages` is the sequence of pages returned by
 * successive `fetchMarkets` calls; an entry may be an `Error` to simulate a
 * fetch failure. Records the {@link PageRequest} of each call.
 */
function makeFakeSource(
  pages: Array<Page<NormalizedMarket> | Error>,
  metaOverrides: Partial<SourceMeta> = {},
): { source: MarketSource; calls: PageRequest[] } {
  const calls: PageRequest[] = [];
  let index = 0;

  const meta: SourceMeta = {
    id: SOURCE_ID,
    key: "fake",
    name: "Fake Source",
    type: "onchain",
    baseCurrency: "USDC",
    ...metaOverrides,
  };
  const capabilities: SourceCapabilities = {
    websocketPrices: false,
    priceHistory: true,
    orderBookDepth: false,
    keysetPagination: true,
  };

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (opts: PageRequest): Promise<Page<NormalizedMarket>> => {
      calls.push(opts);
      const next = pages[index];
      index += 1;
      if (next === undefined) {
        return Promise.reject(new Error("fetchMarkets called more times than scripted"));
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
    fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
    capabilities: () => capabilities,
  };

  return { source, calls };
}

/**
 * In-memory {@link MarketRepository}. Markets are keyed by
 * `(sourceId, externalId)` so re-upserting the same market replaces (does not
 * duplicate) the row — modeling the `ON CONFLICT DO UPDATE` idempotency. Cursor
 * saves are recorded in order so tests can assert the save sequence.
 *
 * `failUpsertFor` lets a test make a specific externalId throw on upsert to
 * exercise the "page write fails → cursor not advanced" invariant.
 */
class FakeMarketRepository implements MarketRepository {
  readonly markets = new Map<string, Market>();
  readonly upsertCalls: MarketUpsert[] = [];
  readonly savedCursors: Array<string | null> = [];
  cursor: string | null = null;
  private idSeq = 0;

  constructor(
    private readonly opts: { failUpsertFor?: string; initialCursor?: string | null } = {},
  ) {
    this.cursor = opts.initialCursor ?? null;
  }

  loadCursor(_sourceId: string): Promise<string | null> {
    return Promise.resolve(this.cursor);
  }

  saveCursor(_sourceId: string, cursor: string | null): Promise<void> {
    this.cursor = cursor;
    this.savedCursors.push(cursor);
    return Promise.resolve();
  }

  upsertMarket(market: MarketUpsert): Promise<Market> {
    this.upsertCalls.push(market);
    if (this.opts.failUpsertFor === market.externalId) {
      return Promise.reject(new Error(`upsert failed for ${market.externalId}`));
    }
    const key = `${market.sourceId}\u0000${market.externalId}`;
    const existing = this.markets.get(key);
    // Idempotent: keep the same id when the row already exists.
    const id = existing ? existing.id : `m-${this.idSeq++}`;
    const persisted: Market = { ...market, id };
    this.markets.set(key, persisted);
    return Promise.resolve(persisted);
  }

  findByExternalId(sourceId: string, externalId: string): Promise<Market | null> {
    return Promise.resolve(this.markets.get(`${sourceId}\u0000${externalId}`) ?? null);
  }

  getById(id: string): Promise<Market | null> {
    for (const m of this.markets.values()) if (m.id === id) return Promise.resolve(m);
    return Promise.resolve(null);
  }
}

/** In-memory {@link OutcomeRepository} recording upserted outcome rows. */
class FakeOutcomeRepository implements OutcomeRepository {
  readonly outcomes = new Map<string, Outcome>();
  readonly upsertBatches: OutcomeUpsert[][] = [];
  private idSeq = 0;

  upsertOutcome(outcome: OutcomeUpsert): Promise<Outcome> {
    const key = `${outcome.marketId}\u0000${outcome.label}`;
    const existing = this.outcomes.get(key);
    const id = existing ? existing.id : `o-${this.idSeq++}`;
    const persisted: Outcome = { ...outcome, id };
    this.outcomes.set(key, persisted);
    return Promise.resolve(persisted);
  }

  async upsertOutcomes(outcomes: readonly OutcomeUpsert[]): Promise<Outcome[]> {
    this.upsertBatches.push([...outcomes]);
    const out: Outcome[] = [];
    for (const o of outcomes) out.push(await this.upsertOutcome(o));
    return out;
  }

  listByMarket(marketId: string): Promise<Outcome[]> {
    return Promise.resolve([...this.outcomes.values()].filter((o) => o.marketId === marketId));
  }
}

// ---------------------------------------------------------------------------
// normalizeAndValidate
// ---------------------------------------------------------------------------

describe("normalizeAndValidate", () => {
  it("maps a NormalizedMarket to a MarketUpsert stamped with sourceId", () => {
    const raw = makeNormalizedMarket("ext-1");
    const { market } = normalizeAndValidate(raw, SOURCE_ID);

    expect(market.sourceId).toBe(SOURCE_ID);
    expect(market.externalId).toBe("ext-1");
    expect(market.question).toBe("Question ext-1?");
    expect(market.status).toBe("open");
    // canonicalEventId/eventId are resolved later (matching / event sync).
    expect(market.eventId).toBeNull();
    expect(market.canonicalEventId).toBeNull();
  });

  it("clamps a negative spread to 0 and preserves raw resolution criteria", () => {
    const raw = makeNormalizedMarket("ext-2", {
      spread: -0.5,
      resolutionCriteria: {
        dataSource: "CoinGecko",
        cutoffTime: null,
        rounding: null,
        raw: { note: "keep me" },
      },
    });
    const { market } = normalizeAndValidate(raw, SOURCE_ID);

    expect(market.spread).toBe(0);
    expect(market.resolutionCriteria.dataSource).toBe("CoinGecko");
    expect(market.resolutionCriteria.raw).toEqual({ note: "keep me" });
  });

  it("normalizes out-of-range probabilities into [0,1] and nulls missing ones", () => {
    const raw = makeNormalizedMarket("ext-3", {
      outcomes: [
        { label: "Yes", tokenId: null, impliedProb: 1.4, lastPrice: -0.2 },
        { label: "No", tokenId: null, impliedProb: null, lastPrice: null },
      ],
    });
    const { outcomes } = normalizeAndValidate(raw, SOURCE_ID);

    for (const o of outcomes) {
      if (o.impliedProb !== null) {
        expect(o.impliedProb).toBeGreaterThanOrEqual(0);
        expect(o.impliedProb).toBeLessThanOrEqual(1);
      }
      if (o.lastPrice !== null) {
        expect(o.lastPrice).toBeGreaterThanOrEqual(0);
        expect(o.lastPrice).toBeLessThanOrEqual(1);
      }
    }
    expect(outcomes[1]?.impliedProb).toBeNull();
    expect(outcomes[1]?.lastPrice).toBeNull();
  });

  it("rescales a binary market's probabilities to sum to ~1", () => {
    const raw = makeNormalizedMarket("ext-4", {
      outcomes: [
        { label: "Yes", tokenId: null, impliedProb: 0.7, lastPrice: 0.7 },
        { label: "No", tokenId: null, impliedProb: 0.7, lastPrice: 0.3 },
      ],
    });
    const { outcomes } = normalizeAndValidate(raw, SOURCE_ID);
    const sum = (outcomes[0]?.impliedProb ?? 0) + (outcomes[1]?.impliedProb ?? 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(0.01);
  });
});

// ---------------------------------------------------------------------------
// syncMarkets — happy path / pagination / termination
// ---------------------------------------------------------------------------

describe("syncMarkets", () => {
  it("paginates with keyset cursors and terminates when nextCursor is null", async () => {
    const { source, calls } = makeFakeSource([
      { items: [makeNormalizedMarket("a")], nextCursor: "c1" },
      { items: [makeNormalizedMarket("b")], nextCursor: "c2" },
      { items: [makeNormalizedMarket("c")], nextCursor: null },
    ]);
    const repo = new FakeMarketRepository();

    const result = await syncMarkets(source, repo);

    // Three pages fetched; cursor threaded through each request.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ cursor: undefined, limit: DEFAULT_PAGE_SIZE });
    expect(calls[1]).toMatchObject({ cursor: "c1" });
    expect(calls[2]).toMatchObject({ cursor: "c2" });

    // Cursors persisted in order, ending at null (end of stream).
    expect(repo.savedCursors).toEqual(["c1", "c2", null]);
    expect(repo.cursor).toBeNull();

    expect(result).toMatchObject({
      sourceKey: "fake",
      sourceId: SOURCE_ID,
      processed: 3,
      pages: 3,
    });
  });

  it("resumes from the persisted cursor on a fresh pass", async () => {
    const { source, calls } = makeFakeSource([
      { items: [makeNormalizedMarket("z")], nextCursor: null },
    ]);
    const repo = new FakeMarketRepository({ initialCursor: "resume-here" });

    await syncMarkets(source, repo);

    expect(calls[0]).toMatchObject({ cursor: "resume-here" });
  });

  it("forwards updatedSince for incremental sync when provided", async () => {
    const { source, calls } = makeFakeSource([{ items: [], nextCursor: null }]);
    const repo = new FakeMarketRepository();

    await syncMarkets(source, repo, { updatedSince: "2024-01-01T00:00:00Z" });

    expect(calls[0]).toMatchObject({ updatedSince: "2024-01-01T00:00:00Z" });
  });

  it("uses a custom page size when supplied", async () => {
    const { source, calls } = makeFakeSource([{ items: [], nextCursor: null }]);
    const repo = new FakeMarketRepository();

    await syncMarkets(source, repo, { pageSize: 25 });

    expect(calls[0]).toMatchObject({ limit: 25 });
  });

  it("upserts every market in the sync window", async () => {
    const { source } = makeFakeSource([
      {
        items: [makeNormalizedMarket("a"), makeNormalizedMarket("b")],
        nextCursor: null,
      },
    ]);
    const repo = new FakeMarketRepository();

    await syncMarkets(source, repo);

    expect(repo.upsertCalls.map((m) => m.externalId)).toEqual(["a", "b"]);
    expect(repo.markets.size).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Requirement 11.1 — enqueue for matching
  // -------------------------------------------------------------------------

  it("invokes enqueueForMatching once per market with the persisted market", async () => {
    const { source } = makeFakeSource([
      { items: [makeNormalizedMarket("a")], nextCursor: "c1" },
      { items: [makeNormalizedMarket("b"), makeNormalizedMarket("c")], nextCursor: null },
    ]);
    const repo = new FakeMarketRepository();
    const enqueueForMatching = vi.fn();

    await syncMarkets(source, repo, { enqueueForMatching });

    expect(enqueueForMatching).toHaveBeenCalledTimes(3);
    // Each call receives a persisted Market (resolved internal id).
    for (const call of enqueueForMatching.mock.calls) {
      const market = call[0] as Market;
      expect(typeof market.id).toBe("string");
      expect(market.id.length).toBeGreaterThan(0);
    }
    expect(enqueueForMatching.mock.calls.map((c) => (c[0] as Market).externalId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("awaits an async enqueueForMatching before advancing the cursor", async () => {
    const order: string[] = [];
    const { source } = makeFakeSource([{ items: [makeNormalizedMarket("a")], nextCursor: null }]);
    const repo = new FakeMarketRepository();
    const saveCursorSpy = vi.spyOn(repo, "saveCursor");

    await syncMarkets(source, repo, {
      enqueueForMatching: async () => {
        await Promise.resolve();
        order.push("enqueue");
      },
    });
    order.push("after-sync");

    // enqueue resolved before sync returned (and before cursor save completed).
    expect(order).toEqual(["enqueue", "after-sync"]);
    expect(saveCursorSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Requirement 7.3 — cursor saved only after a durable page write
  // -------------------------------------------------------------------------

  it("saves the cursor only AFTER the page's writes succeed (order check)", async () => {
    const events: string[] = [];
    const { source } = makeFakeSource([
      { items: [makeNormalizedMarket("a"), makeNormalizedMarket("b")], nextCursor: null },
    ]);
    const repo = new FakeMarketRepository();
    vi.spyOn(repo, "upsertMarket").mockImplementation((m) => {
      events.push(`upsert:${m.externalId}`);
      return Promise.resolve({ ...m, id: `id-${m.externalId}` } as Market);
    });
    vi.spyOn(repo, "saveCursor").mockImplementation((_s, c) => {
      events.push(`saveCursor:${c}`);
      return Promise.resolve();
    });

    await syncMarkets(source, repo);

    // Both upserts happen strictly before the cursor is saved.
    expect(events).toEqual(["upsert:a", "upsert:b", "saveCursor:null"]);
  });

  it("does NOT advance or persist the cursor when a page write throws", async () => {
    const { source } = makeFakeSource([
      // Page 1 succeeds (cursor → c1).
      { items: [makeNormalizedMarket("a")], nextCursor: "c1" },
      // Page 2's second market fails on upsert.
      {
        items: [makeNormalizedMarket("b"), makeNormalizedMarket("boom"), makeNormalizedMarket("c")],
        nextCursor: "c2",
      },
    ]);
    const repo = new FakeMarketRepository({ failUpsertFor: "boom" });

    await expect(syncMarkets(source, repo)).rejects.toThrow(/upsert failed for boom/);

    // Only the first page's cursor was persisted; the failing page never
    // advanced it (Requirement 7.3: no temporary advancement / rollback).
    expect(repo.savedCursors).toEqual(["c1"]);
    expect(repo.cursor).toBe("c1");
    // "c" (after the failing "boom") was never written.
    expect(repo.markets.has(`${SOURCE_ID}\u0000c`)).toBe(false);
  });

  it("leaves a pre-existing cursor untouched when the very first page fails", async () => {
    const { source } = makeFakeSource([new Error("network down")]);
    const repo = new FakeMarketRepository({ initialCursor: "prior" });

    await expect(syncMarkets(source, repo)).rejects.toThrow(/network down/);

    expect(repo.savedCursors).toEqual([]);
    expect(repo.cursor).toBe("prior");
  });

  it("propagates a fetch failure without saving a cursor (no advancement on failure)", async () => {
    const { source } = makeFakeSource([
      { items: [makeNormalizedMarket("a")], nextCursor: "c1" },
      new Error("429 rate limited"),
    ]);
    const repo = new FakeMarketRepository();

    await expect(syncMarkets(source, repo)).rejects.toThrow(/429 rate limited/);

    // First page committed its cursor; the failed fetch added nothing.
    expect(repo.savedCursors).toEqual(["c1"]);
    expect(repo.cursor).toBe("c1");
  });

  // -------------------------------------------------------------------------
  // Requirement 7.1 — idempotent ingestion
  // -------------------------------------------------------------------------

  it("is idempotent: re-running over the same upstream state yields no duplicate rows", async () => {
    const pageState = (): Array<Page<NormalizedMarket>> => [
      { items: [makeNormalizedMarket("a"), makeNormalizedMarket("b")], nextCursor: "c1" },
      { items: [makeNormalizedMarket("c")], nextCursor: null },
    ];

    const repo = new FakeMarketRepository();

    const first = makeFakeSource(pageState());
    const r1 = await syncMarkets(first.source, repo);

    // Reset the cursor to re-run the full window (simulates a fresh sync pass).
    repo.cursor = null;
    const second = makeFakeSource(pageState());
    const r2 = await syncMarkets(second.source, repo);

    expect(r1.processed).toBe(3);
    expect(r2.processed).toBe(3);
    // Same three logical rows after two full passes — no duplicates.
    expect(repo.markets.size).toBe(3);
    // The ids are stable across re-syncs (idempotent upsert keeps the row id).
    const ids = [...repo.markets.values()].map((m) => m.id).sort();
    expect(new Set(ids).size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // fetch wrapper seam (task 5.2 plug-in point)
  // -------------------------------------------------------------------------

  it("routes every page fetch through the injectable fetch wrapper", async () => {
    const { source } = makeFakeSource([
      { items: [makeNormalizedMarket("a")], nextCursor: "c1" },
      { items: [makeNormalizedMarket("b")], nextCursor: null },
    ]);
    const repo = new FakeMarketRepository();
    const fetchWrapper = vi.fn(<T>(op: () => Promise<T>) => op());

    await syncMarkets(source, repo, { fetchWrapper });

    // One wrap per page fetch.
    expect(fetchWrapper).toHaveBeenCalledTimes(2);
  });

  it("propagates an error thrown by the fetch wrapper without advancing the cursor", async () => {
    const { source } = makeFakeSource([{ items: [makeNormalizedMarket("a")], nextCursor: null }]);
    const repo = new FakeMarketRepository({ initialCursor: "prior" });
    const fetchWrapper = vi.fn(() => Promise.reject(new Error("retries exhausted")));

    await expect(syncMarkets(source, repo, { fetchWrapper })).rejects.toThrow(/retries exhausted/);

    expect(repo.savedCursors).toEqual([]);
    expect(repo.cursor).toBe("prior");
  });

  // -------------------------------------------------------------------------
  // optional outcome persistence
  // -------------------------------------------------------------------------

  it("upserts outcomes against the persisted market id when an outcomeRepo is provided", async () => {
    const { source } = makeFakeSource([{ items: [makeNormalizedMarket("a")], nextCursor: null }]);
    const repo = new FakeMarketRepository();
    const outcomeRepo = new FakeOutcomeRepository();

    await syncMarkets(source, repo, { outcomeRepo });

    expect(outcomeRepo.upsertBatches).toHaveLength(1);
    const batch = outcomeRepo.upsertBatches[0]!;
    expect(batch.map((o) => o.label)).toEqual(["Yes", "No"]);
    const persisted = [...repo.markets.values()][0]!;
    for (const o of batch) expect(o.marketId).toBe(persisted.id);
  });

  it("skips outcome persistence when no outcomeRepo is provided", async () => {
    const { source } = makeFakeSource([{ items: [makeNormalizedMarket("a")], nextCursor: null }]);
    const repo = new FakeMarketRepository();

    // Should not throw and should complete normally.
    const result = await syncMarkets(source, repo);
    expect(result.processed).toBe(1);
  });

  it("handles an empty sync window (single empty page, immediate termination)", async () => {
    const { source, calls } = makeFakeSource([{ items: [], nextCursor: null }]);
    const repo = new FakeMarketRepository();
    const enqueueForMatching = vi.fn();

    const result = await syncMarkets(source, repo, { enqueueForMatching });

    expect(calls).toHaveLength(1);
    expect(result.processed).toBe(0);
    expect(result.pages).toBe(1);
    expect(repo.savedCursors).toEqual([null]);
    expect(enqueueForMatching).not.toHaveBeenCalled();
  });
});
