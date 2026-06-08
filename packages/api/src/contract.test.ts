/**
 * API CONTRACT TESTS (task 7.6).
 *
 * These tests lock the *response SHAPE* of every REST endpoint and the
 * WebSocket fan-out message envelope against seeded data, and assert the
 * cross-cutting product guarantees the design promises:
 *
 *   - Req 9.1 (own-endpoints-only): every response is served EXCLUSIVELY from
 *     the system's own storage/Redis reader fakes — no adapter is ever wired
 *     and nothing reaches an upstream platform.
 *   - Req 3.3 (display-only signals): every `/api/signals` row carries the
 *     literal `executable: false`, and no response exposes any
 *     execution/order-placement field.
 *   - Req 6.2 (trade-link is navigation-only): `/api/markets/{id}/trade-link`
 *     returns `executable: false` and ONLY navigation fields — no execution
 *     path of any kind.
 *
 * This file is intentionally COMPLEMENTARY to the existing behavioral tests
 * (`server.test.ts`, `handlers.test.ts`, `comparison-signals.*.test.ts`,
 * `trade-link.test.ts`, `ws-fanout.test.ts`, `websocket.test.ts`): those assert
 * *behavior* (filtering, sorting, status codes, spread math); this file is a
 * schema/contract lock — exact top-level keys, field types, explicit-null
 * handling, and the guarantee invariants — so an accidental contract change
 * (renamed/added/removed field, leaked execution field) fails fast.
 *
 * Everything runs through the real Fastify request path via `app.inject` with
 * the in-memory storage fakes (no Postgres, no Redis, no network).
 */

import { describe, it, expect, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { CATEGORIES, MARKET_STATUSES } from "@pma/core";
import {
  marketChannel,
  canonicalChannel,
  alertsChannel,
  type FanoutMessage,
  type PricePayload,
  type SpreadPayload,
} from "@pma/storage";
import { createServer } from "./server.js";
import { FanoutRelay } from "./ws-fanout.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeDiscoveryReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  FakeHotPriceReader,
  FakeCanonicalEventReader,
  FakeFanoutSubscriber,
  caps,
  makeFakeMarket,
  makeFakeCanonicalEvent,
} from "./test-support.js";

// ---------------------------------------------------------------------------
// Shape-assertion helpers (a tiny schema validator for "contract locking").
// ---------------------------------------------------------------------------

/** The JSON value kinds a parsed response body can take. */
type JsonKind = "string" | "number" | "boolean" | "object" | "array" | "null";

/** A field may allow several kinds, plus the literal `false` (for `executable`). */
type FieldSpec = JsonKind | "false";

/** An object contract: every key maps to its allowed {@link FieldSpec}s. */
type Schema = Record<string, readonly FieldSpec[]>;

/** Classify a JSON value into a {@link JsonKind} (object excludes array/null). */
function kindOf(value: unknown): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

/**
 * Assert `value` is a JSON object whose keys EXACTLY match `schema` (no missing,
 * no extra) and whose every field's type is one of the allowed kinds. This is
 * the contract lock: an added/removed/renamed/retyped field fails here.
 */
function assertShape(value: unknown, schema: Schema, label: string): Record<string, unknown> {
  expect(kindOf(value), `${label} must be a JSON object`).toBe("object");
  const obj = value as Record<string, unknown>;
  expect([...Object.keys(obj)].sort(), `${label}: exact top-level keys`).toEqual(
    [...Object.keys(schema)].sort(),
  );
  for (const [key, allowed] of Object.entries(schema)) {
    const field = obj[key];
    const ok = allowed.some((spec) =>
      spec === "false" ? field === false : kindOf(field) === spec,
    );
    expect(
      ok,
      `${label}.${key}: expected [${allowed.join(" | ")}] but got ${kindOf(field)} (${JSON.stringify(field)})`,
    ).toBe(true);
  }
  return obj;
}

/** Recursively collect every object key appearing anywhere in a JSON value. */
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

/**
 * Keys that legitimately contain an otherwise-suspicious token but are NOT an
 * execution path: `executable` is the explicit display-only guarantee flag
 * (always `false`), and `orderBookDepth*` is read-only market-depth data (always
 * `null` in v1 — never an order-placement field). Documented so the invariant
 * scan below stays precise (Req 3.3, 6.2).
 */
const EXECUTION_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  "executable",
  "orderBookDepth",
  "orderBookDepthSupported",
]);

