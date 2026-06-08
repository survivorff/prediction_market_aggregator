import { describe, it, expect } from "vitest";
import type { MarketSource } from "@pma/core";
import { PredictFunAdapter, PREDICTFUN_KEY } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";

/**
 * Unit tests for the {@link PredictFunAdapter} with an INJECTED fake HTTP client
 * — no real network is used. They exercise cursor pagination, normalization
 * (binary Yes/No outcomes, order-book mid as the Yes implied probability),
 * raw-criteria preservation, price snapshot/history/depth, the `x-api-key`
 * header, and the capability gating (no `subscribePrices`).
 */

interface RecordedResponse {
  ok?: boolean;
  status?: number;
  body: unknown;
}

/** Build a fake {@link HttpClient} that returns recorded responses by URL substring. */
function makeFakeHttp(routes: Array<{ match: string; response: RecordedResponse }>): {
  http: HttpClient;
  calls: Array<{ url: string; options?: HttpGetOptions }>;
} {
  const calls: Array<{ url: string; options?: HttpGetOptions }> = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      // Longest match wins so "/orderbook" beats "/markets".
      const route = [...routes]
        .sort((a, b) => b.match.length - a.match.length)
        .find((r) => url.includes(r.match));
      const rec: RecordedResponse = route?.response ?? { ok: false, status: 404, body: null };
      const response: HttpResponse = {
        ok: rec.ok ?? true,
        status: rec.status ?? 200,
        json: () => Promise.resolve(rec.body),
        text: () => Promise.resolve(JSON.stringify(rec.body)),
      };
      return Promise.resolve(response);
    },
  };
  return { http, calls };
}

describe("PredictFunAdapter — meta & capabilities", () => {
  it("declares the predict.fun meta (onchain / USDB)", () => {
    const adapter = new PredictFunAdapter();
    expect(adapter.meta.key).toBe(PREDICTFUN_KEY);
    expect(adapter.meta.type).toBe("onchain");
    expect(adapter.meta.baseCurrency).toBe("USDB");
    expect(adapter.meta.name).toBe("Predict.fun");
  });

  it("accepts an injected resolved source id", () => {
    const adapter = new PredictFunAdapter({ sourceId: "src-uuid" });
    expect(adapter.meta.id).toBe("src-uuid");
  });

  it("declares websocketPrices FALSE; history/depth/keyset true (Req 8.2)", () => {
    const caps = new PredictFunAdapter().capabilities();
    expect(caps).toEqual({
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: true,
      keysetPagination: true,
    });
  });

  it("does NOT expose subscribePrices (Req 8.3 — gated optional absent)", () => {
    const adapter = new PredictFunAdapter();
    const asSource: MarketSource = adapter;
    expect(asSource.subscribePrices).toBeUndefined();
  });
});

