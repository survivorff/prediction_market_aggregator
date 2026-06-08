import { describe, it, expect } from "vitest";
import {
  mapBetsToPriceHistory,
  mapCategory,
  mapMarket,
  mapMarketStatus,
  mapOutcomes,
  mapPriceSnapshot,
  mapResolutionCriteria,
  NO_LABEL,
  YES_LABEL,
} from "./mapper.js";

/**
 * Unit tests for the pure Manifold → normalized mapper. They exercise the core
 * mapping rules without any network: a binary contract's `probability` →
 * Yes-outcome implied probability (design "Manifold adapter notes"), raw
 * resolution-criteria preservation (Requirement 10.3), explicit-null for
 * missing fields (Requirement 1.5), probability bounds (Requirement 1.3), and
 * the bets → price-history mapping (Requirement 4.2).
 */

const NOW = new Date("2025-01-01T00:00:00.000Z");

describe("mapCategory", () => {
  it("maps already-normalized categories directly", () => {
    expect(mapCategory("crypto")).toBe("crypto");
    expect(mapCategory("Politics")).toBe("politics");
  });

  it("maps Manifold group slugs onto the taxonomy", () => {
    expect(mapCategory("us-politics")).toBe("politics");
    expect(mapCategory("Bitcoin")).toBe("crypto");
    expect(mapCategory("nba-finals")).toBe("sports");
    expect(mapCategory("fed-rate-decision")).toBe("economics");
    expect(mapCategory("ai-progress")).toBe("tech");
  });

  it("falls back to other for unknown or missing values", () => {
    expect(mapCategory("personal-goals")).toBe("other");
    expect(mapCategory(undefined)).toBe("other");
    expect(mapCategory(null)).toBe("other");
  });
});

describe("mapMarketStatus", () => {
  it("derives open for an unresolved contract closing in the future", () => {
    expect(mapMarketStatus({ closeTime: Date.parse("2025-06-01T00:00:00Z") }, NOW)).toBe("open");
  });

  it("derives closed when closeTime is in the past and unresolved", () => {
    expect(mapMarketStatus({ closeTime: Date.parse("2024-06-01T00:00:00Z") }, NOW)).toBe("closed");
  });

  it("derives resolved from isResolved", () => {
    expect(mapMarketStatus({ isResolved: true }, NOW)).toBe("resolved");
  });

  it("derives resolved from a resolution value", () => {
    expect(mapMarketStatus({ resolution: "YES" }, NOW)).toBe("resolved");
  });

  it("honors an explicit normalized status string", () => {
    expect(mapMarketStatus({ status: "closed" }, NOW)).toBe("closed");
  });
});

describe("mapOutcomes — binary contract", () => {
  it("maps the probability field as the Yes implied probability", () => {
    const outcomes = mapOutcomes({ probability: 0.62 });
    expect(outcomes).toHaveLength(2);
    const [yes, no] = outcomes;
    expect(yes?.label).toBe(YES_LABEL);
    expect(yes?.impliedProb).toBeCloseTo(0.62, 6);
    expect(yes?.lastPrice).toBeCloseTo(0.62, 6);
    // Manifold is off-chain — no outcome tokens.
    expect(yes?.tokenId).toBeNull();
    expect(no?.label).toBe(NO_LABEL);
    expect(no?.impliedProb).toBeCloseTo(0.38, 6);
  });

  it("reconciles Yes/No to sum to ~1 and keeps values in [0,1]", () => {
    const outcomes = mapOutcomes({ probability: 0.7 });
    const sum = (outcomes[0]?.impliedProb ?? 0) + (outcomes[1]?.impliedProb ?? 0);
    expect(sum).toBeCloseTo(1, 6);
    for (const o of outcomes) {
      expect(o.impliedProb).toBeGreaterThanOrEqual(0);
      expect(o.impliedProb).toBeLessThanOrEqual(1);
    }
  });

  it("clamps an out-of-range probability into [0,1]", () => {
    const outcomes = mapOutcomes({ probability: 1.4 });
    expect(outcomes[0]?.impliedProb).toBe(1);
    expect(outcomes[1]?.impliedProb).toBe(0);
  });

  it("represents a missing probability as null rather than throwing", () => {
    const outcomes = mapOutcomes({});
    expect(outcomes.map((o) => o.label)).toEqual([YES_LABEL, NO_LABEL]);
    expect(outcomes[0]?.impliedProb).toBeNull();
    expect(outcomes[1]?.impliedProb).toBeNull();
  });

  it("maps a multi-answer contract into one outcome per answer", () => {
    const outcomes = mapOutcomes({
      answers: [
        { text: "Alice", probability: 0.5 },
        { text: "Bob", probability: 0.3 },
        { text: "Carol", probability: 0.2 },
      ],
    });
    expect(outcomes.map((o) => o.label)).toEqual(["Alice", "Bob", "Carol"]);
    expect(outcomes[0]?.impliedProb).toBeCloseTo(0.5, 6);
    expect(outcomes.every((o) => o.tokenId === null)).toBe(true);
  });
});

