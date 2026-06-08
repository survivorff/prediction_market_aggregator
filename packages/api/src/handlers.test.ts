/**
 * Unit tests for the framework-agnostic gateway handlers, using in-memory fakes
 * (no Postgres/Redis). Cover the response-shape, hot-cache overlay (Req 10.4),
 * explicit-null (Req 1.5), filtering/sorting/search (Req 1.1/1.2/1.4),
 * detail/history (Req 4.1/4.2/4.3), sources, and 404 behavior.
 */

import { describe, it, expect } from "vitest";
import type { GatewayDeps } from "./dto.js";
import {
  handleGetMarket,
  handleGetMarketHistory,
  handleListMarkets,
  handleListSources,
} from "./handlers.js";
import { NotFoundError } from "./errors.js";
import {
  FakeDiscoveryReader,
  FakeHotPriceReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  caps,
  makeFakeMarket,
  type FakeMarket,
} from "./test-support.js";

const NOW = Date.UTC(2025, 0, 1, 0, 0, 0); // 2025-01-01T00:00:00Z

function buildDeps(
  markets: FakeMarket[],
  options: Partial<Pick<GatewayDeps, "hotPrices" | "capabilities">> = {},
): GatewayDeps {
  return {
    discovery: new FakeDiscoveryReader(markets),
    outcomes: new FakeOutcomeReader(markets),
    prices: new FakePriceHistoryReader(markets),
    sources: new FakeSourceReader([
      { id: "s1", key: "polymarket", name: "Polymarket", type: "onchain", baseCurrency: "USDC" },
      { id: "s2", key: "manifold", name: "Manifold", type: "cex", baseCurrency: "MANA" },
    ]),
    hotPrices: options.hotPrices,
    capabilities: options.capabilities,
    now: () => NOW,
  };
}