/**
 * Tokens that would indicate an execution / order-placement / fund-routing
 * field. v1 is strictly read-only (Req 3.3, 6.2, 12.1) so NONE of these may
 * appear as a response field name.
 */
const FORBIDDEN_EXECUTION_TOKENS: ReadonlySet<string> = new Set([
  "buy",
  "sell",
  "order",
  "execute",
  "execution",
  "wallet",
  "amount",
  "fund",
  "funding",
  "route",
  "routing",
  "signature",
  "approve",
  "allowance",
  "checkout",
  "deposit",
  "withdraw",
  "position",
  "shares",
]);

/** Split a (camelCase / snake) field name into lowercased word tokens. */
function tokenize(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Scan a response body for ANY execution/order-placement field name — the
 * display-only / no-execution invariant (Req 3.3, 6.2). The reserved
 * `executable` flag and read-only `orderBookDepth*` are whitelisted (see above).
 */
function assertNoExecutionFields(body: unknown, label: string): void {
  const offending = collectKeys(body).filter((key) => {
    if (EXECUTION_FIELD_WHITELIST.has(key)) return false;
    return tokenize(key).some((token) => FORBIDDEN_EXECUTION_TOKENS.has(token));
  });
  expect(offending, `${label}: forbidden execution-related field(s) present`).toEqual([]);
}

// ---------------------------------------------------------------------------
// The DTO contracts, expressed as schemas (design.md "Outbound API Surface").
// ---------------------------------------------------------------------------

const SOURCE_REF_SCHEMA: Schema = {
  key: ["string"],
  name: ["string"],
};

const MARKET_SUMMARY_SCHEMA: Schema = {
  id: ["string"],
  source: ["object"],
  question: ["string"],
  category: ["string"],
  status: ["string"],
  impliedProb: ["number", "null"],
  volume24h: ["number", "null"],
  liquidity: ["number", "null"],
  timeRemainingSec: ["number", "null"],
  canonicalEventId: ["string", "null"],
};

const MARKET_LIST_SCHEMA: Schema = {
  markets: ["array"],
  paging: ["object"],
};

const PAGING_SCHEMA: Schema = {
  limit: ["number"],
  offset: ["number"],
  count: ["number"],
};

const OUTCOME_DETAIL_SCHEMA: Schema = {
  id: ["string"],
  label: ["string"],
  tokenId: ["string", "null"],
  impliedProb: ["number", "null"],
  lastPrice: ["number", "null"],
  latestPriceTs: ["string", "null"],
  priceSource: ["string"],
};

const RESOLUTION_CRITERIA_SCHEMA: Schema = {
  dataSource: ["string", "null"],
  cutoffTime: ["string", "null"],
  rounding: ["string", "null"],
  raw: ["object"],
};

const MARKET_DETAIL_SCHEMA: Schema = {
  id: ["string"],
  source: ["object"],
  externalId: ["string"],
  question: ["string"],
  category: ["string"],
  status: ["string"],
  impliedProb: ["number", "null"],
  volume24h: ["number", "null"],
  liquidity: ["number", "null"],
  spread: ["number", "null"],
  timeRemainingSec: ["number", "null"],
  canonicalEventId: ["string", "null"],
  resolutionCriteria: ["object"],
  outcomes: ["array"],
  orderBookDepth: ["null"],
  orderBookDepthSupported: ["boolean"],
  tradeLinkPath: ["string"],
};

const PRICE_HISTORY_POINT_SCHEMA: Schema = {
  outcomeId: ["string"],
  ts: ["string"],
  price: ["number"],
  volume: ["number", "null"],
};

const PRICE_HISTORY_SCHEMA: Schema = {
  marketId: ["string"],
  range: ["object"],
  points: ["array"],
};

const HISTORY_RANGE_SCHEMA: Schema = {
  from: ["string"],
  to: ["string"],
  interval: ["string", "null"],
};

const SOURCE_INFO_SCHEMA: Schema = {
  key: ["string"],
  name: ["string"],
  type: ["string"],
  baseCurrency: ["string"],
  capabilities: ["object", "null"],
};

const SOURCE_LIST_SCHEMA: Schema = {
  sources: ["array"],
};

const CAPABILITIES_SCHEMA: Schema = {
  websocketPrices: ["boolean"],
  priceHistory: ["boolean"],
  orderBookDepth: ["boolean"],
  keysetPagination: ["boolean"],
};

const CANONICAL_EVENT_SUMMARY_SCHEMA: Schema = {
  id: ["string"],
  title: ["string"],
  category: ["string"],
  subjectEntity: ["string", "null"],
  thresholdValue: ["number", "null"],
  targetDate: ["string", "null"],
  memberCount: ["number"],
  mismatchCount: ["number"],
};

const CANONICAL_EVENT_LIST_SCHEMA: Schema = {
  canonicalEvents: ["array"],
  filter: ["object"],
};

const CANONICAL_EVENT_SCHEMA: Schema = {
  id: ["string"],
  title: ["string"],
  category: ["string"],
  subjectEntity: ["string", "null"],
  thresholdValue: ["number", "null"],
  targetDate: ["string", "null"],
};

const COMPARISON_ROW_SCHEMA: Schema = {
  source: ["object"],
  marketId: ["string"],
  impliedProb: ["number", "null"],
  volume24h: ["number", "null"],
  resolutionMismatch: ["boolean"],
  tradeLink: ["string"],
};

const COMPARISON_VIEW_SCHEMA: Schema = {
  canonicalEvent: ["object"],
  rows: ["array"],
  maxSpread: ["number", "null"],
};

const SIGNAL_PER_PLATFORM_SCHEMA: Schema = {
  source: ["string"],
  impliedProb: ["number"],
};

const SIGNAL_SCHEMA: Schema = {
  canonicalEventId: ["string"],
  title: ["string"],
  perPlatform: ["array"],
  gap: ["number"],
  // Req 3.3: display-only — the literal `false`, never `true`.
  executable: ["false"],
};

const SIGNAL_LIST_SCHEMA: Schema = {
  signals: ["array"],
  limit: ["number"],
};

const TRADE_LINK_SCHEMA: Schema = {
  marketId: ["string"],
  source: ["object"],
  url: ["string", "null"],
  // Req 6.2: navigation-only — the literal `false`.
  executable: ["false"],
};

/** The relayed WebSocket fan-out frame (design.md "WebSocket fan-out"). */
const WS_FRAME_SCHEMA: Schema = {
  channel: ["string"],
  type: ["string"],
  payload: ["object"],
};

// ---------------------------------------------------------------------------
// Seeded fixture — a representative slice of the system's OWN storage (Req 9.1).
// ---------------------------------------------------------------------------

const NOW = Date.UTC(2025, 0, 1, 0, 0, 0);

// Market ids (valid UUID shape so they pass the path validators).
const MARKET_POLY = "11111111-1111-1111-1111-111111111111";
const MARKET_MANI = "22222222-2222-2222-2222-222222222222";
const MARKET_NULLS = "33333333-3333-3333-3333-333333333333";
const MARKET_MISMATCH = "44444444-4444-4444-4444-444444444444";
const CANON_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// External ids shared by discovery markets, the hot cache, and canonical members.
const EXT_POLY = "poly-btc-100k";
const EXT_MANI = "mani-btc-100k";
const EXT_MISMATCH = "mism-btc-100k";

const SEEDED_DISCOVERY_IDS = [MARKET_POLY, MARKET_MANI, MARKET_NULLS] as const;
const SEEDED_SOURCE_KEYS = ["polymarket", "manifold"] as const;

/** The full set of dependency keys the gateway is allowed to use — all are storage/Redis readers. */
const ALLOWED_DEP_KEYS: ReadonlySet<string> = new Set<keyof GatewayDeps>([
  "discovery",
  "outcomes",
  "prices",
  "sources",
  "canonicalEvents",
  "hotPrices",
  "tradeLink",
  "capabilities",
  "fanoutSubscriberFactory",
  "authenticate",
  "now",
]);

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

/**
 * Assemble {@link GatewayDeps} from the in-memory storage fakes ONLY. There is
 * deliberately NO adapter, HTTP client, or upstream call anywhere here — the
 * gateway serves exclusively from this seeded storage (Requirement 9.1).
 */
function buildDeps(): GatewayDeps {
  const poly = makeFakeMarket({
    id: MARKET_POLY,
    externalId: EXT_POLY,
    sourceKey: "polymarket",
    sourceName: "Polymarket",
    question: "Will BTC close above $100k in 2025?",
    category: "crypto",
    status: "open",
    volume24h: 5000,
    liquidity: 1200,
    endDate: "2025-12-31T00:00:00.000Z",
    canonicalEventId: CANON_ID,
    yesImpliedProb: 0.45,
    history: [
      {
        marketId: MARKET_POLY,
        outcomeId: "o-yes",
        ts: "2025-01-01T00:00:00.000Z",
        price: 0.44,
        volume: 10,
      },
      {
        marketId: MARKET_POLY,
        outcomeId: "o-yes",
        ts: "2025-01-01T06:00:00.000Z",
        price: 0.46,
        volume: null,
      },
    ],
  });
  const mani = makeFakeMarket({
    id: MARKET_MANI,
    externalId: EXT_MANI,
    sourceKey: "manifold",
    sourceName: "Manifold",
    question: "Will BTC close above $100k in 2025?",
    category: "crypto",
    status: "open",
    volume24h: 3000,
    liquidity: 800,
    canonicalEventId: CANON_ID,
    yesImpliedProb: 0.62,
  });
  // Explicit-null market (Requirement 1.5): missing upstream values stay null.
  const nulls = makeFakeMarket({
    id: MARKET_NULLS,
    externalId: "poly-nulls",
    sourceKey: "polymarket",
    sourceName: "Polymarket",
    question: "Sparse metadata market",
    category: "other",
    status: "open",
    volume24h: null,
    liquidity: null,
    endDate: null,
    yesImpliedProb: null,
  });

  const markets = [poly, mani, nulls];

  // One canonical event linking two ALIGNED platforms + one MISMATCHED member
  // (excluded from spread/signals) so the comparison & signals contracts are
  // exercised with mismatch handling (Req 2.3, 3.2).
  const canon = makeFakeCanonicalEvent({
    id: CANON_ID,
    title: "Will BTC close above $100k in 2025?",
    category: "crypto",
    members: [
      {
        marketId: MARKET_POLY,
        externalId: EXT_POLY,
        sourceId: "src-polymarket",
        sourceKey: "polymarket",
        sourceName: "Polymarket",
        yesImpliedProb: 0.45,
      },
      {
        marketId: MARKET_MANI,
        externalId: EXT_MANI,
        sourceId: "src-manifold",
        sourceKey: "manifold",
        sourceName: "Manifold",
        yesImpliedProb: 0.62,
      },
      {
        marketId: MARKET_MISMATCH,
        externalId: EXT_MISMATCH,
        sourceId: "src-polymarket",
        sourceKey: "polymarket",
        sourceName: "Polymarket",
        yesImpliedProb: 0.9,
        resolutionMismatch: true,
      },
    ],
  });

  return {
    discovery: new FakeDiscoveryReader(markets),
    outcomes: new FakeOutcomeReader(markets),
    prices: new FakePriceHistoryReader(markets),
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
    canonicalEvents: new FakeCanonicalEventReader([canon]),
    // Hot cache overlay for the Polymarket market (exercises priceSource:"hotCache").
    hotPrices: new FakeHotPriceReader({
      [EXT_POLY]: [{ outcomeLabel: "Yes", price: 0.48, ts: "2025-01-01T06:30:00.000Z" }],
    }),
    capabilities: {
      polymarket: caps({
        websocketPrices: true,
        priceHistory: true,
        orderBookDepth: true,
        keysetPagination: true,
      }),
      manifold: caps({ priceHistory: true }),
    },
    now: () => NOW,
  };
}

function buildServer(): FastifyInstance {
  app = createServer(buildDeps());
  return app;
}

async function getJson(
  server: FastifyInstance,
  url: string,
): Promise<{ status: number; body: unknown }> {
  const res = await server.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as unknown };
}