describe("mapResolutionCriteria", () => {
  it("preserves raw criteria and captures closeTime as cutoff", () => {
    const criteria = mapResolutionCriteria({
      closeTime: Date.parse("2025-06-01T00:00:00Z"),
      outcomeType: "BINARY",
      resolution: "YES",
      groupSlugs: ["us-politics"],
    });
    // Manifold settles by creator resolution — no external data source.
    expect(criteria.dataSource).toBeNull();
    expect(criteria.cutoffTime).toBe("2025-06-01T00:00:00.000Z");
    expect(criteria.raw).toMatchObject({
      outcomeType: "BINARY",
      resolution: "YES",
    });
  });

  it("preserves raw even when structured fields are absent (Req 10.3)", () => {
    const criteria = mapResolutionCriteria({ outcomeType: "MULTIPLE_CHOICE" });
    expect(criteria.dataSource).toBeNull();
    expect(criteria.cutoffTime).toBeNull();
    expect(criteria.rounding).toBeNull();
    expect(criteria.raw).toMatchObject({ outcomeType: "MULTIPLE_CHOICE" });
  });
});

describe("mapMarket", () => {
  const rawContract = {
    id: "contract-1",
    question: "Will it rain tomorrow?",
    probability: 0.55,
    closeTime: Date.parse("2025-06-01T00:00:00Z"),
    volume24Hours: 1234.5,
    totalLiquidity: 789,
    isResolved: false,
    outcomeType: "BINARY",
    groupSlugs: ["weather", "fun"],
  };

  it("maps a full Manifold contract into a NormalizedMarket", () => {
    const market = mapMarket(rawContract, NOW);
    expect(market).not.toBeNull();
    expect(market?.externalId).toBe("contract-1");
    expect(market?.eventExternalId).toBe("weather");
    expect(market?.question).toBe("Will it rain tomorrow?");
    expect(market?.status).toBe("open");
    expect(market?.volume24h).toBeCloseTo(1234.5, 3);
    expect(market?.liquidity).toBeCloseTo(789, 3);
    expect(market?.outcomes).toHaveLength(2);
    expect(market?.outcomes[0]?.label).toBe(YES_LABEL);
    expect(market?.outcomes[0]?.impliedProb).toBeCloseTo(0.55, 6);
  });

  it("returns null without a native id", () => {
    expect(mapMarket({ question: "no id" }, NOW)).toBeNull();
  });

  it("represents missing numeric metadata as null (Req 1.5)", () => {
    const market = mapMarket({ id: "c2", question: "Q" }, NOW);
    expect(market?.volume24h).toBeNull();
    expect(market?.liquidity).toBeNull();
    expect(market?.spread).toBeNull();
    expect(market?.eventExternalId).toBeNull();
  });
});

describe("mapPriceSnapshot", () => {
  it("normalizes the contract probability into a Yes snapshot", () => {
    const snap = mapPriceSnapshot({
      marketExternalId: "contract-1",
      rawProbability: 0.73,
      ts: "2025-01-01T00:00:00.000Z",
    });
    expect(snap?.price).toBeCloseTo(0.73, 6);
    expect(snap?.outcomeLabel).toBe(YES_LABEL);
    expect(snap?.marketExternalId).toBe("contract-1");
  });

  it("returns null for an unparseable probability", () => {
    const snap = mapPriceSnapshot({
      marketExternalId: "c",
      rawProbability: "not-a-number",
      ts: "2025-01-01T00:00:00.000Z",
    });
    expect(snap).toBeNull();
  });
});

describe("mapBetsToPriceHistory", () => {
  it("maps bets' probAfter/createdTime into an ascending Yes series", () => {
    // Provided newest-first (as Manifold returns them); result is ascending.
    const points = mapBetsToPriceHistory({
      marketExternalId: "contract-1",
      rawBets: [
        { probAfter: 0.6, createdTime: 1700003600000, amount: 10 },
        { probAfter: 0.5, createdTime: 1700000000000, amount: 5 },
      ],
    });
    expect(points).toHaveLength(2);
    expect(points[0]?.price).toBeCloseTo(0.5, 6);
    expect(points[1]?.price).toBeCloseTo(0.6, 6);
    expect(points[0]?.outcomeLabel).toBe(YES_LABEL);
    expect(Date.parse(points[0]!.ts)).toBeLessThan(Date.parse(points[1]!.ts));
  });

  it("skips bets with unparseable prob/time and clamps out-of-range", () => {
    const points = mapBetsToPriceHistory({
      marketExternalId: "contract-1",
      rawBets: [
        { probAfter: 1.5, createdTime: 1700000000000 }, // clamped to 1
        { probAfter: "bad", createdTime: 1700003600000 }, // skipped
        { probAfter: 0.4, createdTime: "nope" }, // skipped
      ],
    });
    expect(points).toHaveLength(1);
    expect(points[0]?.price).toBe(1);
  });

  it("returns an empty array for a malformed payload", () => {
    expect(mapBetsToPriceHistory({ marketExternalId: "c", rawBets: null })).toEqual([]);
  });
});
