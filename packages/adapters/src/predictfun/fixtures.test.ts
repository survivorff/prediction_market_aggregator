import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { PredictFunAdapter } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";
import { decodeCursor, cursorToQuery } from "./cursor.js";

/**
 * Recorded-fixture normalization tests for the Predict.fun adapter.
 *
 * Unlike the inline-payload unit tests in `index.test.ts`, these feed RECORDED
 * Predict.fun payloads — stored as standalone `.json` files under
 * `./__fixtures__/` — through the adapter via an injected fake HTTP client. They
 * assert:
 *
 * - the resulting normalized entities are correct (Requirement 1.1 — unified
 *   discovery shape: outcomes, status, raw resolution criteria);
 * - incomplete/malformed upstream metadata is represented EXPLICITLY as `null`
 *   and never fails the request (Requirement 1.5);
 * - the opaque cursor round-trips back into the upstream `cursor` query param;
 * - the order-book mid maps to a Yes implied probability (Req 1.1) and the
 *   `/timeseries` payload maps to an ascending Yes price series (Req 4.2).
 *
 * All transports are injected, so no real network is used. A fixed clock is
 * injected wherever a capture timestamp is involved (determinism).
 */

/** Load a recorded JSON fixture relative to this test file. */
function loadFixture(name: string): unknown {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

interface RecordedRoute {
  match: string;
  body: unknown;
  ok?: boolean;
  status?: number;
}

/** Build a fake {@link HttpClient} that replays recorded fixture bodies by URL substring. */
function makeFixtureHttp(routes: RecordedRoute[]): {
  http: HttpClient;
  calls: Array<{ url: string; options?: HttpGetOptions }>;
} {
  const calls: Array<{ url: string; options?: HttpGetOptions }> = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      const route = [...routes]
        .sort((a, b) => b.match.length - a.match.length)
        .find((r) => url.includes(r.match));
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

describe("Predict.fun fixtures — /v1/markets normalization (Req 1.1)", () => {
  it("normalizes a recorded markets page into NormalizedMarket entities", async () => {
    const { http } = makeFixtureHttp([
      { match: "/v1/markets", body: loadFixture("markets-page.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });

    expect(page.items).toHaveLength(2);
    const [btc, epl] = page.items;

    expect(btc!.externalId).toBe("472");
    expect(btc!.eventExternalId).toBe("btc-100k-2025");
    expect(btc!.question).toBe("Will BTC close above $100,000 in 2025?");
    expect(btc!.status).toBe("open");
    // Binary Yes/No outcomes with on-chain token ids; no price in metadata.
    expect(btc!.outcomes).toHaveLength(2);
    expect(btc!.outcomes[0]?.label).toBe("Yes");
    expect(btc!.outcomes[0]?.tokenId).toBe(
      "99687883996711364087088282638523080562700966541094159995494261186865075656885",
    );
    expect(btc!.outcomes[0]?.impliedProb).toBeNull();
    // Raw resolution criteria preserved for matching Layer 4 (Req 10.3).
    expect(btc!.resolutionCriteria.raw).toMatchObject({
      conditionId: "0xbcad63b00f19d2258f318615eedf2bab7ec5afbec1426d4497f8db19ce3e10f1",
      categorySlug: "btc-100k-2025",
      feeRateBps: 200,
    });

    // Second market: a resolved EPL market mirroring a Kalshi ticker. The
    // normalized market shape carries no category (it is denormalized onto the
    // market during ingestion, as with the Manifold adapter); the Kalshi ticker
    // is preserved in the raw criteria for matching Layer 4.
    expect(epl!.externalId).toBe("473");
    expect(epl!.status).toBe("resolved");
    expect(epl!.resolutionCriteria.raw).toMatchObject({ kalshiMarketTicker: "EPLCRY" });
  });

  it("round-trips the upstream cursor into the next request", async () => {
    const { http, calls } = makeFixtureHttp([
      { match: "/v1/markets", body: loadFixture("markets-page.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });
    // The recorded page carries cursor "NDcz" → a non-null opaque cursor.
    expect(page.nextCursor).toBe("NDcz");
    expect(decodeCursor(page.nextCursor!)).toEqual({ token: "NDcz" });
    expect(cursorToQuery(decodeCursor(page.nextCursor!), 100)).toEqual({
      cursor: "NDcz",
      limit: 100,
    });

    await adapter.fetchMarkets({ limit: 100, cursor: page.nextCursor! });
    expect(calls[1]!.options?.query?.cursor).toBe("NDcz");
  });
});

describe("Predict.fun fixtures — incomplete metadata (Req 1.5)", () => {
  it("returns available fields and explicit nulls for missing ones, never failing", async () => {
    const { http } = makeFixtureHttp([
      { match: "/v1/markets", body: loadFixture("markets-incomplete.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });
    expect(page.items).toHaveLength(2);
    const [bare, malformed] = page.items;

    expect(bare!.externalId).toBe("990001");
    expect(bare!.volume24h).toBeNull();
    expect(bare!.liquidity).toBeNull();
    expect(bare!.spread).toBeNull();
    expect(bare!.resolutionCriteria.raw).toEqual({});
    // No outcomes upstream → defaults to a binary Yes/No pair with null prices.
    expect(bare!.outcomes.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(bare!.outcomes[0]?.impliedProb).toBeNull();

    // A malformed (non-array) outcomes field also falls back to Yes/No.
    expect(malformed!.externalId).toBe("990002");
    expect(malformed!.outcomes.map((o) => o.label)).toEqual(["Yes", "No"]);
    // spreadThreshold supplied as a string is coerced.
    expect(malformed!.spread).toBeCloseTo(0.04, 6);
    // The page did not carry a cursor → end of stream.
    expect(page.nextCursor).toBeNull();
  });
});

describe("Predict.fun fixtures — orderbook / timeseries (Req 1.1, 4.2, 4.3)", () => {
  it("maps the recorded /orderbook mid into a Yes implied probability", async () => {
    const { http } = makeFixtureHttp([
      { match: "/orderbook", body: loadFixture("orderbook.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const snaps = await adapter.fetchPriceSnapshot(["472"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.outcomeLabel).toBe("Yes");
    // mid = (0.62 + 0.58) / 2 = 0.60
    expect(snaps[0]?.price).toBeCloseTo(0.6, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });

  it("maps the recorded /orderbook payload into normalized depth (Req 4.3)", async () => {
    const { http } = makeFixtureHttp([
      { match: "/orderbook", body: loadFixture("orderbook.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const depth = await adapter.fetchOrderBookDepth("472");
    expect(depth?.marketId).toBe("472");
    expect(depth?.asks).toHaveLength(2);
    expect(depth?.asks[0]).toEqual({ price: 0.62, size: 2.2894 });
    expect(depth?.bids[0]).toEqual({ price: 0.58, size: 4.0 });
  });

  it("maps the recorded /timeseries payload into an ascending series", async () => {
    const { http } = makeFixtureHttp([
      { match: "/timeseries", body: loadFixture("timeseries.json") },
    ]);
    const adapter = new PredictFunAdapter({ http, now: () => FIXED_NOW });

    const points = await adapter.fetchPriceHistory("472", {
      from: "2024-12-31T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
      interval: "1h",
    });

    expect(points).toHaveLength(4);
    expect(points.map((p) => p.price)).toEqual([0.31, 0.33, 0.36, 0.38]);
    // Epoch-seconds timestamps were normalized to ISO.
    expect(points[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });
});
