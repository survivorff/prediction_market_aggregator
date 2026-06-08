/**
 * HTTP-level tests for the comparison + signals routes (task 7.2) using
 * `app.inject` (no port binding, no real infra). Asserts route wiring, response
 * shapes/status codes, 400 on invalid input (Req 9.3), and 404 for an unknown
 * canonical event — exercising the same handlers as the unit tests through the
 * real Fastify request/error path.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { createServer } from "./server.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeCanonicalEventReader,
  FakeOutcomesByIdReader,
  FakeSourceReader,
  makeFakeCanonicalEvent,
  yesNoOutcomes,
  type FakeCanonicalEvent,
} from "./test-support.js";

const CANON_A = "aaaaaaaa-1111-1111-1111-111111111111";
const CANON_B = "bbbbbbbb-2222-2222-2222-222222222222";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

function build(events: FakeCanonicalEvent[]): FastifyInstance {
  const outcomeEntries: Record<string, ReturnType<typeof yesNoOutcomes>> = {};
  for (const e of events) {
    for (const member of e.members) {
      outcomeEntries[member.marketId] = yesNoOutcomes(member.marketId, member.yesImpliedProb);
    }
  }
  const deps: GatewayDeps = {
    discovery: { listMarkets: async () => [], getMarketDetail: async () => null },
    outcomes: new FakeOutcomesByIdReader(outcomeEntries),
    prices: { history: async () => [] },
    sources: new FakeSourceReader([
      {
        id: "src-polymarket",
        key: "polymarket",
        name: "Polymarket",
        type: "onchain",
        baseCurrency: "USDC",
      },
      { id: "src-manifold", key: "manifold", name: "Manifold", type: "cex", baseCurrency: "MANA" },
    ]),
    canonicalEvents: new FakeCanonicalEventReader(events),
  };
  app = createServer(deps);
  return app;
}

function twoPlatformEvent(id: string, polyProb: number, maniProb: number): FakeCanonicalEvent {
  return makeFakeCanonicalEvent({
    id,
    members: [
      {
        marketId: `${id}-poly`,
        sourceId: "src-polymarket",
        sourceKey: "polymarket",
        sourceName: "Polymarket",
        yesImpliedProb: polyProb,
      },
      {
        marketId: `${id}-mani`,
        sourceId: "src-manifold",
        sourceKey: "manifold",
        sourceName: "Manifold",
        yesImpliedProb: maniProb,
      },
    ],
  });
}

describe("GET /api/canonical-events", () => {
  it("returns 200 with cross-platform groupings", async () => {
    const server = build([twoPlatformEvent(CANON_A, 0.5, 0.6)]);
    const res = await server.inject({ method: "GET", url: "/api/canonical-events" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canonicalEvents).toHaveLength(1);
    expect(body.canonicalEvents[0]).toMatchObject({
      id: CANON_A,
      memberCount: 2,
      mismatchCount: 0,
    });
  });

  it("applies a category filter via query string", async () => {
    const crypto = makeFakeCanonicalEvent({
      id: CANON_A,
      category: "crypto",
      members: [{ marketId: "m1", sourceKey: "polymarket", yesImpliedProb: 0.6 }],
    });
    const politics = makeFakeCanonicalEvent({
      id: CANON_B,
      category: "politics",
      members: [{ marketId: "m2", sourceKey: "polymarket", yesImpliedProb: 0.5 }],
    });
    const server = build([crypto, politics]);

    const res = await server.inject({
      method: "GET",
      url: "/api/canonical-events?category=politics",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().canonicalEvents.map((e: { id: string }) => e.id)).toEqual([CANON_B]);
  });

  it("returns 400 on an invalid category", async () => {
    const server = build([]);
    const res = await server.inject({
      method: "GET",
      url: "/api/canonical-events?category=weather",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.field).toBe("category");
  });
});

describe("GET /api/canonical-events/:id", () => {
  it("returns 200 with the comparison view", async () => {
    const server = build([twoPlatformEvent(CANON_A, 0.5, 0.65)]);
    const res = await server.inject({ method: "GET", url: `/api/canonical-events/${CANON_A}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canonicalEvent.id).toBe(CANON_A);
    expect(body.rows).toHaveLength(2);
    expect(body.maxSpread).toBeCloseTo(0.15, 10);
    expect(body.rows[0].tradeLink).toMatch(/^\/api\/markets\/.+\/trade-link$/);
  });

  it("returns 404 for an unknown canonical event", async () => {
    const server = build([twoPlatformEvent(CANON_A, 0.5, 0.65)]);
    const res = await server.inject({ method: "GET", url: `/api/canonical-events/${CANON_B}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for a non-UUID id", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/canonical-events/not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/signals", () => {
  it("returns 200 with signals ranked by gap, all executable:false", async () => {
    const server = build([
      twoPlatformEvent(CANON_A, 0.45, 0.55),
      twoPlatformEvent(CANON_B, 0.1, 0.9),
    ]);
    const res = await server.inject({ method: "GET", url: "/api/signals" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signals.map((s: { canonicalEventId: string }) => s.canonicalEventId)).toEqual([
      CANON_B,
      CANON_A,
    ]);
    expect(body.signals.every((s: { executable: boolean }) => s.executable === false)).toBe(true);
  });

  it("applies the limit query param", async () => {
    const server = build([
      twoPlatformEvent(CANON_A, 0.45, 0.55),
      twoPlatformEvent(CANON_B, 0.1, 0.9),
    ]);
    const res = await server.inject({ method: "GET", url: "/api/signals?limit=1" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signals).toHaveLength(1);
    expect(body.limit).toBe(1);
    expect(body.signals[0].canonicalEventId).toBe(CANON_B);
  });

  it("returns 400 on an out-of-range limit", async () => {
    const server = build([]);
    const res = await server.inject({ method: "GET", url: "/api/signals?limit=9999" });
    expect(res.statusCode).toBe(400);
  });
});
