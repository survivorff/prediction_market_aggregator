import { describe, it, expect, expectTypeOf } from "vitest";
import type {
  MarketSource,
  SourceMeta,
  SourceCapabilities,
  PageRequest,
  Page,
  TimeRange,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedOutcome,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  Subscription,
  CursorRepository,
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  CanonicalEventRepository,
  MatchingRepository,
  LinkedMarket,
  MarketUpsert,
} from "./index.js";
import type { Market } from "../model/index.js";

/**
 * Type-level conformance tests for the task 2.2 port interfaces.
 *
 * These are primarily compile-time checks: the file type-checks during the
 * build, proving the interfaces are well-formed, exported from the package
 * barrel, and structurally match the design's signatures (design.md "The
 * `MarketSource` Adapter Interface" and the ingestion/matching algorithms).
 * A couple of runtime assertions keep Vitest's runner satisfied.
 */
describe("ports type contracts", () => {
  it("allows an in-memory MarketSource to satisfy the adapter port", () => {
    const meta: SourceMeta = {
      id: "00000000-0000-0000-0000-000000000000",
      key: "manifold",
      name: "Manifold",
      type: "onchain",
      baseCurrency: "MANA",
    };

    const capabilities: SourceCapabilities = {
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: false,
      keysetPagination: true,
    };

    // A minimal adapter that omits the optional `subscribePrices` (allowed when
    // capabilities().websocketPrices === false — Requirement 8.3).
    const source: MarketSource = {
      meta,
      fetchEvents: (_opts: PageRequest): Promise<Page<NormalizedEvent>> =>
        Promise.resolve({ items: [], nextCursor: null }),
      fetchMarkets: (_opts: PageRequest): Promise<Page<NormalizedMarket>> =>
        Promise.resolve({ items: [], nextCursor: null }),
      fetchPriceSnapshot: (_marketIds: string[]): Promise<NormalizedPriceSnapshot[]> =>
        Promise.resolve([]),
      fetchPriceHistory: (_marketId: string, _range: TimeRange): Promise<NormalizedPricePoint[]> =>
        Promise.resolve([]),
      capabilities: () => capabilities,
    };

    expect(source.meta.key).toBe("manifold");
    expect(source.capabilities().websocketPrices).toBe(false);
    expect(source.subscribePrices).toBeUndefined();
  });

  it("exposes an optional, capability-gated subscribePrices method", () => {
    expectTypeOf<MarketSource>()
      .toHaveProperty("subscribePrices")
      .toEqualTypeOf<
        | undefined
        | ((marketIds: string[], handler: (tick: NormalizedPriceSnapshot) => void) => Subscription)
      >();
  });

  it("models normalized payloads with explicit nullable metadata", () => {
    const outcome: NormalizedOutcome = {
      label: "Yes",
      tokenId: null,
      impliedProb: null,
      lastPrice: null,
    };
    const market: NormalizedMarket = {
      externalId: "abc",
      eventExternalId: null,
      question: "Will it rain tomorrow?",
      status: "open",
      volume24h: null,
      liquidity: null,
      spread: null,
      outcomes: [outcome],
      resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
    };
    expect(market.outcomes).toHaveLength(1);
    // NormalizedPricePoint is an alias of NormalizedPriceSnapshot per design.
    expectTypeOf<NormalizedPricePoint>().toEqualTypeOf<NormalizedPriceSnapshot>();
  });

  it("keeps the upsert shape free of the persistence-assigned id", () => {
    // MarketUpsert is Market without its internal `id` (resolved on upsert).
    expectTypeOf<MarketUpsert>().toEqualTypeOf<Omit<Market, "id">>();
    // LinkedMarket extends Market with the matching mismatch flag.
    expectTypeOf<LinkedMarket>().toMatchTypeOf<Market>();
    expectTypeOf<LinkedMarket>().toHaveProperty("resolutionMismatch");
  });

  it("declares repository ports referenced by the ingestion/matching algorithms", () => {
    // Cursor load/save for crash-safe resume (Requirement 7.3).
    expectTypeOf<CursorRepository>().toHaveProperty("loadCursor");
    expectTypeOf<CursorRepository>().toHaveProperty("saveCursor");
    // Idempotent market upsert + cursor (Requirement 7.1).
    expectTypeOf<MarketRepository>().toHaveProperty("upsertMarket");
    expectTypeOf<MarketRepository>().toHaveProperty("loadCursor");
    expectTypeOf<MarketRepository>().toHaveProperty("saveCursor");
    // Idempotent price writes (Requirement 7.2).
    expectTypeOf<PricePointRepository>().toHaveProperty("writePricePoint");
    expectTypeOf<OutcomeRepository>().toHaveProperty("upsertOutcome");
    expectTypeOf<CanonicalEventRepository>().toHaveProperty("create");
    // Candidate search + canonical linking (Requirement 11.x, design matchMarket).
    expectTypeOf<MatchingRepository>().toHaveProperty("findCandidates");
    expectTypeOf<MatchingRepository>().toHaveProperty("linkToCanonical");
    expectTypeOf<MatchingRepository>().toHaveProperty("marketsForCanonical");
    expect(true).toBe(true);
  });
});
