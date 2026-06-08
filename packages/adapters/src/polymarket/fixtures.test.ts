import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import type { NormalizedPriceSnapshot } from "@pma/core";
import { PolymarketAdapter } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";
import { FakeWebSocket, type WebSocketFactory } from "./socket.js";
import { decodeCursor, cursorToQuery } from "./cursor.js";

/**
 * Recorded-fixture normalization tests for the Polymarket adapter (task 4.4).
 *
 * Unlike the inline-payload unit tests in `index.test.ts`, these feed RECORDED
 * Gamma/CLOB/WebSocket payloads — stored as standalone `.json` files under
 * `./__fixtures__/` — through the adapter via an injected fake HTTP client and
 * a {@link FakeWebSocket}. They assert:
 *
 * - the resulting normalized entities are correct (Requirement 1.1 — unified
 *   discovery shape: implied probability, 24h volume, liquidity, status, raw
 *   resolution criteria);
 * - incomplete upstream metadata is represented EXPLICITLY as `null` and never
 *   fails the request (Requirement 1.5);
 * - the opaque keyset cursor round-trips back into the correct upstream query
 *   parameter, and end-of-stream yields `null`.
 *
 * All transports are injected, so no real network or sockets are used. A fixed
 * clock is injected wherever a capture timestamp is involved (determinism).
 */

/** Load a recorded JSON fixture relative to this test file. */
function loadFixture(name: string): unknown {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

/** A recorded HTTP response keyed by a URL substring. */
interface RecordedRoute {
  match: string;
  body: unknown;
  ok?: boolean;
  status?: number;
}

/**
 * Build a fake {@link HttpClient} that replays recorded fixture bodies by
 * matching a substring of the requested URL, recording calls so tests can
 * assert the query parameters the adapter sent.
 */
function makeFixtureHttp(routes: RecordedRoute[]): {
  http: HttpClient;
  calls: Array<{ url: string; options?: HttpGetOptions }>;
} {
  const calls: Array<{ url: string; options?: HttpGetOptions }> = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      const route = routes.find((r) => url.includes(r.match));
      const response: HttpResponse = {
        ok: route?.ok ?? true,
        status: route?.status ?? 200,
        json: () => Promise.resolve(route?.body ?? null),
        text: () => Promise.resolve(JSON.stringify(route?.body ?? null)),
      };
      return Promise.resolve(response);
    },
  };
  return { http, calls };
}

const FIXED_NOW = new Date("2025-01-01T00:00:00.000Z");

describe("Polymarket fixtures — Gamma /markets normalization (Req 1.1)", () => {
  it("normalizes a recorded markets page into NormalizedMarket entities", async () => {
    const { http } = makeFixtureHttp([
      { match: "/markets", body: loadFixture("gamma-markets-page.json") },
    ]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });

    expect(page.items).toHaveLength(2);

    const [btc, fed] = page.items;
    // First market: open binary market with full metadata.
    expect(btc!.externalId).toBe("253591");
    expect(btc!.eventExternalId).toBe("12345");
    expect(btc!.question).toBe("Will Bitcoin reach $150,000 by December 31, 2025?");
    expect(btc!.status).toBe("open");
    expect(btc!.volume24h).toBeCloseTo(152340.55, 2);
    expect(btc!.liquidity).toBeCloseTo(84210, 2);
    expect(btc!.spread).toBeCloseTo(0.02, 6);

    // Yes-token price is the implied probability; binary pair sums to ~1.
    expect(btc!.outcomes).toHaveLength(2);
    expect(btc!.outcomes[0]?.label).toBe("Yes");
    expect(btc!.outcomes[0]?.impliedProb).toBeCloseTo(0.38, 6);
    expect(btc!.outcomes[0]?.lastPrice).toBeCloseTo(0.38, 6);
    expect(btc!.outcomes[1]?.label).toBe("No");
    expect(btc!.outcomes[1]?.impliedProb).toBeCloseTo(0.62, 6);
    const sum = (btc!.outcomes[0]?.impliedProb ?? 0) + (btc!.outcomes[1]?.impliedProb ?? 0);
    expect(sum).toBeCloseTo(1, 6);
    // Outcome token ids are carried from the stringified clobTokenIds array.
    expect(btc!.outcomes[0]?.tokenId).toBe(
      "71291837465019283746501928374650192837465019283746501928374650192",
    );

    // Raw resolution criteria are preserved for auditability (Req 10.3).
    expect(btc!.resolutionCriteria.dataSource).toBe("Coinbase BTC-USD spot price");
    expect(btc!.resolutionCriteria.cutoffTime).toBe("2025-12-31T23:59:59.000Z");
    expect(btc!.resolutionCriteria.raw).toMatchObject({
      resolutionSource: "Coinbase BTC-USD spot price",
      umaResolutionStatus: "proposed",
    });

    // Second market: resolved via UMA, grouped by a flat eventId.
    expect(fed!.externalId).toBe("253592");
    expect(fed!.eventExternalId).toBe("67890");
    expect(fed!.status).toBe("resolved");
    expect(fed!.outcomes[0]?.impliedProb).toBeCloseTo(0.91, 6);
  });

  it("round-trips the native keyset cursor into the next upstream query", async () => {
    const { http, calls } = makeFixtureHttp([
      { match: "/markets", body: loadFixture("gamma-markets-page.json") },
    ]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });
    // The recorded page carries next_cursor "MjUw" → a non-null opaque cursor.
    expect(page.nextCursor).not.toBeNull();
    // Decoding the opaque cursor recovers the upstream keyset token.
    expect(decodeCursor(page.nextCursor!)).toEqual({
      kind: "keyset",
      token: "MjUw",
    });
    expect(cursorToQuery(decodeCursor(page.nextCursor!), 100)).toEqual({
      next_cursor: "MjUw",
      limit: 100,
    });

    // Feeding it back produces a request carrying that next_cursor verbatim.
    await adapter.fetchMarkets({ limit: 100, cursor: page.nextCursor! });
    expect(calls[1]!.options?.query?.next_cursor).toBe("MjUw");
  });
});