// ---------------------------------------------------------------------------
// 1. REST response-shape contracts — one per endpoint.
// ---------------------------------------------------------------------------

describe("REST contract: GET /api/markets (MarketListResponse)", () => {
  it("locks the discovery list + MarketSummary shape, including explicit nulls", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, "/api/markets");
    expect(status).toBe(200);

    const env = assertShape(body, MARKET_LIST_SCHEMA, "MarketListResponse");
    assertShape(env.paging, PAGING_SCHEMA, "MarketListResponse.paging");

    const markets = env.markets as unknown[];
    expect(markets).toHaveLength(SEEDED_DISCOVERY_IDS.length);
    for (const market of markets) {
      const m = assertShape(market, MARKET_SUMMARY_SCHEMA, "MarketSummary");
      assertShape(m.source, SOURCE_REF_SCHEMA, "MarketSummary.source");
      expect(CATEGORIES).toContain(m.category);
      expect(MARKET_STATUSES).toContain(m.status);
    }

    // Explicit-null handling (Req 1.5): the sparse market reports nulls, not omitted fields.
    const sparse = assertShape(
      markets.find((m) => (m as { id: string }).id === MARKET_NULLS),
      MARKET_SUMMARY_SCHEMA,
      "MarketSummary(sparse)",
    );
    expect(sparse.impliedProb).toBeNull();
    expect(sparse.volume24h).toBeNull();
    expect(sparse.liquidity).toBeNull();
    expect(sparse.timeRemainingSec).toBeNull();
    expect(sparse.canonicalEventId).toBeNull();
  });
});

