/**
 * HTTP-level tests for the gateway hardening added in task 7.5 (Requirements
 * 9.3, 9.4), exercised through Fastify `inject` (no port binding, no infra):
 *
 *   - Unified rate limiting (9.3): a single per-client policy across the public
 *     read endpoints; exceeding it yields 429 + `x-ratelimit-*` / `retry-after`
 *     headers and a stable error body. The limit is shared ACROSS endpoints
 *     (keyed by client IP), not per-route.
 *   - Input validation coverage (9.3): every public read endpoint rejects bad
 *     input with 400 (the unified `ValidationError` → 400 mapping).
 *   - Authentication (9.4): `requireAuth` enforces auth on a representative
 *     user-scoped route — 401 with no/invalid token, 200 with a valid injected
 *     identity — and is safe-by-default closed when no authenticator is wired.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";
import { requireAuth, bearerAuthenticator, type Authenticator } from "./auth.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeDiscoveryReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  FakeCanonicalEventReader,
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

function buildDeps(markets: FakeMarket[], extra: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    discovery: new FakeDiscoveryReader(markets),
    outcomes: new FakeOutcomeReader(markets),
    prices: new FakePriceHistoryReader(markets),
    sources: new FakeSourceReader([
      { id: "s1", key: "polymarket", name: "Polymarket", type: "onchain", baseCurrency: "USDC" },
    ]),
    canonicalEvents: new FakeCanonicalEventReader([]),
    now: () => NOW,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Unified rate limiting (Requirement 9.3).
// ---------------------------------------------------------------------------

describe("unified rate limiting (Req 9.3)", () => {
  it("returns 429 with headers + a stable body once a low limit is exceeded", async () => {
    app = createServer(buildDeps([makeFakeMarket({ id: MARKET_ID })]), {
      rateLimit: { max: 3, timeWindow: 60_000 },
    });

    // First 3 requests succeed.
    for (let i = 0; i < 3; i++) {
      const ok = await app.inject({ method: "GET", url: "/api/markets" });
      expect(ok.statusCode).toBe(200);
    }

    // 4th request is rate limited.
    const limited = await app.inject({ method: "GET", url: "/api/markets" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
    // Standard rate-limit headers are present.
    expect(limited.headers["x-ratelimit-limit"]).toBeDefined();
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("applies the limit UNIFORMLY across different public endpoints (shared client key)", async () => {
    app = createServer(buildDeps([makeFakeMarket({ id: MARKET_ID })]), {
      rateLimit: { max: 3, timeWindow: 60_000 },
    });

    // Spread the 3 allowed requests across three DIFFERENT endpoints...
    expect((await app.inject({ method: "GET", url: "/api/markets" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/sources" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/signals" })).statusCode).toBe(200);

    // ...the 4th request to yet another endpoint is rejected: the policy is
    // unified per client, not counted per route.
    const limited = await app.inject({ method: "GET", url: "/api/canonical-events" });
    expect(limited.statusCode).toBe(429);
  });

  it("does not rate-limit the /healthz liveness probe", async () => {
    app = createServer(buildDeps([]), { rateLimit: { max: 1, timeWindow: 60_000 } });
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("can be disabled entirely with rateLimit:false", async () => {
    app = createServer(buildDeps([makeFakeMarket({ id: MARKET_ID })]), { rateLimit: false });
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({ method: "GET", url: "/api/markets" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("uses a sensible default policy that does not trip for normal usage", async () => {
    app = createServer(buildDeps([makeFakeMarket({ id: MARKET_ID })]));
    const res = await app.inject({ method: "GET", url: "/api/markets" });
    expect(res.statusCode).toBe(200);
    // Default headers advertise the unified limit.
    expect(res.headers["x-ratelimit-limit"]).toBe("300");
  });
});

// ---------------------------------------------------------------------------
// Input validation coverage across ALL public read endpoints (Requirement 9.3).
// ---------------------------------------------------------------------------

describe("input validation coverage (Req 9.3)", () => {
  const badInputCases: Array<{ name: string; url: string; field?: string }> = [
    {
      name: "GET /api/markets — invalid category",
      url: "/api/markets?category=weather",
      field: "category",
    },
    {
      name: "GET /api/markets — invalid status",
      url: "/api/markets?status=bogus",
      field: "status",
    },
    {
      name: "GET /api/markets — out-of-range limit",
      url: "/api/markets?limit=9999",
      field: "limit",
    },
    {
      name: "GET /api/markets — non-integer offset",
      url: "/api/markets?offset=abc",
      field: "offset",
    },
    { name: "GET /api/markets/:id — non-UUID id", url: "/api/markets/not-a-uuid", field: "id" },
    {
      name: "GET /api/markets/:id/history — non-UUID id",
      url: "/api/markets/not-a-uuid/history",
      field: "id",
    },
    {
      name: "GET /api/markets/:id/history — from > to",
      url: `/api/markets/${MARKET_ID}/history?from=2025-02-01T00:00:00.000Z&to=2025-01-01T00:00:00.000Z`,
      field: "from",
    },
    {
      name: "GET /api/markets/:id/history — bad interval",
      url: `/api/markets/${MARKET_ID}/history?interval=7m`,
      field: "interval",
    },
    {
      name: "GET /api/markets/:id/trade-link — non-UUID id",
      url: "/api/markets/not-a-uuid/trade-link",
      field: "id",
    },
    {
      name: "GET /api/canonical-events — invalid category",
      url: "/api/canonical-events?category=weather",
      field: "category",
    },
    {
      name: "GET /api/canonical-events/:id — non-UUID id",
      url: "/api/canonical-events/not-a-uuid",
      field: "id",
    },
    { name: "GET /api/signals — out-of-range limit", url: "/api/signals?limit=0", field: "limit" },
  ];

  for (const { name, url, field } of badInputCases) {
    it(`rejects bad input with 400: ${name}`, async () => {
      app = createServer(buildDeps([makeFakeMarket({ id: MARKET_ID })]));
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      if (field) expect(res.json().error.field).toBe(field);
    });
  }
});

// ---------------------------------------------------------------------------
// Authentication on user-scoped resources (Requirement 9.4).
//
// Watchlist/alerts routes arrive in task 8; here we attach `requireAuth` to a
// representative protected route to prove the enforcement mechanism end-to-end
// through the real Fastify request + error path.
// ---------------------------------------------------------------------------

/** Build a server with a representative `GET /api/_protected` guarded by requireAuth. */
function buildWithProtectedRoute(authenticate: Authenticator | undefined): FastifyInstance {
  const deps = buildDeps([], authenticate ? { authenticate } : {});
  const server = createServer(deps, { rateLimit: false });
  server.register(async (instance) => {
    instance.get(
      "/api/_protected",
      { preHandler: requireAuth(deps.authenticate) },
      async (request) => ({ userId: request.user?.userId }),
    );
  });
  return server;
}

