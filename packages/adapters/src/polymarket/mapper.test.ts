import { describe, it, expect } from "vitest";
import {
  mapCategory,
  mapEvent,
  mapMarket,
  mapMarketStatus,
  mapOrderBookDepth,
  mapOutcomes,
  mapPriceHistory,
  mapPriceSnapshot,
  mapResolutionCriteria,
  NO_LABEL,
  YES_LABEL,
} from "./mapper.js";

/**
 * Unit tests for the pure Polymarket → normalized mapper. They exercise the
 * core mapping rules without any network: binary Yes/No → outcomes with the
 * Yes-token price as implied probability (design "Polymarket adapter notes"),
 * raw resolution-criteria preservation (Requirement 10.3), explicit-null for
 * missing fields (Requirement 1.5), and probability bounds (Requirement 1.3).
 */

describe("mapCategory", () => {
  it("maps already-normalized categories directly", () => {
    expect(mapCategory("crypto")).toBe("crypto");
    expect(mapCategory("Politics")).toBe("politics");
  });

  it("maps platform label aliases onto the taxonomy", () => {
    expect(mapCategory("US-current-affairs Election")).toBe("politics");
    expect(mapCategory("Bitcoin")).toBe("crypto");
    expect(mapCategory("NBA Finals")).toBe("sports");
    expect(mapCategory("Fed rate decision")).toBe("economics");
    expect(mapCategory("AI breakthroughs")).toBe("tech");
  });

  it("falls back to other for unknown or missing values", () => {
    expect(mapCategory("something weird")).toBe("other");
    expect(mapCategory(undefined)).toBe("other");
    expect(mapCategory(null)).toBe("other");
  });
});

describe("mapMarketStatus", () => {
  it("derives open when not closed/archived/resolved", () => {
    expect(mapMarketStatus({ active: true, closed: false })).toBe("open");
  });

  it("derives closed from closed/archived flags", () => {
    expect(mapMarketStatus({ closed: true })).toBe("closed");
    expect(mapMarketStatus({ archived: true })).toBe("closed");
  });

  it("derives resolved from uma resolution status", () => {
    expect(mapMarketStatus({ umaResolutionStatus: "resolved" })).toBe("resolved");
  });

  it("honors an explicit normalized status string", () => {
    expect(mapMarketStatus({ status: "resolved" })).toBe("resolved");
  });
});