describe("REST contract: GET /api/markets/:id (MarketDetail)", () => {
  it("locks the detail + OutcomeDetail + ResolutionCriteria shape; orderBookDepth is null", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, `/api/markets/${MARKET_POLY}`);
    expect(status).toBe(200);

    const detail = assertShape(body, MARKET_DETAIL_SCHEMA, "MarketDetail");
    assertShape(detail.source, SOURCE_REF_SCHEMA, "MarketDetail.source");
    assertShape(
      detail.resolutionCriteria,
      RESOLUTION_CRITERIA_SCHEMA,
      "MarketDetail.resolutionCriteria",
    );
    expect(detail.orderBookDepth).toBeNull();
    expect(detail.tradeLinkPath).toBe(`/api/markets/${MARKET_POLY}/trade-link`);

    const outcomes = detail.outcomes as unknown[];
    expect(outcomes.length).toBeGreaterThan(0);
    for (const outcome of outcomes) {
      const o = assertShape(outcome, OUTCOME_DETAIL_SCHEMA, "OutcomeDetail");
      expect(["hotCache", "stored", "none"]).toContain(o.priceSource);
    }
    // Hot-cache overlay surfaced for the Yes outcome (priceSource lock).
    const yes = outcomes
      .map((o) => o as Record<string, unknown>)
      .find((o) => String(o.label).toLowerCase() === "yes");
    expect(yes?.priceSource).toBe("hotCache");
    expect(yes?.lastPrice).toBe(0.48);
  });
});