describe("PredictFunAdapter.fetchMarkets", () => {
  it("maps a /v1/markets envelope into normalized markets", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/v1/markets",
        response: {
          body: {
            data: [
              {
                id: 472,
                conditionId: "0xbcad63b0",
                title: "Will BTC close above $100,000 in 2025?",
                question: "Will BTC close above $100,000 in 2025?",
                categorySlug: "btc-100k-2025",
                tradingStatus: "OPEN",
                feeRateBps: 200,
                isNegRisk: false,
                kalshiMarketTicker: null,
                spreadThreshold: 0.06,
                outcomes: [
                  { indexSet: 1, name: "Yes", onChainId: "996878839967" },
                  { indexSet: 2, name: "No", onChainId: "604025163334" },
                ],
                resolverAddress: "0x52DA245a",
              },
            ],
            cursor: "NDEw",
          },
        },
      },
    ]);
    const adapter = new PredictFunAdapter({ http });

    const page = await adapter.fetchMarkets({ limit: 50 });

    expect(page.items).toHaveLength(1);
    const market = page.items[0]!;
    expect(market.externalId).toBe("472");
    expect(market.eventExternalId).toBe("btc-100k-2025");
    expect(market.question).toBe("Will BTC close above $100,000 in 2025?");
    expect(market.status).toBe("open");
    expect(market.outcomes).toHaveLength(2);
    expect(market.outcomes[0]?.label).toBe("Yes");
    expect(market.outcomes[0]?.tokenId).toBe("996878839967");
    // The markets list carries no price → explicit null until snapshot fills it.
    expect(market.outcomes[0]?.impliedProb).toBeNull();
    // Raw resolution criteria preserved for matching Layer 4 (Req 10.3).
    expect(market.resolutionCriteria.raw).toMatchObject({
      conditionId: "0xbcad63b0",
      resolverAddress: "0x52DA245a",
      categorySlug: "btc-100k-2025",
    });
  });

  it("paginates via the upstream cursor and round-trips it back", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v1/markets",
        response: { body: { data: [{ id: 1, title: "Q" }], cursor: "server-next" } },
      },
    ]);
    const adapter = new PredictFunAdapter({ http });

    const first = await adapter.fetchMarkets({ limit: 1 });
    expect(first.nextCursor).toBe("server-next");

    await adapter.fetchMarkets({ limit: 1, cursor: first.nextCursor! });
    expect(calls[1]!.options?.query?.cursor).toBe("server-next");
  });

  it("returns a null cursor when the envelope carries none (end of stream)", async () => {
    const { http } = makeFakeHttp([
      { match: "/v1/markets", response: { body: { data: [{ id: 9, title: "Q" }] } } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it("returns a null cursor on an empty page even if a cursor is present", async () => {
    const { http } = makeFakeHttp([
      { match: "/v1/markets", response: { body: { data: [], cursor: "x" } } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("yields an empty page on a non-OK response (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/v1/markets", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("sends the x-api-key header when an apiKey is configured (mainnet)", async () => {
    const { http, calls } = makeFakeHttp([
      { match: "/v1/markets", response: { body: { data: [], cursor: null } } },
    ]);
    const adapter = new PredictFunAdapter({ http, apiKey: "secret-key" });
    await adapter.fetchMarkets({ limit: 10 });
    expect(calls[0]!.options?.headers?.["x-api-key"]).toBe("secret-key");
  });

  it("omits the x-api-key header on the public testnet (no key)", async () => {
    const { http, calls } = makeFakeHttp([
      { match: "/v1/markets", response: { body: { data: [], cursor: null } } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    await adapter.fetchMarkets({ limit: 10 });
    expect(calls[0]!.options?.headers?.["x-api-key"]).toBeUndefined();
  });
});

describe("PredictFunAdapter.fetchEvents", () => {
  it("returns an empty, terminal page (predict.fun groups by categorySlug)", async () => {
    const { http, calls } = makeFakeHttp([]);
    const adapter = new PredictFunAdapter({ http });
    const page = await adapter.fetchEvents({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("PredictFunAdapter.fetchPriceSnapshot", () => {
  it("derives the Yes implied probability from the order-book mid", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/orderbook",
        response: {
          body: { data: { marketId: 472, asks: [[0.62, 10]], bids: [[0.58, 8]] } },
        },
      },
    ]);
    const adapter = new PredictFunAdapter({
      http,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    const snaps = await adapter.fetchPriceSnapshot(["472"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.marketExternalId).toBe("472");
    expect(snaps[0]?.outcomeLabel).toBe("Yes");
    // mid = (0.62 + 0.58) / 2 = 0.60
    expect(snaps[0]?.price).toBeCloseTo(0.6, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });

  it("falls back to the single populated side when the book is one-sided", async () => {
    const { http } = makeFakeHttp([
      { match: "/orderbook", response: { body: { data: { asks: [[0.614, 2.28]], bids: [] } } } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const snaps = await adapter.fetchPriceSnapshot(["472"]);
    expect(snaps[0]?.price).toBeCloseTo(0.614, 6);
  });

  it("skips markets whose book cannot be read or is empty (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/orderbook", response: { ok: false, status: 404, body: null } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    expect(await adapter.fetchPriceSnapshot(["472"])).toEqual([]);
  });

  it("ignores empty market ids", async () => {
    const { http, calls } = makeFakeHttp([
      { match: "/orderbook", response: { body: { data: { asks: [[0.5, 1]], bids: [[0.5, 1]] } } } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    await adapter.fetchPriceSnapshot(["", "   "]);
    expect(calls).toHaveLength(0);
  });
});

describe("PredictFunAdapter.fetchPriceHistory", () => {
  it("maps the /timeseries payload into a Yes price series within range", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/timeseries",
        response: {
          body: {
            data: [
              { t: 1735689600, p: "0.4" },
              { t: 1735693200, p: 0.45 },
            ],
          },
        },
      },
    ]);
    const adapter = new PredictFunAdapter({ http });

    const points = await adapter.fetchPriceHistory("472", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
      interval: "1h",
    });

    expect(points).toHaveLength(2);
    expect(points[0]?.price).toBeCloseTo(0.4, 6);
    expect(points[1]?.price).toBeCloseTo(0.45, 6);
    expect(calls[0]!.options?.query?.interval).toBe("1h");
    expect(calls[0]!.url).toContain("/v1/markets/472/timeseries");
  });

  it("returns an empty series on failure (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/timeseries", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const points = await adapter.fetchPriceHistory("472", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
    });
    expect(points).toEqual([]);
  });
});

describe("PredictFunAdapter.fetchOrderBookDepth", () => {
  it("maps the /orderbook tuple ladders into normalized depth (Req 4.3)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/orderbook",
        response: {
          body: {
            data: {
              marketId: 472,
              asks: [[0.62, 10]],
              bids: [[0.58, 8]],
            },
          },
        },
      },
    ]);
    const adapter = new PredictFunAdapter({ http });
    const depth = await adapter.fetchOrderBookDepth("472");
    expect(depth?.marketId).toBe("472");
    expect(depth?.asks[0]).toEqual({ price: 0.62, size: 10 });
    expect(depth?.bids[0]).toEqual({ price: 0.58, size: 8 });
  });

  it("returns null on failure", async () => {
    const { http } = makeFakeHttp([
      { match: "/orderbook", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new PredictFunAdapter({ http });
    expect(await adapter.fetchOrderBookDepth("472")).toBeNull();
  });
});