describe("authentication on user-scoped resources (Req 9.4)", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    app = buildWithProtectedRoute(async () => null);
    const res = await app.inject({ method: "GET", url: "/api/_protected" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for an invalid/expired token", async () => {
    const authenticate = bearerAuthenticator((token) =>
      token === "valid-token" ? { userId: "u-1" } : null,
    );
    app = buildWithProtectedRoute(authenticate);
    const res = await app.inject({
      method: "GET",
      url: "/api/_protected",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("passes with a valid injected identity and exposes request.user", async () => {
    const authenticate = bearerAuthenticator((token) =>
      token === "valid-token" ? { userId: "u-99" } : null,
    );
    app = buildWithProtectedRoute(authenticate);
    const res = await app.inject({
      method: "GET",
      url: "/api/_protected",
      headers: { authorization: "Bearer valid-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: "u-99" });
  });

  it("is safe-by-default CLOSED: 401 when no authenticator is configured", async () => {
    app = buildWithProtectedRoute(undefined);
    const res = await app.inject({
      method: "GET",
      url: "/api/_protected",
      headers: { authorization: "Bearer anything" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("does NOT require auth on public read endpoints (they stay open)", async () => {
    app = buildWithProtectedRoute(undefined);
    const res = await app.inject({ method: "GET", url: "/api/markets" });
    expect(res.statusCode).toBe(200);
  });
});