describe("REST contract: GET /api/markets/:id/history (PriceHistoryResponse)", () => {
  it("locks the price-history envelope + PriceHistoryPoint shape", async () => {
    const server = buildServer();
    const { status, body } = await getJson(
      server,
      `/api/markets/${MARKET_POLY}/history?from=2025-01-01T00:00:00.000Z&to=2025-01-02T00:00:00.000Z`,
    );
    expect(status).toBe(200);

    const env = assertShape(body, PRICE_HISTORY_SCHEMA, "PriceHistoryResponse");
    expect(env.marketId).toBe(MARKET_POLY);
    assertShape(env.range, HISTORY_RANGE_SCHEMA, "PriceHistoryResponse.range");

    const points = env.points as unknown[];
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      assertShape(point, PRICE_HISTORY_POINT_SCHEMA, "PriceHistoryPoint");
    }
  });
});

describe("REST contract: GET /api/sources (SourceListResponse)", () => {
  it("locks the SourceInfo shape + capabilities sub-shape", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, "/api/sources");
    expect(status).toBe(200);

    const env = assertShape(body, SOURCE_LIST_SCHEMA, "SourceListResponse");
    const sources = env.sources as unknown[];
    expect(sources.map((s) => (s as { key: string }).key).sort()).toEqual(
      [...SEEDED_SOURCE_KEYS].sort(),
    );
    for (const source of sources) {
      const s = assertShape(source, SOURCE_INFO_SCHEMA, "SourceInfo");
      if (s.capabilities !== null) {
        assertShape(s.capabilities, CAPABILITIES_SCHEMA, "SourceInfo.capabilities");
      }
    }
  });
});

describe("REST contract: GET /api/canonical-events (CanonicalEventListResponse)", () => {
  it("locks the list envelope + CanonicalEventSummary shape", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, "/api/canonical-events");
    expect(status).toBe(200);

    const env = assertShape(body, CANONICAL_EVENT_LIST_SCHEMA, "CanonicalEventListResponse");
    expect([...Object.keys(env.filter as Record<string, unknown>)]).toEqual(["category"]);

    const events = env.canonicalEvents as unknown[];
    expect(events).toHaveLength(1);
    const summary = assertShape(events[0], CANONICAL_EVENT_SUMMARY_SCHEMA, "CanonicalEventSummary");
    expect(summary.memberCount).toBe(3);
    expect(summary.mismatchCount).toBe(1);
  });
});

