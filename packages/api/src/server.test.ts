/**
 * HTTP-level tests for the Fastify gateway using `app.inject` (no port binding,
 * no real infra). Asserts route wiring, response shapes/status codes, 400 on
 * invalid input (Req 9.3), and 404 for unknown markets — exercising the same
 * handlers as the unit tests but through the real Fastify request/error path.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeDiscoveryReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  caps,
  makeFakeMarket,
  type FakeMarket,
} from "./test-support.js";

const NOW = Date.UTC(2025, 0, 1, 0, 0, 0);
const MARKET_ID = "11111111-1111-1111-1111-111111111111";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

function build(markets: FakeMarket[], extra: Partial<GatewayDeps> = {}): FastifyInstance {
  const deps: GatewayDeps = {
    discovery: new FakeDiscoveryReader(markets),
    outcomes: new FakeOutcomeReader(markets),
    prices: new FakePriceHistoryReader(markets),
    sources: new FakeSourceReader([
      { id: "s1", key: "polymarket", name: "Polymarket", type: "onchain", baseCurrency: "USDC" },
    ]),
    now: () => NOW,
    ...extra,
  };
  app = createServer(deps);
  return app;
}

describe("GET /api/markets", () => {
  it("returns 200 with a unified market list", async () => {
    const server = build([makeFakeMarket({ id: MARKET_ID })]);
    const res = await server.inject({ method: "GET", url: "/api/markets" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markets).toHaveLength(1);
    expect(body.markets[0]).toMatchObject({
      id: MARKET_ID,
      source: { key: "polymarket", name: "Polymarket" },
      impliedProb: 0.6,
    });
    expect(body.paging.count).toBe(1);
  });

  it("applies filters via query string", async () => {
    const a = makeFakeMarket({
      id: "aaaaaaaa-1111-1111-1111-111111111111",
      category: "crypto",
      question: "BTC 100k",
    });
    const b = makeFakeMarket({
      id: "bbbbbbbb-2222-2222-2222-222222222222",
      category: "politics",
      question: "Election",
    });
    const server = build([a, b]);

    const res = await server.inject({ method: "GET", url: "/api/markets?category=politics" });
    expect(res.statusCode).toBe(200);
    expect(res.json().markets.map((m: { id: string }) => m.id)).toEqual([b.detail.id]);
  });

  it("returns 400 on an invalid category", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/markets?category=weather" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.field).toBe("category");
  });

  it("returns 400 on an out-of-range limit", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/markets?limit=9999" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/markets/:id", () => {
  it("returns 200 with market detail", async () => {
    const server = build([makeFakeMarket({ id: MARKET_ID })], {
      capabilities: { polymarket: caps({ orderBookDepth: true }) },
    });
    const res = await server.inject({ method: "GET", url: `/api/markets/${MARKET_ID}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(MARKET_ID);
    expect(body.outcomes).toHaveLength(2);
    expect(body.orderBookDepth).toBeNull();
    expect(body.orderBookDepthSupported).toBe(true);
    expect(body.tradeLinkPath).toBe(`/api/markets/${MARKET_ID}/trade-link`);
  });

  it("returns 404 for an unknown market", async () => {
    const server = build([makeFakeMarket({ id: MARKET_ID })]);
    const res = await server.inject({
      method: "GET",
      url: "/api/markets/99999999-9999-9999-9999-999999999999",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a non-UUID id", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/markets/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/markets/:id/history", () => {
  it("returns 200 with a price-history series", async () => {
    const market = makeFakeMarket({
      id: MARKET_ID,
      history: [
        {
          marketId: MARKET_ID,
          outcomeId: "o1",
          ts: "2025-01-01T00:00:00.000Z",
          price: 0.5,
          volume: 1,
        },
        {
          marketId: MARKET_ID,
          outcomeId: "o1",
          ts: "2025-01-01T12:00:00.000Z",
          price: 0.55,
          volume: 2,
        },
      ],
    });
    const server = build([market]);
    const res = await server.inject({
      method: "GET",
      url: `/api/markets/${MARKET_ID}/history?from=2025-01-01T00:00:00.000Z&to=2025-01-02T00:00:00.000Z`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(2);
  });

  it("returns 400 on from > to", async () => {
    const server = build([makeFakeMarket({ id: MARKET_ID })]);
    const res = await server.inject({
      method: "GET",
      url: `/api/markets/${MARKET_ID}/history?from=2025-02-01T00:00:00.000Z&to=2025-01-01T00:00:00.000Z`,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/sources", () => {
  it("returns 200 with registered sources", async () => {
    const server = build([], {
      capabilities: { polymarket: caps({ websocketPrices: true }) },
    });
    const res = await server.inject({ method: "GET", url: "/api/sources" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].key).toBe("polymarket");
    expect(body.sources[0].capabilities.websocketPrices).toBe(true);
  });
});

describe("GET /api/markets/:id/trade-link", () => {
  it("returns 200 with a navigation-only deep-link (executable:false)", async () => {
    const market = makeFakeMarket({
      id: MARKET_ID,
      externalId: "btc-100k",
      sourceKey: "polymarket",
      sourceName: "Polymarket",
    });
    const server = build([market]);
    const res = await server.inject({
      method: "GET",
      url: `/api/markets/${MARKET_ID}/trade-link`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      marketId: MARKET_ID,
      source: { key: "polymarket", name: "Polymarket" },
      url: "https://polymarket.com/event/btc-100k",
      executable: false,
    });
  });

  it("returns 404 for an unknown market", async () => {
    const server = build([makeFakeMarket({ id: MARKET_ID })]);
    const res = await server.inject({
      method: "GET",
      url: "/api/markets/99999999-9999-9999-9999-999999999999/trade-link",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a non-UUID id", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/markets/not-a-uuid/trade-link" });
    expect(res.statusCode).toBe(400);
  });

  it("uses an injected resolver, proving the slot is replaceable (Req 6.3)", async () => {
    const market = makeFakeMarket({ id: MARKET_ID });
    const server = build([market], {
      tradeLink: (m) => ({
        marketId: m.id,
        source: { key: m.sourceKey, name: m.sourceName },
        url: "https://example.test/slot",
        executable: false,
      }),
    });
    const res = await server.inject({
      method: "GET",
      url: `/api/markets/${MARKET_ID}/trade-link`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("https://example.test/slot");
    expect(res.json().executable).toBe(false);
  });
});

describe("GET /healthz", () => {
  it("returns 200 ok", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