describe("handleListMarkets", () => {
  it("returns the unified MarketSummary shape with derived timeRemainingSec", async () => {
    const market = makeFakeMarket({ endDate: "2025-01-02T00:00:00.000Z", yesImpliedProb: 0.6 });
    const deps = buildDeps([market]);

    const res = await handleListMarkets(deps, {});

    expect(res.markets).toHaveLength(1);
    const m = res.markets[0]!;
    expect(m).toMatchObject({
      id: market.detail.id,
      source: { key: "polymarket", name: "Polymarket" },
      question: market.summary.question,
      category: "crypto",
      status: "open",
      impliedProb: 0.6,
      volume24h: 1000,
      liquidity: 500,
      canonicalEventId: null,
    });
    // 24h until end date.
    expect(m.timeRemainingSec).toBe(24 * 60 * 60);
    expect(res.paging.count).toBe(1);
  });

  it("represents missing metadata explicitly as null (Req 1.5)", async () => {
    const market = makeFakeMarket({
      volume24h: null,
      liquidity: null,
      endDate: null,
      yesImpliedProb: null,
    });
    const deps = buildDeps([market]);

    const res = await handleListMarkets(deps, {});
    const m = res.markets[0]!;
    expect(m.volume24h).toBeNull();
    expect(m.liquidity).toBeNull();
    expect(m.timeRemainingSec).toBeNull();
    expect(m.impliedProb).toBeNull();
  });

  it("serves latest implied prob from the hot cache, overriding stored (Req 10.4)", async () => {
    const market = makeFakeMarket({ externalId: "ext-hot", yesImpliedProb: 0.6 });
    const hot = new FakeHotPriceReader({
      "ext-hot": [
        {
          marketId: "ext-hot",
          outcomeLabel: "Yes",
          price: 0.81,
          volume: 5,
          ts: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    const deps = buildDeps([market], { hotPrices: hot });

    const res = await handleListMarkets(deps, {});
    expect(res.markets[0]!.impliedProb).toBe(0.81);
  });

  it("falls back to stored implied prob when the hot cache misses", async () => {
    const market = makeFakeMarket({ externalId: "ext-cold", yesImpliedProb: 0.42 });
    const deps = buildDeps([market], { hotPrices: new FakeHotPriceReader({}) });

    const res = await handleListMarkets(deps, {});
    expect(res.markets[0]!.impliedProb).toBe(0.42);
  });

  it("filters by category and full-text query (Req 1.2)", async () => {
    const btc = makeFakeMarket({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      question: "Will BTC top 100k?",
      category: "crypto",
    });
    const election = makeFakeMarket({
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      question: "Who wins the election?",
      category: "politics",
    });
    const deps = buildDeps([btc, election]);

    const byCategory = await handleListMarkets(deps, { category: "politics" });
    expect(byCategory.markets.map((m) => m.id)).toEqual([election.detail.id]);

    const byQuery = await handleListMarkets(deps, { q: "btc" });
    expect(byQuery.markets.map((m) => m.id)).toEqual([btc.detail.id]);
  });

  it("sorts by volume desc and liquidity, and time remaining asc (Req 1.4)", async () => {
    const low = makeFakeMarket({
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      volume24h: 10,
      liquidity: 5,
      endDate: "2025-06-01T00:00:00.000Z",
    });
    const high = makeFakeMarket({
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      volume24h: 9999,
      liquidity: 8888,
      endDate: "2025-02-01T00:00:00.000Z",
    });
    const deps = buildDeps([low, high]);

    const byVolume = await handleListMarkets(deps, { sort: "volume" });
    expect(byVolume.markets.map((m) => m.id)).toEqual([high.detail.id, low.detail.id]);

    const byLiquidity = await handleListMarkets(deps, { sort: "liquidity" });
    expect(byLiquidity.markets.map((m) => m.id)).toEqual([high.detail.id, low.detail.id]);

    // Soonest end date first.
    const byTime = await handleListMarkets(deps, { sort: "timeRemaining" });
    expect(byTime.markets.map((m) => m.id)).toEqual([high.detail.id, low.detail.id]);
  });

  it("applies limit/offset paging", async () => {
    const markets = Array.from({ length: 5 }, (_, i) =>
      makeFakeMarket({
        id: `0000000${i}-0000-0000-0000-00000000000${i}`,
        volume24h: (5 - i) * 100,
      }),
    );
    const deps = buildDeps(markets);
    const res = await handleListMarkets(deps, { limit: 2, offset: 1 });
    expect(res.markets).toHaveLength(2);
    expect(res.paging).toEqual({ limit: 2, offset: 1, count: 2 });
  });
});

describe("handleGetMarket", () => {
  it("returns detail with outcomes and latest prices + a source trade-link path (Req 4.1)", async () => {
    const market = makeFakeMarket({});
    const deps = buildDeps([market]);

    const detail = await handleGetMarket(deps, market.detail.id);
    expect(detail.id).toBe(market.detail.id);
    expect(detail.source).toEqual({ key: "polymarket", name: "Polymarket" });
    expect(detail.outcomes.map((o) => o.label).sort()).toEqual(["No", "Yes"]);
    expect(detail.tradeLinkPath).toBe(`/api/markets/${market.detail.id}/trade-link`);
    // Yes implied prob surfaces at the top level.
    expect(detail.impliedProb).toBe(0.6);
  });

  it("overlays outcome latest price from the hot cache and records its source (Req 10.4)", async () => {
    const market = makeFakeMarket({ externalId: "ext-detail" });
    const hot = new FakeHotPriceReader({
      "ext-detail": [
        {
          marketId: "ext-detail",
          outcomeLabel: "Yes",
          price: 0.73,
          volume: null,
          ts: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    const deps = buildDeps([market], { hotPrices: hot });

    const detail = await handleGetMarket(deps, market.detail.id);
    const yes = detail.outcomes.find((o) => o.label === "Yes")!;
    expect(yes.lastPrice).toBe(0.73);
    expect(yes.priceSource).toBe("hotCache");
    expect(yes.latestPriceTs).toBe("2025-01-01T00:00:00.000Z");

    const no = detail.outcomes.find((o) => o.label === "No")!;
    expect(no.priceSource).toBe("stored");
  });

  it("reports order-book depth as null but supported per source capability (Req 4.3/9.1)", async () => {
    const market = makeFakeMarket({ sourceKey: "polymarket" });
    const deps = buildDeps([market], {
      capabilities: { polymarket: caps({ orderBookDepth: true }) },
    });

    const detail = await handleGetMarket(deps, market.detail.id);
    expect(detail.orderBookDepth).toBeNull();
    expect(detail.orderBookDepthSupported).toBe(true);
  });

  it("defaults orderBookDepthSupported to false when capabilities are unknown", async () => {
    const market = makeFakeMarket({});
    const deps = buildDeps([market]);
    const detail = await handleGetMarket(deps, market.detail.id);
    expect(detail.orderBookDepthSupported).toBe(false);
  });

  it("throws NotFoundError for an unknown market id", async () => {
    const deps = buildDeps([makeFakeMarket({})]);
    await expect(
      handleGetMarket(deps, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("handleGetMarketHistory", () => {
  it("returns a time-series filtered to the requested range (Req 4.2)", async () => {
    const market = makeFakeMarket({
      history: [
        { marketId: "m", outcomeId: "o1", ts: "2025-01-01T00:00:00.000Z", price: 0.5, volume: 1 },
        { marketId: "m", outcomeId: "o1", ts: "2025-01-02T00:00:00.000Z", price: 0.55, volume: 2 },
        { marketId: "m", outcomeId: "o1", ts: "2025-01-09T00:00:00.000Z", price: 0.6, volume: 3 },
      ],
    });
    const deps = buildDeps([market]);

    const res = await handleGetMarketHistory(deps, market.detail.id, {
      range: { from: "2025-01-01T00:00:00.000Z", to: "2025-01-03T00:00:00.000Z" },
    });
    expect(res.points.map((p) => p.ts)).toEqual([
      "2025-01-01T00:00:00.000Z",
      "2025-01-02T00:00:00.000Z",
    ]);
    expect(res.range.interval).toBeNull();
  });

  it("throws NotFoundError for history of an unknown market", async () => {
    const deps = buildDeps([makeFakeMarket({})]);
    await expect(
      handleGetMarketHistory(deps, "99999999-9999-9999-9999-999999999999", {
        range: { from: "2025-01-01T00:00:00.000Z", to: "2025-01-03T00:00:00.000Z" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("handleListSources", () => {
  it("lists registered sources with declared capabilities", async () => {
    const deps = buildDeps([], {
      capabilities: {
        polymarket: caps({
          websocketPrices: true,
          orderBookDepth: true,
          priceHistory: true,
          keysetPagination: true,
        }),
      },
    });
    const res = await handleListSources(deps);
    expect(res.sources.map((s) => s.key)).toEqual(["polymarket", "manifold"]);

    const poly = res.sources.find((s) => s.key === "polymarket")!;
    expect(poly.capabilities?.websocketPrices).toBe(true);

    const manifold = res.sources.find((s) => s.key === "manifold")!;
    expect(manifold.capabilities).toBeNull();
  });
});
