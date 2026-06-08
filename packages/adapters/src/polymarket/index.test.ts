import { describe, it, expect, vi } from "vitest";
import type { NormalizedPriceSnapshot } from "@pma/core";
import { PolymarketAdapter, POLYMARKET_KEY } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";
import { FakeWebSocket, type WebSocketFactory } from "./socket.js";

/**
 * Unit tests for the {@link PolymarketAdapter} with INJECTED fakes — no real
 * network or sockets are used. They exercise keyset pagination, normalization
 * (binary Yes/No → outcomes, Yes price as implied probability), raw-criteria
 * preservation, price snapshot/history/depth, and the subscription lifecycle.
 */

/** A recorded HTTP response. */
interface RecordedResponse {
  ok?: boolean;
  status?: number;
  body: unknown;
}

/**
 * Build a fake {@link HttpClient} that returns recorded responses by matching a
 * substring of the requested URL (path). Records the calls it received so tests
 * can assert query parameters.
 */
function makeFakeHttp(routes: Array<{ match: string; response: RecordedResponse }>): {
  http: HttpClient;
  calls: Array<{ url: string; options?: HttpGetOptions }>;
} {
  const calls: Array<{ url: string; options?: HttpGetOptions }> = [];
  const http: HttpClient = {
    get(url: string, options?: HttpGetOptions): Promise<HttpResponse> {
      calls.push({ url, options });
      const route = routes.find((r) => url.includes(r.match));
      const rec: RecordedResponse = route?.response ?? {
        ok: false,
        status: 404,
        body: null,
      };
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

describe("PolymarketAdapter — meta & capabilities", () => {
  it("declares the polymarket meta (onchain / USDC)", () => {
    const adapter = new PolymarketAdapter();
    expect(adapter.meta.key).toBe(POLYMARKET_KEY);
    expect(adapter.meta.type).toBe("onchain");
    expect(adapter.meta.baseCurrency).toBe("USDC");
    expect(adapter.meta.name).toBe("Polymarket");
  });

  it("accepts an injected resolved source id", () => {
    const adapter = new PolymarketAdapter({ sourceId: "src-uuid" });
    expect(adapter.meta.id).toBe("src-uuid");
  });

  it("declares all capabilities true", () => {
    const caps = new PolymarketAdapter().capabilities();
    expect(caps).toEqual({
      websocketPrices: true,
      priceHistory: true,
      orderBookDepth: true,
      keysetPagination: true,
    });
  });

  it("exposes subscribePrices (capability-gated optional present)", () => {
    const adapter = new PolymarketAdapter();
    expect(typeof adapter.subscribePrices).toBe("function");
  });
});

describe("PolymarketAdapter.fetchMarkets", () => {
  it("maps a Gamma array response into normalized markets", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/markets",
        response: {
          body: [
            {
              id: "0x1",
              question: "Will X happen?",
              eventId: "evt-1",
              active: true,
              closed: false,
              volume24hr: "1000",
              liquidity: "500",
              spread: "0.03",
              outcomes: JSON.stringify(["Yes", "No"]),
              outcomePrices: JSON.stringify(["0.6", "0.4"]),
              clobTokenIds: JSON.stringify(["t-yes", "t-no"]),
              resolutionSource: "UMA",
              endDate: "2025-06-01T00:00:00Z",
            },
          ],
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });

    const page = await adapter.fetchMarkets({ limit: 50 });

    expect(page.items).toHaveLength(1);
    const market = page.items[0]!;
    expect(market.externalId).toBe("0x1");
    expect(market.eventExternalId).toBe("evt-1");
    expect(market.status).toBe("open");
    expect(market.outcomes[0]?.label).toBe("Yes");
    expect(market.outcomes[0]?.impliedProb).toBeCloseTo(0.6, 6);
    expect(market.outcomes[0]?.tokenId).toBe("t-yes");
    // Raw resolution criteria preserved (Req 10.3).
    expect(market.resolutionCriteria.dataSource).toBe("UMA");
    expect(market.resolutionCriteria.raw).toMatchObject({
      resolutionSource: "UMA",
    });
  });

  it("paginates via offset when no native cursor is returned", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/markets",
        // Full page (== limit) implies another page may exist.
        response: {
          body: Array.from({ length: 2 }, (_, i) => ({
            id: `m${i}`,
            question: "Q",
            outcomes: JSON.stringify(["Yes", "No"]),
            outcomePrices: JSON.stringify(["0.5", "0.5"]),
          })),
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });

    const first = await adapter.fetchMarkets({ limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    // Round-trip the cursor into a second request and assert offset advanced.
    await adapter.fetchMarkets({ limit: 2, cursor: first.nextCursor! });
    const secondCall = calls[1]!;
    expect(secondCall.options?.query?.offset).toBe(2);
  });

  it("returns a null cursor on a short page (end of stream)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/markets",
        response: { body: [{ id: "only", question: "Q" }] },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it("uses a native keyset cursor when the response provides one", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/markets",
        response: {
          body: {
            data: [{ id: "m1", question: "Q" }],
            next_cursor: "server-next",
          },
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });

    const page = await adapter.fetchMarkets({ limit: 1 });
    expect(page.nextCursor).not.toBeNull();

    await adapter.fetchMarkets({ limit: 1, cursor: page.nextCursor! });
    expect(calls[1]!.options?.query?.next_cursor).toBe("server-next");
  });

  it("yields an empty page on a non-OK response (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/markets", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("passes updatedSince through for incremental sync", async () => {
    const { http, calls } = makeFakeHttp([{ match: "/markets", response: { body: [] } }]);
    const adapter = new PolymarketAdapter({ http });
    await adapter.fetchMarkets({ limit: 10, updatedSince: "2025-01-01T00:00:00Z" });
    expect(calls[0]!.options?.query?.start_date_min).toBe("2025-01-01T00:00:00Z");
  });
});

describe("PolymarketAdapter.fetchEvents", () => {
  it("maps a Gamma events response into normalized events", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/events",
        response: {
          body: [
            {
              id: "evt-1",
              title: "Election 2024",
              endDate: "2024-11-05T00:00:00Z",
              tags: [{ label: "Politics" }],
            },
          ],
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const page = await adapter.fetchEvents({ limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.externalId).toBe("evt-1");
    expect(page.items[0]?.category).toBe("politics");
  });
});

describe("PolymarketAdapter.fetchPriceSnapshot", () => {
  it("fetches the Yes-token price for each token id", async () => {
    const { http, calls } = makeFakeHttp([
      { match: "/price", response: { body: { price: "0.71" } } },
    ]);
    const adapter = new PolymarketAdapter({
      http,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    const snaps = await adapter.fetchPriceSnapshot(["t-yes"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.marketExternalId).toBe("t-yes");
    expect(snaps[0]?.price).toBeCloseTo(0.71, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
    expect(calls[0]!.options?.query?.token_id).toBe("t-yes");
  });

  it("skips tokens whose price cannot be read (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/price", response: { ok: false, status: 404, body: null } },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const snaps = await adapter.fetchPriceSnapshot(["t-bad"]);
    expect(snaps).toEqual([]);
  });

  it("ignores empty token ids", async () => {
    const { http, calls } = makeFakeHttp([
      { match: "/price", response: { body: { price: "0.5" } } },
    ]);
    const adapter = new PolymarketAdapter({ http });
    await adapter.fetchPriceSnapshot(["", "   "]);
    expect(calls).toHaveLength(0);
  });
});

describe("PolymarketAdapter.fetchPriceHistory", () => {
  it("maps the CLOB prices-history payload", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/prices-history",
        response: {
          body: {
            history: [
              { t: 1700000000, p: "0.4" },
              { t: 1700003600, p: "0.45" },
            ],
          },
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });

    const points = await adapter.fetchPriceHistory("t-yes", {
      from: "2023-11-14T00:00:00Z",
      to: "2023-11-15T00:00:00Z",
      interval: "1h",
    });

    expect(points).toHaveLength(2);
    expect(points[0]?.price).toBeCloseTo(0.4, 6);
    expect(calls[0]!.options?.query?.market).toBe("t-yes");
    expect(calls[0]!.options?.query?.fidelity).toBe(60);
  });

  it("returns an empty series on failure (never throws)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/prices-history",
        response: { ok: false, status: 500, body: null },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const points = await adapter.fetchPriceHistory("t", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
    });
    expect(points).toEqual([]);
  });
});

