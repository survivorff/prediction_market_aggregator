import { describe, it, expect } from "vitest";
import type { MarketSource } from "@pma/core";
import { ManifoldAdapter, MANIFOLD_KEY } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";

/**
 * Unit tests for the {@link ManifoldAdapter} with an INJECTED fake HTTP client —
 * no real network is used. They exercise keyset (`before`) pagination,
 * normalization (binary `probability` → Yes outcome), raw-criteria
 * preservation, price-history mapping from `/v0/bets`, and the REST-only
 * capability contract: `websocketPrices === false` and `subscribePrices`
 * absent (Requirement 8.3).
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

describe("ManifoldAdapter — meta & capabilities", () => {
  it("declares the manifold meta (onchain / MANA)", () => {
    const adapter = new ManifoldAdapter();
    expect(adapter.meta.key).toBe(MANIFOLD_KEY);
    expect(adapter.meta.type).toBe("onchain");
    expect(adapter.meta.baseCurrency).toBe("MANA");
    expect(adapter.meta.name).toBe("Manifold");
  });

  it("accepts an injected resolved source id", () => {
    const adapter = new ManifoldAdapter({ sourceId: "src-uuid" });
    expect(adapter.meta.id).toBe("src-uuid");
  });

  it("declares websocketPrices FALSE and orderBookDepth false (Req 8.2)", () => {
    const caps = new ManifoldAdapter().capabilities();
    expect(caps).toEqual({
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: false,
      keysetPagination: true,
    });
  });

  it("does NOT expose subscribePrices (Req 8.3 — gated optional absent)", () => {
    const adapter = new ManifoldAdapter();
    // Typed as the port: the orchestrator checks for the optional method.
    const asSource: MarketSource = adapter;
    expect(asSource.subscribePrices).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>).subscribePrices).toBeUndefined();
  });
});

describe("ManifoldAdapter.fetchEvents", () => {
  it("returns an empty, terminal page (Manifold has no event resource)", async () => {
    const { http, calls } = makeFakeHttp([]);
    const adapter = new ManifoldAdapter({ http });
    const page = await adapter.fetchEvents({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // No HTTP call is made — events are derived from market group slugs.
    expect(calls).toHaveLength(0);
  });
});

describe("ManifoldAdapter.fetchMarkets", () => {
  it("maps a Manifold contracts response into normalized markets", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v0/markets",
        response: {
          body: [
            {
              id: "contract-1",
              question: "Will X happen?",
              probability: 0.6,
              closeTime: Date.parse("2025-06-01T00:00:00Z"),
              volume24Hours: 1000,
              totalLiquidity: 500,
              isResolved: false,
              outcomeType: "BINARY",
              groupSlugs: ["crypto"],
            },
          ],
        },
      },
    ]);
    // Fixed clock so the future closeTime resolves to "open" deterministically.
    const adapter = new ManifoldAdapter({
      http,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    const page = await adapter.fetchMarkets({ limit: 50 });

    expect(page.items).toHaveLength(1);
    const market = page.items[0]!;
    expect(market.externalId).toBe("contract-1");
    expect(market.eventExternalId).toBe("crypto");
    expect(market.status).toBe("open");
    expect(market.outcomes[0]?.label).toBe("Yes");
    expect(market.outcomes[0]?.impliedProb).toBeCloseTo(0.6, 6);
    expect(market.outcomes[0]?.tokenId).toBeNull();
    // Raw resolution criteria preserved (Req 10.3).
    expect(market.resolutionCriteria.raw).toMatchObject({
      outcomeType: "BINARY",
    });
    // Start page sends only limit (no before).
    expect(calls[0]!.options?.query?.limit).toBe(50);
    expect(calls[0]!.options?.query?.before).toBeUndefined();
  });

  it("paginates via the before keyset cursor", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v0/markets",
        // Full page (== limit) implies another page may exist.
        response: {
          body: [
            { id: "c1", question: "Q", probability: 0.5 },
            { id: "c2", question: "Q", probability: 0.5 },
          ],
        },
      },
    ]);
    const adapter = new ManifoldAdapter({ http });

    const first = await adapter.fetchMarkets({ limit: 2 });
    expect(first.nextCursor).not.toBeNull();

    // Round-trip the cursor into a second request and assert `before` = last id.
    await adapter.fetchMarkets({ limit: 2, cursor: first.nextCursor! });
    expect(calls[1]!.options?.query?.before).toBe("c2");
  });

  it("returns a null cursor on a short page (end of stream)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/v0/markets",
        response: { body: [{ id: "only", question: "Q", probability: 0.5 }] },
      },
    ]);
    const adapter = new ManifoldAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  it("yields an empty page on a non-OK response (never throws)", async () => {
    const { http } = makeFakeHttp([
      {
        match: "/v0/markets",
        response: { ok: false, status: 500, body: null },
      },
    ]);
    const adapter = new ManifoldAdapter({ http });
    const page = await adapter.fetchMarkets({ limit: 50 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("ManifoldAdapter.fetchPriceSnapshot", () => {
  it("derives the Yes price from each contract's probability", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v0/market/",
        response: { body: { id: "contract-1", probability: 0.71 } },
      },
    ]);
    const adapter = new ManifoldAdapter({
      http,
      now: () => new Date("2025-01-01T00:00:00.000Z"),
    });

    const snaps = await adapter.fetchPriceSnapshot(["contract-1"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.marketExternalId).toBe("contract-1");
    expect(snaps[0]?.outcomeLabel).toBe("Yes");
    expect(snaps[0]?.price).toBeCloseTo(0.71, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
    expect(calls[0]!.url).toContain("/v0/market/contract-1");
  });

  it("skips contracts that cannot be read and empty ids (never throws)", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v0/market/",
        response: { ok: false, status: 404, body: null },
      },
    ]);
    const adapter = new ManifoldAdapter({ http });
    const snaps = await adapter.fetchPriceSnapshot(["bad", "", "   "]);
    expect(snaps).toEqual([]);
    // Only the non-empty id triggers a request.
    expect(calls).toHaveLength(1);
  });
});

describe("ManifoldAdapter.fetchPriceHistory", () => {
  it("maps /v0/bets into an ascending Yes price series within range", async () => {
    const { http, calls } = makeFakeHttp([
      {
        match: "/v0/bets",
        response: {
          // Newest-first, as Manifold returns; includes one out-of-range point.
          body: [
            { probAfter: 0.6, createdTime: Date.parse("2023-11-14T01:00:00Z") },
            { probAfter: 0.5, createdTime: Date.parse("2023-11-14T00:00:00Z") },
            {
              probAfter: 0.9,
              createdTime: Date.parse("2023-12-01T00:00:00Z"), // out of range
            },
          ],
        },
      },
    ]);
    const adapter = new ManifoldAdapter({ http });

    const points = await adapter.fetchPriceHistory("contract-1", {
      from: "2023-11-14T00:00:00Z",
      to: "2023-11-15T00:00:00Z",
      interval: "1h",
    });

    expect(points).toHaveLength(2);
    expect(points[0]?.price).toBeCloseTo(0.5, 6);
    expect(points[1]?.price).toBeCloseTo(0.6, 6);
    expect(points[0]?.outcomeLabel).toBe("Yes");
    expect(calls[0]!.options?.query?.contractId).toBe("contract-1");
  });

  it("returns an empty series on failure (never throws)", async () => {
    const { http } = makeFakeHttp([
      { match: "/v0/bets", response: { ok: false, status: 500, body: null } },
    ]);
    const adapter = new ManifoldAdapter({ http });
    const points = await adapter.fetchPriceHistory("contract-1", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
    });
    expect(points).toEqual([]);
  });
});
