/**
 * HTTP-level tests for the user-scoped alert routes (task 8.2), exercised
 * through Fastify `inject` (no port binding, no infra) with an injected fake
 * authenticator + fake alert store. Cover:
 *
 *   - 401 when unauthenticated (Requirement 9.4);
 *   - create/list/delete happy paths (Req 5.2, 5.4);
 *   - 400 on a bad POST body (bad ruleType, bad params per type);
 *   - 404 deleting an unknown / un-owned rule (Req 5.4);
 *   - one user cannot see or delete another user's rules (Req 9.4).
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
  FakeAlertStore,
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
    alerts: new FakeAlertStore(),
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

const THRESHOLD_BODY = {
  targetType: "market",
  targetId: TARGET_1,
  ruleType: "thresholdCross",
  params: { threshold: 0.6 },
};

describe("alert routes — authentication (Req 9.4)", () => {
  it("GET /api/alerts returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("UNAUTHORIZED");
  });

  it("POST /api/alerts returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts",
      payload: THRESHOLD_BODY,
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/alerts/:alertId returns 401 with no Authorization header", async () => {
    app = buildApp();
    const res = await app.inject({ method: "DELETE", url: `/api/alerts/${TARGET_1}` });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/alerts",
      headers: { authorization: "Bearer nope" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("is safe-by-default CLOSED: 401 when no authenticator is configured but a store is present", async () => {
    app = createServer(buildDeps({ authenticate: undefined }), { rateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(res.statusCode).toBe(401);
  });
});

describe("alert routes — create/list/delete happy paths (Req 5.2, 5.4)", () => {
  it("POST creates a rule (201) and GET lists it for the same user", async () => {
    app = buildApp();

    const add = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: THRESHOLD_BODY,
    });
    expect(add.statusCode).toBe(201);
    const created = add.json();
    expect(created).toMatchObject({
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.6 },
      active: true,
    });
    expect(created.id).toBeTruthy();
    expect(created).not.toHaveProperty("userId");

    const list = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(list.statusCode).toBe(200);
    expect(list.json().alerts.map((a: { id: string }) => a.id)).toEqual([created.id]);
  });

  it("accepts a spreadWiden rule on a canonicalEvent target", async () => {
    app = buildApp();
    const add = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: {
        targetType: "canonicalEvent",
        targetId: TARGET_1,
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
      },
    });
    expect(add.statusCode).toBe(201);
    expect(add.json()).toMatchObject({ ruleType: "spreadWiden", params: { minGap: 0.05 } });
  });

  it("does NOT deduplicate: two POSTs for the same target yield two rules (Req 5.2)", async () => {
    const store = new FakeAlertStore();
    app = buildApp({ alerts: store });

    const first = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: THRESHOLD_BODY,
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: { ...THRESHOLD_BODY, params: { threshold: 0.8 } },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.json().id);
    expect(store.size).toBe(2);

    const list = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(list.json().alerts).toHaveLength(2);
  });

  it("DELETE removes the user's rule (204) and it no longer lists", async () => {
    app = buildApp();
    const add = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: THRESHOLD_BODY,
    });
    const id = add.json().id as string;

    const del = await app.inject({ method: "DELETE", url: `/api/alerts/${id}`, headers: authA });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(list.json().alerts).toEqual([]);
  });
});

describe("alert routes — input validation (Req 5.2 / 9.3)", () => {
  const badBodies: Array<{ name: string; payload: unknown; field?: string }> = [
    {
      name: "missing targetType",
      payload: { targetId: TARGET_1, ruleType: "thresholdCross", params: { threshold: 0.5 } },
      field: "targetType",
    },
    {
      name: "invalid targetType",
      payload: {
        targetType: "wallet",
        targetId: TARGET_1,
        ruleType: "thresholdCross",
        params: { threshold: 0.5 },
      },
      field: "targetType",
    },
    {
      name: "missing targetId",
      payload: { targetType: "market", ruleType: "thresholdCross", params: { threshold: 0.5 } },
      field: "targetId",
    },
    {
      name: "non-UUID targetId",
      payload: {
        targetType: "market",
        targetId: "not-a-uuid",
        ruleType: "thresholdCross",
        params: { threshold: 0.5 },
      },
      field: "targetId",
    },
    {
      name: "missing ruleType",
      payload: { targetType: "market", targetId: TARGET_1, params: { threshold: 0.5 } },
      field: "ruleType",
    },
    {
      name: "invalid ruleType",
      payload: {
        targetType: "market",
        targetId: TARGET_1,
        ruleType: "priceDrop",
        params: { threshold: 0.5 },
      },
      field: "ruleType",
    },
    {
      name: "missing params",
      payload: { targetType: "market", targetId: TARGET_1, ruleType: "thresholdCross" },
      field: "params",
    },
    {
      name: "thresholdCross with out-of-range threshold",
      payload: {
        targetType: "market",
        targetId: TARGET_1,
        ruleType: "thresholdCross",
        params: { threshold: 2 },
      },
      field: "params",
    },
    {
      name: "thresholdCross with wrong param shape (minGap)",
      payload: {
        targetType: "market",
        targetId: TARGET_1,
        ruleType: "thresholdCross",
        params: { minGap: 0.5 },
      },
      field: "params",
    },
    {
      name: "spreadWiden with negative minGap",
      payload: {
        targetType: "canonicalEvent",
        targetId: TARGET_1,
        ruleType: "spreadWiden",
        params: { minGap: -0.1 },
      },
      field: "params",
    },
    {
      name: "spreadWiden with wrong param shape (threshold)",
      payload: {
        targetType: "canonicalEvent",
        targetId: TARGET_1,
        ruleType: "spreadWiden",
        params: { threshold: 0.5 },
      },
      field: "params",
    },
  ];

  for (const { name, payload, field } of badBodies) {
    it(`rejects bad POST body with 400: ${name}`, async () => {
      app = buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/alerts",
        headers: authA,
        payload: payload as object,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      if (field) expect(res.json().error.field).toBe(field);
    });
  }

  it("rejects a non-UUID alertId on DELETE with 400", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/alerts/not-a-uuid",
      headers: authA,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.field).toBe("alertId");
  });
});

describe("alert routes — delete unknown / un-owned (Req 5.4, 9.4)", () => {
  it("returns 404 when deleting an unknown rule id", async () => {
    app = buildApp();
    const res = await app.inject({
      method: "DELETE",
      url: `/api/alerts/99999999-9999-9999-9999-999999999999`,
      headers: authA,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 404 (and does not delete) when one user targets another user's rule", async () => {
    const store = new FakeAlertStore();
    app = buildApp({ alerts: store });

    const add = await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: THRESHOLD_BODY,
    });
    const id = add.json().id as string;

    const del = await app.inject({ method: "DELETE", url: `/api/alerts/${id}`, headers: authB });
    expect(del.statusCode).toBe(404);

    const listA = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(listA.json().alerts.map((a: { id: string }) => a.id)).toContain(id);
  });
});

describe("alert routes — cross-user isolation on list (Req 9.4)", () => {
  it("one user cannot see another user's rules", async () => {
    const store = new FakeAlertStore();
    app = buildApp({ alerts: store });

    await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authA,
      payload: THRESHOLD_BODY,
    });
    await app.inject({
      method: "POST",
      url: "/api/alerts",
      headers: authB,
      payload: { ...THRESHOLD_BODY, targetId: TARGET_2 },
    });

    const listA = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    expect(listA.json().alerts.map((a: { targetId: string }) => a.targetId)).toEqual([TARGET_1]);

    const listB = await app.inject({ method: "GET", url: "/api/alerts", headers: authB });
    expect(listB.json().alerts.map((a: { targetId: string }) => a.targetId)).toEqual([TARGET_2]);
  });
});

describe("alert routes — not mounted without a store", () => {
  it("returns 404 (route absent) when no alert store is configured", async () => {
    app = createServer(buildDeps({ alerts: undefined }), { rateLimit: false });
    const res = await app.inject({ method: "GET", url: "/api/alerts", headers: authA });
    // Route was never registered → Fastify's default 404.
    expect(res.statusCode).toBe(404);
  });
});
