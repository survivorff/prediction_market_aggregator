/**
 * Unit tests for the comparison + signals handlers (task 7.2), using in-memory
 * fakes (no Postgres/Redis). Cover:
 *   - canonical-events list shape + category filter (Req 2.1);
 *   - comparison view: per-platform rows, mismatch flag (Req 2.3), trade-link,
 *     maxSpread over non-mismatch open rows only, maxSpread null when < 2
 *     aligned (Req 2.4), hot-cache overlay (Req 10.4), 404 unknown id;
 *   - signals: ranked by largest gap (Req 3.1), aligned/open only (Req 3.2),
 *     executable === false (Req 3.3), limit param.
 */

import { describe, it, expect } from "vitest";
import type { GatewayDeps } from "./dto.js";
import {
  handleGetCanonicalEvent,
  handleListCanonicalEvents,
  handleListSignals,
} from "./handlers.js";
import { NotFoundError } from "./errors.js";
import {
  FakeCanonicalEventReader,
  FakeHotPriceReader,
  FakeOutcomesByIdReader,
  FakeSourceReader,
  makeFakeCanonicalEvent,
  yesNoOutcomes,
  type FakeCanonicalEvent,
} from "./test-support.js";

const NOW = Date.UTC(2025, 0, 1, 0, 0, 0);

function buildDeps(
  events: FakeCanonicalEvent[],
  options: Partial<Pick<GatewayDeps, "hotPrices" | "outcomes">> = {},
): GatewayDeps {
  // The default outcome reader resolves Yes implied prob from each linked
  // market's comparison-member prob (kept in sync by makeFakeCanonicalEvent).
  const outcomeEntries: Record<string, ReturnType<typeof yesNoOutcomes>> = {};
  for (const e of events) {
    for (const member of e.members) {
      outcomeEntries[member.marketId] = yesNoOutcomes(member.marketId, member.yesImpliedProb);
    }
  }

  return {
    discovery: { listMarkets: async () => [], getMarketDetail: async () => null },
    outcomes: options.outcomes ?? new FakeOutcomesByIdReader(outcomeEntries),
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
    hotPrices: options.hotPrices,
    now: () => NOW,
  };
}

const CANON_A = "aaaaaaaa-1111-1111-1111-111111111111";
const CANON_B = "bbbbbbbb-2222-2222-2222-222222222222";

describe("handleListCanonicalEvents", () => {
  it("returns canonical summaries with member/mismatch counts (Req 2.1)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      title: "BTC > 100k",
      members: [
        { marketId: "m-poly", sourceKey: "polymarket", yesImpliedProb: 0.6 },
        { marketId: "m-mani", sourceKey: "manifold", yesImpliedProb: 0.7 },
        { marketId: "m-mm", sourceKey: "manifold", yesImpliedProb: 0.9, resolutionMismatch: true },
      ],
    });
    const deps = buildDeps([event]);

    const res = await handleListCanonicalEvents(deps, {});
    expect(res.canonicalEvents).toHaveLength(1);
    expect(res.canonicalEvents[0]).toMatchObject({
      id: CANON_A,
      title: "BTC > 100k",
      category: "crypto",
      memberCount: 3,
      mismatchCount: 1,
    });
    expect(res.filter.category).toBeNull();
  });

  it("filters by category (Req 2.1)", async () => {
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
    const deps = buildDeps([crypto, politics]);

    const res = await handleListCanonicalEvents(deps, { category: "politics" });
    expect(res.canonicalEvents.map((e) => e.id)).toEqual([CANON_B]);
    expect(res.filter.category).toBe("politics");
  });
});