describe("REST contract: GET /api/canonical-events/:id (ComparisonView)", () => {
  it("locks the comparison view + ComparisonRow shape; maxSpread is number|null", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, `/api/canonical-events/${CANON_ID}`);
    expect(status).toBe(200);

    const view = assertShape(body, COMPARISON_VIEW_SCHEMA, "ComparisonView");
    assertShape(view.canonicalEvent, CANONICAL_EVENT_SCHEMA, "ComparisonView.canonicalEvent");
    expect(view.maxSpread === null || typeof view.maxSpread === "number").toBe(true);

    const rows = view.rows as unknown[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const r = assertShape(row, COMPARISON_ROW_SCHEMA, "ComparisonRow");
      assertShape(r.source, SOURCE_REF_SCHEMA, "ComparisonRow.source");
      expect(String(r.tradeLink)).toMatch(/^\/api\/markets\/.+\/trade-link$/);
    }
    // The mismatched member is shown (Req 2.3) but excluded from the spread.
    const mismatchRow = rows
      .map((r) => r as Record<string, unknown>)
      .find((r) => r.marketId === MARKET_MISMATCH);
    expect(mismatchRow?.resolutionMismatch).toBe(true);
  });
});

describe("REST contract: GET /api/signals (SignalListResponse)", () => {
  it("locks the signals envelope + SignalDto + perPlatform shape", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, "/api/signals");
    expect(status).toBe(200);

    const env = assertShape(body, SIGNAL_LIST_SCHEMA, "SignalListResponse");
    const signals = env.signals as unknown[];
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      const s = assertShape(signal, SIGNAL_SCHEMA, "SignalDto");
      for (const leg of s.perPlatform as unknown[]) {
        assertShape(leg, SIGNAL_PER_PLATFORM_SCHEMA, "SignalDto.perPlatform[]");
      }
    }
  });
});

describe("REST contract: GET /api/markets/:id/trade-link (TradeLink)", () => {
  it("locks the trade-link shape — navigation fields only", async () => {
    const server = buildServer();
    const { status, body } = await getJson(server, `/api/markets/${MARKET_POLY}/trade-link`);
    expect(status).toBe(200);

    const link = assertShape(body, TRADE_LINK_SCHEMA, "TradeLink");
    assertShape(link.source, SOURCE_REF_SCHEMA, "TradeLink.source");
    expect(link.marketId).toBe(MARKET_POLY);
  });
});

// ---------------------------------------------------------------------------
// 2. Display-only / no-execution guarantees (Req 3.3, 6.2, 12.1).
// ---------------------------------------------------------------------------

describe("guarantee: display-only signals (Req 3.3)", () => {
  it("every signal is non-executable — executable === false (literal)", async () => {
    const server = buildServer();
    const { body } = await getJson(server, "/api/signals");
    const signals = (body as { signals: Array<{ executable: unknown }> }).signals;
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      // Literal false, not merely falsy (0/""/null would all be wrong here).
      expect(signal.executable).toBe(false);
      expect(typeof signal.executable).toBe("boolean");
    }
  });

  it("the signals/comparison/detail responses expose NO execution/order-placement field", async () => {
    const server = buildServer();
    const signals = await getJson(server, "/api/signals");
    const comparison = await getJson(server, `/api/canonical-events/${CANON_ID}`);
    const detail = await getJson(server, `/api/markets/${MARKET_POLY}`);

    assertNoExecutionFields(signals.body, "GET /api/signals");
    assertNoExecutionFields(comparison.body, `GET /api/canonical-events/${CANON_ID}`);
    assertNoExecutionFields(detail.body, `GET /api/markets/${MARKET_POLY}`);
  });
});

describe("guarantee: trade-link is navigation-only (Req 6.2)", () => {
  it("returns executable:false and ONLY navigation fields (no execution path)", async () => {
    const server = buildServer();
    const { body } = await getJson(server, `/api/markets/${MARKET_POLY}/trade-link`);

    // Exactly the navigation contract — no extra fields can sneak in.
    expect([...Object.keys(body as Record<string, unknown>)].sort()).toEqual(
      ["executable", "marketId", "source", "url"].sort(),
    );
    expect((body as { executable: unknown }).executable).toBe(false);
    assertNoExecutionFields(body, "GET /api/markets/:id/trade-link");
  });
});