describe("mapOutcomes — binary Yes/No", () => {
  it("maps the Yes-token price as the implied probability", () => {
    const outcomes = mapOutcomes({
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.62", "0.38"]),
      clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
    });

    expect(outcomes).toHaveLength(2);
    const [yes, no] = outcomes;
    expect(yes?.label).toBe("Yes");
    expect(yes?.tokenId).toBe("yes-token");
    expect(yes?.impliedProb).toBeCloseTo(0.62, 6);
    expect(yes?.lastPrice).toBeCloseTo(0.62, 6);
    expect(no?.label).toBe("No");
    expect(no?.tokenId).toBe("no-token");
    expect(no?.impliedProb).toBeCloseTo(0.38, 6);
  });

  it("accepts already-parsed arrays (not just stringified)", () => {
    const outcomes = mapOutcomes({
      outcomes: ["Yes", "No"],
      outcomePrices: [0.5, 0.5],
      clobTokenIds: ["a", "b"],
    });
    expect(outcomes.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(outcomes[0]?.impliedProb).toBeCloseTo(0.5, 6);
  });

  it("reconciles a binary pair to sum to ~1 and keeps values in [0,1]", () => {
    const outcomes = mapOutcomes({
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.8", "0.4"]), // sums to 1.2
    });
    const sum = (outcomes[0]?.impliedProb ?? 0) + (outcomes[1]?.impliedProb ?? 0);
    expect(sum).toBeCloseTo(1, 6);
    for (const o of outcomes) {
      expect(o.impliedProb).toBeGreaterThanOrEqual(0);
      expect(o.impliedProb).toBeLessThanOrEqual(1);
    }
  });

  it("clamps an out-of-range price into [0,1]", () => {
    const outcomes = mapOutcomes({
      outcomes: JSON.stringify(["Yes", "No", "Maybe"]),
      outcomePrices: JSON.stringify(["1.4", "-0.2", "0.5"]),
    });
    expect(outcomes[0]?.impliedProb).toBe(1);
    expect(outcomes[1]?.impliedProb).toBe(0);
    expect(outcomes[2]?.impliedProb).toBeCloseTo(0.5, 6);
  });

  it("defaults to a Yes/No pair when no outcome arrays are present", () => {
    const outcomes = mapOutcomes({});
    expect(outcomes.map((o) => o.label)).toEqual([YES_LABEL, NO_LABEL]);
    expect(outcomes[0]?.impliedProb).toBeNull();
    expect(outcomes[0]?.tokenId).toBeNull();
  });

  it("represents a missing price as null rather than throwing", () => {
    const outcomes = mapOutcomes({
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify(["0.7"]), // only one price
      clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
    });
    expect(outcomes[0]?.impliedProb).toBeCloseTo(0.7, 6);
    expect(outcomes[1]?.impliedProb).toBeNull();
  });
});

describe("mapResolutionCriteria", () => {
  it("preserves raw criteria even when structured fields are present", () => {
    const criteria = mapResolutionCriteria({
      resolutionSource: "AP race call",
      endDate: "2024-11-05T00:00:00Z",
      description: "Resolves Yes if ...",
    });
    expect(criteria.dataSource).toBe("AP race call");
    expect(criteria.cutoffTime).toBe("2024-11-05T00:00:00.000Z");
    expect(criteria.raw).toMatchObject({
      resolutionSource: "AP race call",
      endDate: "2024-11-05T00:00:00Z",
    });
  });

  it("preserves raw even when structured fields cannot be parsed (Req 10.3)", () => {
    const criteria = mapResolutionCriteria({
      someUnknownField: { nested: true },
    });
    expect(criteria.dataSource).toBeNull();
    expect(criteria.cutoffTime).toBeNull();
    expect(criteria.rounding).toBeNull();
    // raw is always an object, never lost.
    expect(criteria.raw).toBeTypeOf("object");
  });
});

describe("mapMarket", () => {
  const rawMarket = {
    id: "0xabc",
    question: "Will it rain tomorrow?",
    eventId: "evt-1",
    closed: false,
    active: true,
    volume24hr: "12345.6",
    liquidity: "789.0",
    spread: "0.02",
    outcomes: JSON.stringify(["Yes", "No"]),
    outcomePrices: JSON.stringify(["0.55", "0.45"]),
    clobTokenIds: JSON.stringify(["t-yes", "t-no"]),
    resolutionSource: "NWS",
    endDate: "2025-01-01T00:00:00Z",
  };

  it("maps a full Gamma market into a NormalizedMarket", () => {
    const market = mapMarket(rawMarket);
    expect(market).not.toBeNull();
    expect(market?.externalId).toBe("0xabc");
    expect(market?.eventExternalId).toBe("evt-1");
    expect(market?.question).toBe("Will it rain tomorrow?");
    expect(market?.status).toBe("open");
    expect(market?.volume24h).toBeCloseTo(12345.6, 3);
    expect(market?.liquidity).toBeCloseTo(789, 3);
    expect(market?.spread).toBeCloseTo(0.02, 6);
    expect(market?.outcomes).toHaveLength(2);
    expect(market?.resolutionCriteria.dataSource).toBe("NWS");
  });

  it("uses the native id as externalId and returns null without one", () => {
    expect(mapMarket({ question: "no id" })).toBeNull();
  });

  it("extracts event id from an embedded events array", () => {
    const market = mapMarket({
      id: "m1",
      question: "Q",
      events: [{ id: "embedded-evt" }],
    });
    expect(market?.eventExternalId).toBe("embedded-evt");
  });

  it("represents missing numeric metadata as null (Req 1.5)", () => {
    const market = mapMarket({ id: "m2", question: "Q" });
    expect(market?.volume24h).toBeNull();
    expect(market?.liquidity).toBeNull();
    expect(market?.spread).toBeNull();
  });

  it("normalizes a negative spread to 0", () => {
    const market = mapMarket({ id: "m3", question: "Q", spread: "-0.1" });
    expect(market?.spread).toBe(0);
  });
});

describe("mapEvent", () => {
  it("maps a Gamma event into a NormalizedEvent", () => {
    const event = mapEvent({
      id: "evt-1",
      title: "US Election 2024",
      endDate: "2024-11-05T00:00:00Z",
      tags: [{ label: "Politics" }],
      description: "resolves on AP call",
    });
    expect(event?.externalId).toBe("evt-1");
    expect(event?.title).toBe("US Election 2024");
    expect(event?.category).toBe("politics");
    expect(event?.endDate).toBe("2024-11-05T00:00:00.000Z");
    expect(event?.rawResolution).toMatchObject({
      description: "resolves on AP call",
    });
  });

  it("returns null without a native id", () => {
    expect(mapEvent({ title: "no id" })).toBeNull();
  });

  it("represents a missing endDate as null", () => {
    const event = mapEvent({ id: "e", title: "t" });
    expect(event?.endDate).toBeNull();
  });
});

describe("mapPriceSnapshot", () => {
  it("normalizes the Yes-token price into [0,1]", () => {
    const snap = mapPriceSnapshot({
      marketExternalId: "t-yes",
      outcomeLabel: YES_LABEL,
      rawPrice: "0.73",
      ts: "2025-01-01T00:00:00.000Z",
    });
    expect(snap?.price).toBeCloseTo(0.73, 6);
    expect(snap?.outcomeLabel).toBe(YES_LABEL);
  });

  it("returns null for an unparseable price", () => {
    const snap = mapPriceSnapshot({
      marketExternalId: "t",
      outcomeLabel: YES_LABEL,
      rawPrice: "not-a-number",
      ts: "2025-01-01T00:00:00.000Z",
    });
    expect(snap).toBeNull();
  });
});

describe("mapPriceHistory", () => {
  it("maps a CLOB history payload, skipping malformed points", () => {
    const points = mapPriceHistory({
      marketExternalId: "t-yes",
      outcomeLabel: YES_LABEL,
      rawHistory: {
        history: [
          { t: 1700000000, p: "0.5" },
          { t: 1700003600, p: "0.6" },
          { t: "bad", p: "0.7" }, // skipped
          { t: 1700007200, p: "nope" }, // skipped
        ],
      },
    });
    expect(points).toHaveLength(2);
    expect(points[0]?.price).toBeCloseTo(0.5, 6);
    expect(points[1]?.price).toBeCloseTo(0.6, 6);
    expect(points[0]?.ts).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("returns an empty array for a malformed payload", () => {
    expect(
      mapPriceHistory({
        marketExternalId: "t",
        outcomeLabel: YES_LABEL,
        rawHistory: null,
      }),
    ).toEqual([]);
  });
});

describe("mapOrderBookDepth", () => {
  it("maps bids/asks and drops malformed levels", () => {
    const depth = mapOrderBookDepth({
      asset_id: "t-yes",
      bids: [
        { price: "0.5", size: "100" },
        { price: "bad", size: "10" }, // dropped
      ],
      asks: [{ price: "0.52", size: "200" }],
    });
    expect(depth.tokenId).toBe("t-yes");
    expect(depth.bids).toHaveLength(1);
    expect(depth.bids[0]).toEqual({ price: 0.5, size: 100 });
    expect(depth.asks).toHaveLength(1);
    expect(depth.asks[0]).toEqual({ price: 0.52, size: 200 });
  });

  it("returns empty ladders for a malformed book", () => {
    const depth = mapOrderBookDepth(null);
    expect(depth.tokenId).toBeNull();
    expect(depth.bids).toEqual([]);
    expect(depth.asks).toEqual([]);
  });
});