describe("PolymarketAdapter.fetchOrderBookDepth", () => {
  it("maps the CLOB book payload (Req 4.3)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/book",
        response: {
          body: {
            asset_id: "t-yes",
            bids: [{ price: "0.5", size: "100" }],
            asks: [{ price: "0.52", size: "80" }],
          },
        },
      },
    ]);
    const adapter = new PolymarketAdapter({ http });
    const depth = await adapter.fetchOrderBookDepth("t-yes");
    expect(depth?.tokenId).toBe("t-yes");
    expect(depth?.bids[0]).toEqual({ price: 0.5, size: 100 });
    expect(depth?.asks[0]).toEqual({ price: 0.52, size: 80 });
  });

  it("returns null on failure", async () => {
    const { http } = makeFakeHttp([
      { match: "/book", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new PolymarketAdapter({ http });
    expect(await adapter.fetchOrderBookDepth("t")).toBeNull();
  });
});

describe("PolymarketAdapter.subscribePrices — lifecycle", () => {
  function setup() {
    let socket: FakeWebSocket | undefined;
    const factory: WebSocketFactory = (url) => {
      socket = new FakeWebSocket(url);
      return socket;
    };
    const adapter = new PolymarketAdapter({
      webSocketFactory: factory,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });
    return { adapter, getSocket: () => socket };
  }

  it("opens, sends the subscription frame, and reports isOpen", () => {
    const { adapter, getSocket } = setup();
    const ticks: NormalizedPriceSnapshot[] = [];

    const sub = adapter.subscribePrices(["t-yes", "t-no"], (t) => ticks.push(t));
    const socket = getSocket()!;

    expect(sub.isOpen).toBe(false);
    socket.emitOpen();
    expect(sub.isOpen).toBe(true);

    expect(socket.sent).toHaveLength(1);
    const frame = JSON.parse(socket.sent[0]!);
    expect(frame).toEqual({ type: "market", assets_ids: ["t-yes", "t-no"] });
  });

  it("dispatches normalized ticks from inbound frames", () => {
    const { adapter, getSocket } = setup();
    const ticks: NormalizedPriceSnapshot[] = [];

    adapter.subscribePrices(["t-yes"], (t) => ticks.push(t));
    const socket = getSocket()!;
    socket.emitOpen();

    socket.emitMessage(JSON.stringify([{ asset_id: "t-yes", price: "0.66" }]));

    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.marketExternalId).toBe("t-yes");
    expect(ticks[0]?.price).toBeCloseTo(0.66, 6);
    expect(ticks[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
  });

  it("ignores malformed frames without throwing", () => {
    const { adapter, getSocket } = setup();
    const ticks: NormalizedPriceSnapshot[] = [];
    adapter.subscribePrices(["t-yes"], (t) => ticks.push(t));
    const socket = getSocket()!;
    socket.emitOpen();

    expect(() => socket.emitMessage("not json {")).not.toThrow();
    expect(() => socket.emitMessage(JSON.stringify({ no: "asset" }))).not.toThrow();
    expect(ticks).toEqual([]);
  });

  it("closes the socket and reports not open after close()", () => {
    const { adapter, getSocket } = setup();
    const sub = adapter.subscribePrices(["t-yes"], () => undefined);
    const socket = getSocket()!;
    socket.emitOpen();
    expect(sub.isOpen).toBe(true);

    sub.close();
    expect(socket.closed).toBe(true);
    expect(sub.isOpen).toBe(false);
  });

  it("marks not open when the socket emits close/error", () => {
    const { adapter, getSocket } = setup();
    const sub = adapter.subscribePrices(["t-yes"], () => undefined);
    const socket = getSocket()!;
    socket.emitOpen();
    expect(sub.isOpen).toBe(true);

    socket.emitError(new Error("boom"));
    expect(sub.isOpen).toBe(false);
  });

  it("a throwing handler does not tear down the stream", () => {
    const { adapter, getSocket } = setup();
    const handler = vi.fn(() => {
      throw new Error("handler boom");
    });
    adapter.subscribePrices(["t-yes"], handler);
    const socket = getSocket()!;
    socket.emitOpen();

    expect(() =>
      socket.emitMessage(JSON.stringify({ asset_id: "t-yes", price: "0.5" })),
    ).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("throws when subscribePrices is used without a WebSocket factory", () => {
    const adapter = new PolymarketAdapter();
    expect(() => adapter.subscribePrices(["t"], () => undefined)).toThrow(/webSocketFactory/);
  });
});
