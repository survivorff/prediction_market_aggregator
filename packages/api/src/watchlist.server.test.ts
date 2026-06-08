/**
 * HTTP-level tests for the user-scoped watchlist routes (task 8.1), exercised
 * through Fastify `inject` (no port binding, no infra) with an injected fake
 * authenticator + fake watchlist store. Cover:
 *
 *   - 401 when unauthenticated (Requirement 9.4);
 *   - add/list/delete happy paths;
 *   - duplicate add is idempotent (same item, 200, no duplicate — Req 5.1);
 *   - 400 on a bad POST body;
 *   - 404 deleting an unknown / un-owned item (Req 5.4);
 *   - one user cannot see or delete another user's items (Req 9.4).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";
import { bearerAuthenticator, type Authenticator } from "./auth.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeDiscoveryReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  FakeWatchlistStore,
} from "./test-support.js";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TARGET_1 = "11111111-1111-1111-1111-111111111111";
const TARGET_2 = "22222222-2222-2222-2222-222222222222";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

/**
 * A bearer authenticator that maps tokens → user ids: `token-a` → USER_A,
 * `token-b` → USER_B, anything else → unauthenticated.
 */
const authenticate: Authenticator = bearerAuthenticator((token) => {
  if (token === "token-a") return { userId: USER_A };
  if (token === "token-b") return { userId: USER_B };
  return null;
});

function buildDeps(overrides: Partial<GatewayDeps> = {}): GatewayDeps {
  return {
    discovery: new FakeDiscoveryReader([]),
    outcomes: new FakeOutcomeReader([]),
    prices: new FakePriceHistoryReader([]),
    sources: new FakeSourceReader([]),
    watchlist: new FakeWatchlistStore(),
    authenticate,
    ...overrides,
  };
}

/** Build a server with rate limiting off (keeps the multi-request tests simple). */
function buildApp(overrides: Partial<GatewayDeps> = {}): FastifyInstance {
  return createServer(buildDeps(overrides), { rateLimit: false });
}

const authA = { authorization: "Bearer token-a" };
const authB = { authorization: "Bearer token-b" };

describe("watchlist routes — authentication (Req 9.4)", () => {
  it("GET /api/watchlist returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/watchlist" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("POST /api/watchlist returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/watchlist/:itemId returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/watchlist/${TARGET_1}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/watchlist",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is safe-by-default CLOSED: 401 when no authenticator is configured but a store is present", async () => {
    app = createServer(buildDeps({ authenticate: undefined }), { rateLimit: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/watchlist",
      headers: authA,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("watchlist routes — add/list/delete happy paths", () => {
  it("POST adds an item (200) and GET lists it for the same user", async () => {
    app = buildApp();

    const add = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    expect(add.statusCode).toBe(200);
    const created = add.json();
    expect(created).toMatchObject({ targetType: "market", targetId: TARGET_1 });
    expect(created.id).toBeTruthy();
    expect(created).not.toHaveProperty("userId");

    const list = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: { targetId: string }) => i.targetId)).toEqual([TARGET_1]);
  });

  it("accepts the canonicalEvent target type", async () => {
    app = buildApp();
    const add = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "canonicalEvent", targetId: TARGET_1 },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().targetType).toBe("canonicalEvent");
  });

  it("DELETE removes the user's item (204) and it no longer lists", async () => {
    app = buildApp();
    const add = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    const id = add.json().id as string;

    const del = await app.inject({
      method: "DELETE",
      url: `/api/watchlist/${id}`,
      headers: authA,
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    expect(list.json().items).toEqual([]);
  });
});

describe("watchlist routes — duplicate add is idempotent (Req 5.1)", () => {
  it("returns the existing item and creates no duplicate row", async () => {
    const store = new FakeWatchlistStore();
    app = buildApp({ watchlist: store });

    const first = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    // Exactly one row + the list shows one entry.
    expect(store.size).toBe(1);
    const list = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    expect(list.json().items).toHaveLength(1);
  });
});

describe("watchlist routes — input validation (Req 5.1 / 9.3)", () => {
  const badBodies: Array<{ name: string; payload: unknown; field?: string }> = [
    { name: "missing targetType", payload: { targetId: TARGET_1 }, field: "targetType" },
    {
      name: "invalid targetType",
      payload: { targetType: "wallet", targetId: TARGET_1 },
      field: "targetType",
    },
    { name: "missing targetId", payload: { targetType: "market" }, field: "targetId" },
    {
      name: "non-UUID targetId",
      payload: { targetType: "market", targetId: "not-a-uuid" },
      field: "targetId",
    },
  ];

  for (const { name, payload, field } of badBodies) {
    it(`rejects bad POST body with 400: ${name}`, async () => {
      app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/watchlist",
        headers: authA,
        payload: payload as object,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      if (field) expect(res.json().error.field).toBe(field);
    });
  }

  it("rejects a non-UUID itemId on DELETE with 400", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/watchlist/not-a-uuid",
      headers: authA,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.field).toBe("itemId");
  });
});

describe("watchlist routes — delete unknown / un-owned (Req 5.4, 9.4)", () => {
  it("returns 404 when deleting an unknown item id", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/watchlist/99999999-9999-9999-9999-999999999999`,
      headers: authA,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 404 (and does not delete) when one user targets another user's item", async () => {
    const store = new FakeWatchlistStore();
    app = buildApp({ watchlist: store });

    // User A creates an item.
    const add = await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    const id = add.json().id as string;

    // User B tries to delete it → 404, no effect.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/watchlist/${id}`,
      headers: authB,
    });
    expect(del.statusCode).toBe(404);

    // User A still sees it.
    const listA = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    expect(listA.json().items.map((i: { id: string }) => i.id)).toContain(id);
  });
});

describe("watchlist routes — cross-user isolation on list (Req 9.4)", () => {
  it("one user cannot see another user's items", async () => {
    const store = new FakeWatchlistStore();
    app = buildApp({ watchlist: store });

    await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authA,
      payload: { targetType: "market", targetId: TARGET_1 },
    });
    await app.inject({
      method: "POST",
      url: "/api/watchlist",
      headers: authB,
      payload: { targetType: "market", targetId: TARGET_2 },
    });

    const listA = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    expect(listA.json().items.map((i: { targetId: string }) => i.targetId)).toEqual([TARGET_1]);

    const listB = await app.inject({ method: "GET", url: "/api/watchlist", headers: authB });
    expect(listB.json().items.map((i: { targetId: string }) => i.targetId)).toEqual([TARGET_2]);
  });
});

describe("watchlist routes — not mounted without a store", () => {
  it("returns 404 (route absent) when no watchlist store is configured", async () => {
    app = createServer(buildDeps({ watchlist: undefined }), { rateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/watchlist", headers: authA });
    // Route was never registered → Fastify's default 404.
    expect(res.statusCode).toBe(404);
  });
});
