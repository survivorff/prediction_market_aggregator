import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  DEFAULT_API_BASE_URL,
  MissingTokenError,
  resolveApiBaseUrl,
  type FetchLike,
} from "./api-client";

const BASE = "https://api.example.test";

/** Build a fake fetch that records calls and returns a fixed JSON body. */
function fakeFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: string[] = [];
  const fn = vi.fn((url: string) => {
    calls.push(url);
    return Promise.resolve({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    });
  });
  return { fn: fn as unknown as FetchLike, calls };
}

describe("createApiClient — URL + query construction", () => {
  it("listMarkets with no filters hits /api/markets on the configured base only", async () => {
    const { fn, calls } = fakeFetch({ markets: [], paging: { limit: 0, offset: 0, count: 0 } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listMarkets();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BASE}/api/markets`);
  });

  it("listMarkets serializes all filters as query params", async () => {
    const { fn, calls } = fakeFetch({ markets: [], paging: { limit: 0, offset: 0, count: 0 } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listMarkets({
      category: "crypto",
      status: "open",
      q: "bitcoin",
      sort: "volume",
      order: "desc",
      limit: 25,
      offset: 50,
    });

    const url = new URL(calls[0]!);
    expect(url.origin).toBe(BASE);
    expect(url.pathname).toBe("/api/markets");
    expect(url.searchParams.get("category")).toBe("crypto");
    expect(url.searchParams.get("status")).toBe("open");
    expect(url.searchParams.get("q")).toBe("bitcoin");
    expect(url.searchParams.get("sort")).toBe("volume");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("50");
  });

  it("omits undefined and empty filter values from the query string", async () => {
    const { fn, calls } = fakeFetch({ markets: [], paging: { limit: 0, offset: 0, count: 0 } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listMarkets({ q: "   ", category: undefined, sort: "liquidity" });

    const url = new URL(calls[0]!);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("category")).toBe(false);
    expect(url.searchParams.get("sort")).toBe("liquidity");
  });

  it("getMarket encodes the id into the path", async () => {
    const { fn, calls } = fakeFetch({ id: "abc" });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.getMarket("a b/c");

    expect(calls[0]).toBe(`${BASE}/api/markets/a%20b%2Fc`);
  });

  it("getMarketHistory appends range + interval params", async () => {
    const { fn, calls } = fakeFetch({ marketId: "m1", range: {}, points: [] });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.getMarketHistory("m1", {
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-02T00:00:00.000Z",
      interval: "1h",
    });

    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/api/markets/m1/history");
    expect(url.searchParams.get("from")).toBe("2024-01-01T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2024-01-02T00:00:00.000Z");
    expect(url.searchParams.get("interval")).toBe("1h");
  });

  it("listSources and getTradeLink target the correct paths", async () => {
    const { fn, calls } = fakeFetch({ sources: [] });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listSources();
    await client.getTradeLink("m9");

    expect(calls[0]).toBe(`${BASE}/api/sources`);
    expect(calls[1]).toBe(`${BASE}/api/markets/m9/trade-link`);
  });

  it("listCanonicalEvents hits /api/canonical-events with no query when unfiltered", async () => {
    const { fn, calls } = fakeFetch({ canonicalEvents: [], filter: { category: null } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listCanonicalEvents();

    expect(calls[0]).toBe(`${BASE}/api/canonical-events`);
  });

  it("listCanonicalEvents serializes the category filter", async () => {
    const { fn, calls } = fakeFetch({ canonicalEvents: [], filter: { category: "crypto" } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listCanonicalEvents({ category: "crypto" });

    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/api/canonical-events");
    expect(url.searchParams.get("category")).toBe("crypto");
  });

  it("getCanonicalEvent encodes the id into the path", async () => {
    const { fn, calls } = fakeFetch({ canonicalEvent: {}, rows: [], maxSpread: null });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.getCanonicalEvent("ce 1/2");

    expect(calls[0]).toBe(`${BASE}/api/canonical-events/ce%201%2F2`);
  });

  it("listSignals hits /api/signals and appends the limit when provided", async () => {
    const { fn, calls } = fakeFetch({ signals: [], limit: 0 });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listSignals();
    await client.listSignals({ limit: 10 });

    expect(calls[0]).toBe(`${BASE}/api/signals`);
    const url = new URL(calls[1]!);
    expect(url.pathname).toBe("/api/signals");
    expect(url.searchParams.get("limit")).toBe("10");
  });
});

describe("createApiClient — Requirement 9.1 boundary", () => {
  it("every request targets ONLY the configured gateway base (no upstream hosts)", async () => {
    const { fn, calls } = fakeFetch({ markets: [], paging: { limit: 0, offset: 0, count: 0 } });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await client.listMarkets({ category: "crypto" });
    await client.getMarket("m1");
    await client.getMarketHistory("m1");
    await client.listSources();
    await client.getTradeLink("m1");
    await client.listCanonicalEvents({ category: "crypto" });
    await client.getCanonicalEvent("ce1");
    await client.listSignals({ limit: 5 });

    for (const url of calls) {
      expect(new URL(url).origin).toBe(BASE);
    }
    // Hard assertion: nothing ever points at an upstream platform.
    const joined = calls.join(" ");
    expect(joined).not.toMatch(/polymarket\.com/i);
    expect(joined).not.toMatch(/manifold/i);
    expect(joined).not.toMatch(/clob|gamma-api/i);
  });

  it("normalizes a trailing slash in the base URL", async () => {
    const { fn, calls } = fakeFetch({ sources: [] });
    const client = createApiClient({ baseUrl: `${BASE}/`, fetch: fn });

    await client.listSources();

    expect(calls[0]).toBe(`${BASE}/api/sources`);
  });
});

describe("createApiClient — error handling", () => {
  it("throws ApiError carrying status on a non-2xx response", async () => {
    const { fn } = fakeFetch({ error: "nope" }, { ok: false, status: 404 });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await expect(client.getMarket("missing")).rejects.toBeInstanceOf(ApiError);
    await expect(client.getMarket("missing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("resolveApiBaseUrl", () => {
  it("falls back to the localhost default when the env var is unset", () => {
    const prev = process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    try {
      expect(resolveApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
    } finally {
      if (prev !== undefined) process.env.NEXT_PUBLIC_API_BASE_URL = prev;
    }
  });

  it("uses NEXT_PUBLIC_API_BASE_URL when set", () => {
    const prev = process.env.NEXT_PUBLIC_API_BASE_URL;
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://gw.example.test";
    try {
      expect(resolveApiBaseUrl()).toBe("https://gw.example.test");
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
      else process.env.NEXT_PUBLIC_API_BASE_URL = prev;
    }
  });
});

describe("createApiClient — watchlist (user-scoped, Authorization header)", () => {
  /** A fake fetch that records url + init so we can assert method/headers/body. */
  function recordingFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
    const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
    const fn = vi.fn((url: string, reqInit?: Record<string, unknown>) => {
      calls.push({ url, init: reqInit });
      return Promise.resolve({
        ok: init?.ok ?? true,
        status: init?.status ?? 200,
        statusText: "OK",
        json: () => Promise.resolve(body),
      });
    });
    return { fn: fn as unknown as FetchLike, calls };
  }

  it("listWatchlist hits /api/watchlist with a Bearer token when configured", async () => {
    const { fn, calls } = recordingFetch({ items: [] });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "tok-123" });

    await client.listWatchlist();

    expect(calls[0]!.url).toBe(`${BASE}/api/watchlist`);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });

  it("addWatchlist POSTs the body as JSON with the Authorization header", async () => {
    const { fn, calls } = recordingFetch({
      id: "w1",
      targetType: "market",
      targetId: "m1",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "tok-abc" });

    const item = await client.addWatchlist({ targetType: "market", targetId: "m1" });

    expect(item.id).toBe("w1");
    expect(calls[0]!.url).toBe(`${BASE}/api/watchlist`);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ targetType: "market", targetId: "m1" }));
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-abc");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("addWatchlist of a duplicate target returns the existing item (idempotent, 200)", async () => {
    // The gateway returns the EXISTING item with 200 for a duplicate add.
    const existing = {
      id: "w-existing",
      targetType: "canonicalEvent",
      targetId: "ce1",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    const { fn } = recordingFetch(existing, { ok: true, status: 200 });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "tok" });

    const item = await client.addWatchlist({ targetType: "canonicalEvent", targetId: "ce1" });
    expect(item).toEqual(existing);
  });

  it("deleteWatchlist DELETEs the encoded item path with the Authorization header", async () => {
    const { fn, calls } = recordingFetch(undefined, { ok: true, status: 204 });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "tok" });

    await client.deleteWatchlist("a b/c");

    expect(calls[0]!.url).toBe(`${BASE}/api/watchlist/a%20b%2Fc`);
    expect(calls[0]!.init?.method).toBe("DELETE");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("throws MissingTokenError (without issuing a request) when no token is configured", async () => {
    const { fn, calls } = recordingFetch({ items: [] });
    const client = createApiClient({ baseUrl: BASE, fetch: fn });

    await expect(client.listWatchlist()).rejects.toBeInstanceOf(MissingTokenError);
    // No request was made — we fail fast instead of provoking a 401.
    expect(calls).toHaveLength(0);
    expect(client.hasToken()).toBe(false);
  });

  it("treats a blank token as no token (MissingTokenError)", async () => {
    const { fn, calls } = recordingFetch({ items: [] });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "   " });

    await expect(client.listWatchlist()).rejects.toBeInstanceOf(MissingTokenError);
    expect(calls).toHaveLength(0);
  });

  it("hasToken reflects the configured token resolver", () => {
    const { fn } = recordingFetch({ items: [] });
    expect(createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "x" }).hasToken()).toBe(
      true,
    );
    expect(createApiClient({ baseUrl: BASE, fetch: fn }).hasToken()).toBe(false);
  });

  it("every watchlist request targets ONLY the configured gateway base (Req 9.1)", async () => {
    const { fn, calls } = recordingFetch({
      id: "w1",
      targetType: "market",
      targetId: "m1",
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const client = createApiClient({ baseUrl: BASE, fetch: fn, getToken: () => "tok" });

    await client.listWatchlist();
    await client.addWatchlist({ targetType: "market", targetId: "m1" });
    await client.deleteWatchlist("m1");

    for (const { url } of calls) {
      expect(new URL(url).origin).toBe(BASE);
    }
    const joined = calls.map((c) => c.url).join(" ");
    expect(joined).not.toMatch(/polymarket\.com/i);
    expect(joined).not.toMatch(/manifold/i);
    expect(joined).not.toMatch(/clob|gamma-api/i);
  });
});