describe("handleGetCanonicalEvent", () => {
  it("returns the comparison view with per-platform rows + trade links (Req 2.1)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        {
          marketId: "m-poly",
          sourceKey: "polymarket",
          sourceName: "Polymarket",
          yesImpliedProb: 0.55,
          volume24h: 1000,
        },
        {
          marketId: "m-mani",
          sourceKey: "manifold",
          sourceName: "Manifold",
          yesImpliedProb: 0.7,
          volume24h: 250,
        },
      ],
    });
    const deps = buildDeps([event]);

    const view = await handleGetCanonicalEvent(deps, CANON_A);
    expect(view.canonicalEvent.id).toBe(CANON_A);
    expect(view.rows).toHaveLength(2);

    const poly = view.rows.find((r) => r.source.key === "polymarket")!;
    expect(poly).toMatchObject({
      source: { key: "polymarket", name: "Polymarket" },
      marketId: "m-poly",
      impliedProb: 0.55,
      volume24h: 1000,
      resolutionMismatch: false,
      tradeLink: "/api/markets/m-poly/trade-link",
    });
    // maxSpread over the two aligned rows: 0.7 - 0.55.
    expect(view.maxSpread).toBeCloseTo(0.15, 10);
  });

  it("flags mismatched rows and excludes them from maxSpread (Req 2.3)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        { marketId: "m-poly", sourceKey: "polymarket", yesImpliedProb: 0.4 },
        { marketId: "m-mani", sourceKey: "manifold", yesImpliedProb: 0.5 },
        // A wildly different prob, but mismatched → must not widen the spread.
        { marketId: "m-bad", sourceKey: "kalshi", yesImpliedProb: 0.99, resolutionMismatch: true },
      ],
    });
    const deps = buildDeps([event]);

    const view = await handleGetCanonicalEvent(deps, CANON_A);
    expect(view.rows).toHaveLength(3);
    const bad = view.rows.find((r) => r.marketId === "m-bad")!;
    expect(bad.resolutionMismatch).toBe(true);
    // Spread is 0.5 - 0.4 (the mismatched 0.99 row is excluded).
    expect(view.maxSpread).toBeCloseTo(0.1, 10);
  });

  it("returns rows but null maxSpread when fewer than two aligned markets (Req 2.4)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        { marketId: "m-poly", sourceKey: "polymarket", yesImpliedProb: 0.4 },
        { marketId: "m-mm", sourceKey: "manifold", yesImpliedProb: 0.8, resolutionMismatch: true },
      ],
    });
    const deps = buildDeps([event]);

    const view = await handleGetCanonicalEvent(deps, CANON_A);
    expect(view.rows).toHaveLength(2);
    expect(view.maxSpread).toBeNull();
  });

  it("excludes non-open rows from maxSpread (Req 2.3/2.4)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        { marketId: "m-open", sourceKey: "polymarket", yesImpliedProb: 0.4 },
        { marketId: "m-closed", sourceKey: "manifold", yesImpliedProb: 0.9, status: "closed" },
      ],
    });
    const deps = buildDeps([event]);

    const view = await handleGetCanonicalEvent(deps, CANON_A);
    expect(view.rows).toHaveLength(2);
    // Only one open aligned row → no spread.
    expect(view.maxSpread).toBeNull();
  });

  it("overlays a row's implied prob from the hot cache (Req 10.4)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        {
          marketId: "m-poly",
          externalId: "ext-poly",
          sourceKey: "polymarket",
          yesImpliedProb: 0.5,
        },
        { marketId: "m-mani", externalId: "ext-mani", sourceKey: "manifold", yesImpliedProb: 0.6 },
      ],
    });
    const hot = new FakeHotPriceReader({
      "ext-poly": [
        {
          marketId: "ext-poly",
          outcomeLabel: "Yes",
          price: 0.82,
          volume: null,
          ts: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    const deps = buildDeps([event], { hotPrices: hot });

    const view = await handleGetCanonicalEvent(deps, CANON_A);
    const poly = view.rows.find((r) => r.marketId === "m-poly")!;
    expect(poly.impliedProb).toBe(0.82);
    // Spread now uses the hot price: 0.82 - 0.6.
    expect(view.maxSpread).toBeCloseTo(0.22, 10);
  });

  it("throws NotFoundError for an unknown canonical event id", async () => {
    const deps = buildDeps([makeFakeCanonicalEvent({ id: CANON_A, members: [] })]);
    await expect(handleGetCanonicalEvent(deps, CANON_B)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("handleListSignals", () => {
  it("ranks signals by largest gap and marks every signal executable === false (Req 3.1/3.3)", async () => {
    const small = makeFakeCanonicalEvent({
      id: CANON_A,
      title: "Small gap",
      members: [
        {
          marketId: "s1",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.45,
        },
        { marketId: "s2", sourceId: "src-manifold", sourceKey: "manifold", yesImpliedProb: 0.55 },
      ],
    });
    const big = makeFakeCanonicalEvent({
      id: CANON_B,
      title: "Big gap",
      members: [
        {
          marketId: "b1",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.1,
        },
        { marketId: "b2", sourceId: "src-manifold", sourceKey: "manifold", yesImpliedProb: 0.9 },
      ],
    });
    const deps = buildDeps([small, big]);

    const res = await handleListSignals(deps, {});
    expect(res.signals.map((s) => s.canonicalEventId)).toEqual([CANON_B, CANON_A]);
    expect(res.signals[0]!.gap).toBeCloseTo(0.8, 10);
    expect(res.signals.every((s) => s.executable === false)).toBe(true);
    // Titles come from the canonical-event summaries.
    expect(res.signals[0]!.title).toBe("Big gap");
    // perPlatform uses stable source keys (mapped from internal source ids).
    expect(res.signals[0]!.perPlatform.map((p) => p.source).sort()).toEqual([
      "manifold",
      "polymarket",
    ]);
  });

  it("excludes mismatched + non-open markets from signals (Req 3.2)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        {
          marketId: "open1",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.4,
        },
        { marketId: "open2", sourceId: "src-manifold", sourceKey: "manifold", yesImpliedProb: 0.5 },
        {
          marketId: "mm",
          sourceId: "src-manifold",
          sourceKey: "manifold",
          yesImpliedProb: 0.99,
          resolutionMismatch: true,
        },
      ],
    });
    const deps = buildDeps([event]);

    const res = await handleListSignals(deps, {});
    expect(res.signals).toHaveLength(1);
    // Gap excludes the mismatched 0.99 leg: 0.5 - 0.4.
    expect(res.signals[0]!.gap).toBeCloseTo(0.1, 10);
    expect(res.signals[0]!.perPlatform).toHaveLength(2);
  });

  it("omits canonical events with fewer than two aligned markets (Req 3.4)", async () => {
    const usable = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        {
          marketId: "u1",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.3,
        },
        { marketId: "u2", sourceId: "src-manifold", sourceKey: "manifold", yesImpliedProb: 0.7 },
      ],
    });
    const insufficient = makeFakeCanonicalEvent({
      id: CANON_B,
      members: [
        {
          marketId: "only",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.5,
        },
      ],
    });
    const deps = buildDeps([usable, insufficient]);

    const res = await handleListSignals(deps, {});
    expect(res.signals.map((s) => s.canonicalEventId)).toEqual([CANON_A]);
  });

  it("applies the limit param to the ranked list", async () => {
    const events = [0.8, 0.6, 0.4, 0.2].map((gap, i) =>
      makeFakeCanonicalEvent({
        id: `0000000${i}-0000-0000-0000-00000000000${i}`,
        title: `gap-${gap}`,
        members: [
          {
            marketId: `a${i}`,
            sourceId: "src-polymarket",
            sourceKey: "polymarket",
            yesImpliedProb: 0.5 - gap / 2,
          },
          {
            marketId: `b${i}`,
            sourceId: "src-manifold",
            sourceKey: "manifold",
            yesImpliedProb: 0.5 + gap / 2,
          },
        ],
      }),
    );
    const deps = buildDeps(events);

    const res = await handleListSignals(deps, { limit: 2 });
    expect(res.signals).toHaveLength(2);
    expect(res.limit).toBe(2);
    // Highest gaps first.
    expect(res.signals.map((s) => s.gap).map((g) => Math.round(g * 100))).toEqual([80, 60]);
  });

  it("prefers the hot cache when resolving Yes implied prob (Req 10.4)", async () => {
    const event = makeFakeCanonicalEvent({
      id: CANON_A,
      members: [
        {
          marketId: "m1",
          externalId: "ext-1",
          sourceId: "src-polymarket",
          sourceKey: "polymarket",
          yesImpliedProb: 0.5,
        },
        {
          marketId: "m2",
          externalId: "ext-2",
          sourceId: "src-manifold",
          sourceKey: "manifold",
          yesImpliedProb: 0.5,
        },
      ],
    });
    const hot = new FakeHotPriceReader({
      "ext-1": [
        {
          marketId: "ext-1",
          outcomeLabel: "Yes",
          price: 0.2,
          volume: null,
          ts: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    const deps = buildDeps([event], { hotPrices: hot });

    const res = await handleListSignals(deps, {});
    expect(res.signals).toHaveLength(1);
    // m1 comes from the hot cache (0.2), m2 from stored (0.5) → gap 0.3.
    expect(res.signals[0]!.gap).toBeCloseTo(0.3, 10);
  });
});