describe("Polymarket fixtures — incomplete metadata (Req 1.5)", () => {
  it("returns available fields and explicit nulls for missing ones, never failing", async () => {
    const { http } = makeFixtureHttp([
      {
        match: "/markets",
        body: loadFixture("gamma-markets-incomplete.json"),
      },
    ]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });
    // The request did not fail despite missing optional fields.
    expect(page.items).toHaveLength(2);

    const [noMetrics, partial] = page.items;
    // First market has no volume/liquidity/spread/resolution fields at all.
    expect(noMetrics!.externalId).toBe("990001");
    expect(noMetrics!.volume24h).toBeNull();
    expect(noMetrics!.liquidity).toBeNull();
    expect(noMetrics!.spread).toBeNull();
    expect(noMetrics!.resolutionCriteria.dataSource).toBeNull();
    expect(noMetrics!.resolutionCriteria.cutoffTime).toBeNull();
    // raw is always present (object), even when empty.
    expect(noMetrics!.resolutionCriteria.raw).toEqual({});
    // Outcomes still normalized.
    expect(noMetrics!.outcomes[0]?.impliedProb).toBeCloseTo(0.55, 6);

    // Second market: only a single outcome price present (truncated array).
    expect(partial!.externalId).toBe("990002");
    expect(partial!.volume24h).toBeCloseTo(12.5, 6);
    expect(partial!.liquidity).toBeNull();
    // Yes price present; the missing No price is represented explicitly as null.
    expect(partial!.outcomes[0]?.impliedProb).toBeCloseTo(0.1, 6);
    expect(partial!.outcomes[1]?.impliedProb).toBeNull();
  });
});

describe("Polymarket fixtures — Gamma /events normalization & end-of-stream", () => {
  it("normalizes a recorded events page and treats the sentinel cursor as end-of-stream", async () => {
    const { http } = makeFixtureHttp([
      { match: "/events", body: loadFixture("gamma-events-page.json") },
    ]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchEvents({ limit: 100 });

    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.externalId).toBe("12345");
    expect(page.items[0]?.title).toBe("Bitcoin Price Predictions 2025");
    expect(page.items[0]?.category).toBe("crypto");
    expect(page.items[0]?.endDate).toBe("2025-12-31T23:59:59.000Z");
    expect(page.items[1]?.category).toBe("economics");

    // The recorded page's next_cursor is the "LTE=" sentinel → end of stream.
    expect(page.nextCursor).toBeNull();
  });
});

describe("Polymarket fixtures — CLOB price / history / depth (Req 1.1, 4.2, 4.3)", () => {
  it("maps the recorded /price snapshot to a Yes implied probability", async () => {
    const { http } = makeFixtureHttp([{ match: "/price", body: loadFixture("clob-price.json") }]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const snaps = await adapter.fetchPriceSnapshot(["token-yes"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.outcomeLabel).toBe("Yes");
    expect(snaps[0]?.price).toBeCloseTo(0.38, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });

  it("maps the recorded /prices-history payload into an ascending series", async () => {
    const { http } = makeFixtureHttp([
      {
        match: "/prices-history",
        body: loadFixture("clob-prices-history.json"),
      },
    ]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const points = await adapter.fetchPriceHistory("token-yes", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
      interval: "1h",
    });

    expect(points).toHaveLength(4);
    expect(points.map((p) => p.price)).toEqual([0.31, 0.33, 0.36, 0.38]);
    // Epoch-seconds timestamps were normalized to ISO.
    expect(points[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });

  it("maps the recorded /book payload into normalized depth (Req 4.3)", async () => {
    const { http } = makeFixtureHttp([{ match: "/book", body: loadFixture("clob-book.json") }]);
    const adapter = new PolymarketAdapter({ http, now: () => FIXED_NOW });

    const depth = await adapter.fetchOrderBookDepth("token-yes");
    expect(depth?.tokenId).toBe(
      "71291837465019283746501928374650192837465019283746501928374650192",
    );
    expect(depth?.bids).toHaveLength(3);
    expect(depth?.bids[0]).toEqual({ price: 0.37, size: 1500 });
    expect(depth?.asks[0]).toEqual({ price: 0.39, size: 1200 });
  });
});

describe("Polymarket fixtures — WebSocket market tick (Req 1.1)", () => {
  it("normalizes a recorded market-channel frame into a price tick", () => {
    let socket: FakeWebSocket | undefined;
    const factory: WebSocketFactory = (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    };
    const adapter = new PolymarketAdapter({
      webSocketFactory: factory,
      now: () => FIXED_NOW,
    });

    const ticks: NormalizedPriceSnapshot[] = [];
    adapter.subscribePrices(["token-yes"], (t) => ticks.push(t));
    socket!.emitOpen();

    // Replay the recorded WS frame verbatim (delivered as a JSON text frame).
    socket!.emitMessage(JSON.stringify(loadFixture("ws-market-tick.json")));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.marketExternalId).toBe(
      "71291837465019283746501928374650192837465019283746501928374650192",
    );
    expect(ticks[0]?.outcomeLabel).toBe("Yes");
    expect(ticks[0]?.price).toBeCloseTo(0.39, 6);
    // The frame carried its own epoch-seconds timestamp → normalized to ISO.
    expect(ticks[0]?.ts).toBe("2025-01-01T04:00:00.000Z");
  });
});