// ---------------------------------------------------------------------------
// 3. Own-endpoints-only — served from storage fakes, never upstream (Req 9.1).
// ---------------------------------------------------------------------------

describe("guarantee: own-endpoints-only (Req 9.1)", () => {
  it("the gateway is wired with ONLY storage/Redis reader ports — no adapter", () => {
    const deps = buildDeps();
    // Contract: every injected dependency is a storage/Redis reader (or a pure
    // helper). There is no adapter / HTTP-client / upstream-fetch dependency.
    for (const key of Object.keys(deps)) {
      expect(ALLOWED_DEP_KEYS.has(key), `unexpected dependency "${key}"`).toBe(true);
    }
    expect("adapter" in deps).toBe(false);
    expect("fetch" in deps).toBe(false);
    expect("upstream" in deps).toBe(false);
  });

  it("responses derive purely from the seeded storage data", async () => {
    const server = buildServer();

    // Discovery ids are EXACTLY the seeded market ids — nothing came from an upstream.
    const markets = await getJson(server, "/api/markets");
    const ids = (markets.body as { markets: Array<{ id: string }> }).markets
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual([...SEEDED_DISCOVERY_IDS].sort());

    // Sources are EXACTLY the seeded registry rows.
    const sources = await getJson(server, "/api/sources");
    const keys = (sources.body as { sources: Array<{ key: string }> }).sources
      .map((s) => s.key)
      .sort();
    expect(keys).toEqual([...SEEDED_SOURCE_KEYS].sort());
  });
});

// ---------------------------------------------------------------------------
// 4. WebSocket fan-out message contract (design.md "WebSocket fan-out").
// ---------------------------------------------------------------------------

describe("WS fan-out contract: relayed frame { channel, type, payload }", () => {
  /** Capture frames a relay emits, decoding each from JSON. */
  function sink(): { frames: unknown[]; send: (f: string) => void } {
    const frames: unknown[] = [];
    return { frames, send: (f: string) => frames.push(JSON.parse(f)) };
  }

  const MARKET_ID = MARKET_POLY;
  const VALID_TYPES = ["price", "spread", "alert"];

  it("locks the relayed frame shape for price/spread/alert messages", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "canonical", id: CANON_ID }),
    );
    await relay.handleFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));

    const price: FanoutMessage<PricePayload> = {
      channel: marketChannel(MARKET_ID),
      type: "price",
      payload: {
        marketId: MARKET_ID,
        outcomeLabel: "Yes",
        price: 0.62,
        volume: null,
        ts: "2025-01-01T00:00:00.000Z",
      },
    };
    const spread: FanoutMessage<SpreadPayload> = {
      channel: canonicalChannel(CANON_ID),
      type: "spread",
      payload: {
        canonicalEventId: CANON_ID,
        gap: 0.17,
        probabilities: [{ source: "polymarket", impliedProb: 0.45 }],
      },
    };
    const alert: FanoutMessage = {
      channel: alertsChannel(),
      type: "alert",
      payload: { kind: "thresholdCross", marketId: MARKET_ID },
    };

    pubsub.publish(marketChannel(MARKET_ID), price);
    pubsub.publish(canonicalChannel(CANON_ID), spread);
    pubsub.publish(alertsChannel(), alert);

    expect(out.frames).toHaveLength(3);
    for (const frame of out.frames) {
      const f = assertShape(frame, WS_FRAME_SCHEMA, "WS fan-out frame");
      expect(VALID_TYPES, "WS frame.type must be price|spread|alert").toContain(f.type);
    }

    // The relayed frame is exactly the design's envelope (channel echoes the
    // self-describing Redis channel; payload is passed through verbatim).
    expect(out.frames).toContainEqual({
      channel: marketChannel(MARKET_ID),
      type: "price",
      payload: price.payload,
    });
    expect(out.frames).toContainEqual({
      channel: canonicalChannel(CANON_ID),
      type: "spread",
      payload: spread.payload,
    });
    expect(out.frames).toContainEqual({
      channel: alertsChannel(),
      type: "alert",
      payload: alert.payload,
    });
  });
});
