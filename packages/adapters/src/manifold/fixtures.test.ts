import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ManifoldAdapter } from "./index.js";
import type { HttpClient, HttpGetOptions, HttpResponse } from "./http.js";
import { decodeCursor } from "./cursor.js";

/**
 * Recorded-fixture normalization tests for the Manifold adapter (task 4.4).
 *
 * These feed RECORDED Manifold REST payloads — stored as standalone `.json`
 * files under `./__fixtures__/` — through the adapter via an injected fake HTTP
 * client. They assert:
 *
 * - the resulting normalized entities are correct (Requirement 1.1 — unified
 *   discovery shape: a binary contract's `probability` → Yes implied
 *   probability, 24h volume, liquidity, status, off-chain `tokenId === null`,
 *   raw resolution criteria preserved);
 * - incomplete upstream metadata is represented EXPLICITLY as `null` and never
 *   fails the request (Requirement 1.5);
 * - the opaque `before` keyset cursor round-trips back into the correct
 *   upstream query parameter, and end-of-stream yields `null`.
 *
 * The HTTP transport is injected, so no real network is used. A fixed clock is
 * injected so status derivation (open vs closed) is deterministic.
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

describe("Manifold fixtures — /v0/markets normalization (Req 1.1)", () => {
  it("normalizes a recorded contracts page into NormalizedMarket entities", async () => {
    const { http } = makeFixtureHttp([
      { match: "/v0/markets", body: loadFixture("markets-page.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });

    expect(page.items).toHaveLength(2);
    const [btc, fed] = page.items;

    // First contract: open binary market with full metadata.
    expect(btc!.externalId).toBe("kj3h2g1f0e9d");
    expect(btc!.question).toBe("Will Bitcoin reach $150,000 by the end of 2025?");
    // Grouped by its first group slug (Manifold has no event resource).
    expect(btc!.eventExternalId).toBe("crypto");
    expect(btc!.status).toBe("open");
    expect(btc!.volume24h).toBeCloseTo(1320.5, 4);
    expect(btc!.liquidity).toBeCloseTo(2854.7, 4);

    // Binary `probability` → Yes implied probability; No is the complement.
    expect(btc!.outcomes).toHaveLength(2);
    expect(btc!.outcomes[0]?.label).toBe("Yes");
    expect(btc!.outcomes[0]?.impliedProb).toBeCloseTo(0.42, 6);
    expect(btc!.outcomes[1]?.label).toBe("No");
    expect(btc!.outcomes[1]?.impliedProb).toBeCloseTo(0.58, 6);
    const sum = (btc!.outcomes[0]?.impliedProb ?? 0) + (btc!.outcomes[1]?.impliedProb ?? 0);
    expect(sum).toBeCloseTo(1, 6);
    // Manifold is off-chain → no outcome token ids.
    expect(btc!.outcomes[0]?.tokenId).toBeNull();
    expect(btc!.outcomes[1]?.tokenId).toBeNull();

    // Raw resolution criteria preserved for auditability (Req 10.3); Manifold
    // settles by creator resolution so there is no external data source.
    expect(btc!.resolutionCriteria.dataSource).toBeNull();
    expect(btc!.resolutionCriteria.cutoffTime).toBe("2025-12-31T23:59:59.000Z");
    expect(btc!.resolutionCriteria.raw).toMatchObject({
      outcomeType: "BINARY",
      mechanism: "cpmm-1",
    });

    // Second contract: resolved by the creator.
    expect(fed!.externalId).toBe("zz9y8x7w6v5u");
    expect(fed!.status).toBe("resolved");
    expect(fed!.eventExternalId).toBe("economics");
    expect(fed!.outcomes[0]?.impliedProb).toBeCloseTo(0.88, 6);
  });

  it("round-trips the `before` keyset cursor into the next upstream query", async () => {
    const { http, calls } = makeFixtureHttp([
      { match: "/v0/markets", body: loadFixture("markets-page.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    // A full page (== limit) implies another page may exist; the cursor is the
    // id of the last contract on the page.
    const page = await adapter.fetchMarkets({ limit: 2 });
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor!)).toEqual({ before: "zz9y8x7w6v5u" });

    // The start page sends only `limit` (no `before`).
    expect(calls[0]!.options?.query?.before).toBeUndefined();

    // Feeding the cursor back produces a request carrying `before=<lastId>`.
    await adapter.fetchMarkets({ limit: 2, cursor: page.nextCursor! });
    expect(calls[1]!.options?.query?.before).toBe("zz9y8x7w6v5u");
  });

  it("yields a null cursor at end-of-stream when a short page is returned", async () => {
    const { http } = makeFixtureHttp([
      { match: "/v0/markets", body: loadFixture("markets-page.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    // limit 100 > 2 items → short page → end of stream.
    const page = await adapter.fetchMarkets({ limit: 100 });
    expect(page.nextCursor).toBeNull();
  });
});

describe("Manifold fixtures — incomplete metadata (Req 1.5)", () => {
  it("returns available fields and explicit nulls for missing ones, never failing", async () => {
    const { http } = makeFixtureHttp([
      { match: "/v0/markets", body: loadFixture("markets-incomplete.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    const page = await adapter.fetchMarkets({ limit: 100 });
    // The request did not fail despite missing optional fields.
    expect(page.items).toHaveLength(2);

    const [minimal, multi] = page.items;
    // Minimal binary contract: only id/question/probability present.
    expect(minimal!.externalId).toBe("incomplete001");
    expect(minimal!.volume24h).toBeNull();
    expect(minimal!.liquidity).toBeNull();
    expect(minimal!.eventExternalId).toBeNull();
    expect(minimal!.resolutionCriteria.cutoffTime).toBeNull();
    expect(minimal!.outcomes[0]?.impliedProb).toBeCloseTo(0.5, 6);

    // Multi-answer contract: each answer maps to an outcome; volume missing.
    expect(multi!.externalId).toBe("incomplete002");
    expect(multi!.volume24h).toBeNull();
    expect(multi!.liquidity).toBeCloseTo(900, 6);
    expect(multi!.eventExternalId).toBe("technology");
    expect(multi!.outcomes).toHaveLength(3);
    expect(multi!.outcomes.map((o) => o.label)).toEqual(["Option A", "Option B", "Option C"]);
    expect(multi!.outcomes[1]?.impliedProb).toBeCloseTo(0.45, 6);
  });
});

describe("Manifold fixtures — /v0/market/{id} snapshot (Req 1.1)", () => {
  it("derives the Yes implied probability from a recorded contract", async () => {
    const { http, calls } = makeFixtureHttp([
      { match: "/v0/market/", body: loadFixture("market-by-id.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    const snaps = await adapter.fetchPriceSnapshot(["kj3h2g1f0e9d"]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.marketExternalId).toBe("kj3h2g1f0e9d");
    expect(snaps[0]?.outcomeLabel).toBe("Yes");
    expect(snaps[0]?.price).toBeCloseTo(0.42, 6);
    expect(snaps[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
    expect(calls[0]!.url).toContain("/v0/market/kj3h2g1f0e9d");
  });
});

describe("Manifold fixtures — /v0/bets price history (Req 4.2)", () => {
  it("maps recorded newest-first bets into an ascending Yes price series", async () => {
    const { http, calls } = makeFixtureHttp([
      { match: "/v0/bets", body: loadFixture("bets-page.json") },
    ]);
    const adapter = new ManifoldAdapter({ http, now: () => FIXED_NOW });

    const points = await adapter.fetchPriceHistory("kj3h2g1f0e9d", {
      from: "2025-01-01T00:00:00Z",
      to: "2025-01-02T00:00:00Z",
      interval: "1h",
    });

    // Sorted ascending by createdTime (Manifold returns bets newest-first).
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.price)).toEqual([0.41, 0.38, 0.4, 0.42]);
    expect(points[0]?.ts).toBe("2025-01-01T00:00:00.000Z");
    expect(points.every((p) => p.outcomeLabel === "Yes")).toBe(true);
    expect(calls[0]!.options?.query?.contractId).toBe("kj3h2g1f0e9d");
  });
});
