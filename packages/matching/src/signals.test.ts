import { describe, it, expect } from "vitest";
import type {
  CanonicalEvent,
  CandidateQuery,
  CanonicalLinkOptions,
  LinkedMarket,
  Market,
  MarketStatus,
  MatchingRepository,
  ResolutionCriteria,
} from "@pma/core";
import {
  computeSignals,
  computeSignalsForMany,
  rankSignals,
  type SpreadSignal,
} from "./signals.js";

/**
 * Unit tests for spread / signal computation (task 6.5): `computeSignals` over
 * a canonical event's open, resolution-aligned markets, plus the `rankSignals`
 * / `computeSignalsForMany` ranking helpers.
 *
 * Covered:
 *   - filters out closed/resolved markets;
 *   - filters out resolutionMismatch=true markets;
 *   - returns [] when fewer than two aligned markets (incl. mismatch/closed
 *     reducing the count below two);
 *   - computes the correct max-min gap with >= 2 aligned markets;
 *   - perPlatform carries per-source probabilities;
 *   - markets with a null/unusable Yes implied probability are dropped;
 *   - every returned signal has executable === false;
 *   - ranking orders signals by gap descending.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

// --- fixtures --------------------------------------------------------------

function criteria(overrides: Partial<ResolutionCriteria> = {}): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {}, ...overrides };
}

let marketSeq = 0;

function linkedMarket(overrides: Partial<LinkedMarket> = {}): LinkedMarket {
  marketSeq += 1;
  return {
    id: `m-${marketSeq}`,
    sourceId: "polymarket",
    eventId: null,
    canonicalEventId: "canon-1",
    externalId: `ext-${marketSeq}`,
    question: "Will BTC close above $100,000 in 2025?",
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    resolutionMismatch: false,
    ...overrides,
  };
}

/**
 * Fake {@link MatchingRepository} returning a fixed set of linked markets for a
 * canonical event. `findCandidates` / `linkToCanonical` are unused by signal
 * computation and reject if called.
 */
class FakeMatchingRepository implements MatchingRepository {
  constructor(private readonly byCanonical: Record<string, LinkedMarket[]>) {}

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.reject(new Error("findCandidates is not used by computeSignals"));
  }

  linkToCanonical(_a: Market, _b: Market, _options: CanonicalLinkOptions): Promise<CanonicalEvent> {
    return Promise.reject(new Error("linkToCanonical is not used by computeSignals"));
  }

  marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    return Promise.resolve(this.byCanonical[canonicalEventId] ?? []);
  }
}

/**
 * Build a Yes-implied-probability resolver from an explicit market-id → prob
 * map. A missing entry resolves to `null` (unavailable).
 */
function probResolver(
  probByMarketId: Record<string, number | null>,
): (m: LinkedMarket) => Promise<number | null> {
  return (m: LinkedMarket) => Promise.resolve(probByMarketId[m.id] ?? null);
}

// --- computeSignals: filtering (Requirement 3.2) ---------------------------

describe("computeSignals — filtering", () => {
  it("filters out closed and resolved markets, keeping only open ones", async () => {
    const open1 = linkedMarket({ id: "open-1", sourceId: "polymarket", status: "open" });
    const open2 = linkedMarket({ id: "open-2", sourceId: "manifold", status: "open" });
    const closed = linkedMarket({ id: "closed-1", status: "closed" as MarketStatus });
    const resolved = linkedMarket({ id: "resolved-1", status: "resolved" as MarketStatus });
    const repo = new FakeMatchingRepository({
      "canon-1": [open1, closed, open2, resolved],
    });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({
        "open-1": 0.4,
        "open-2": 0.7,
        "closed-1": 0.1,
        "resolved-1": 0.9,
      }),
    });

    expect(signals).toHaveLength(1);
    const sources = signals[0]?.perPlatform.map((leg) => leg.source).sort();
    expect(sources).toEqual(["manifold", "polymarket"]);
    // Gap is computed only across the two open markets (0.7 - 0.4), not the
    // closed/resolved ones (which would have widened it).
    expect(signals[0]?.gap).toBeCloseTo(0.3, 10);
  });

  it("filters out resolutionMismatch=true markets", async () => {
    const aligned1 = linkedMarket({ id: "a-1", sourceId: "polymarket", resolutionMismatch: false });
    const aligned2 = linkedMarket({ id: "a-2", sourceId: "manifold", resolutionMismatch: false });
    const mismatched = linkedMarket({ id: "mm-1", resolutionMismatch: true });
    const repo = new FakeMatchingRepository({
      "canon-1": [aligned1, mismatched, aligned2],
    });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ "a-1": 0.2, "a-2": 0.5, "mm-1": 0.99 }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.perPlatform.map((l) => l.source).sort()).toEqual(["manifold", "polymarket"]);
    // The mismatched market (prob 0.99) is excluded from the gap.
    expect(signals[0]?.gap).toBeCloseTo(0.3, 10);
  });
});

// --- computeSignals: insufficient markets (Requirement 3.4) ----------------

describe("computeSignals — insufficient aligned markets", () => {
  it("returns [] when no markets are linked", async () => {
    const repo = new FakeMatchingRepository({});
    const signals = await computeSignals("missing", {
      repo,
      getYesImpliedProb: probResolver({}),
    });
    expect(signals).toEqual([]);
  });

  it("returns [] when only one aligned market exists", async () => {
    const only = linkedMarket({ id: "only" });
    const repo = new FakeMatchingRepository({ "canon-1": [only] });
    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ only: 0.5 }),
    });
    expect(signals).toEqual([]);
  });

  it("returns [] when mismatch/closed reduce the aligned count below two", async () => {
    const open = linkedMarket({ id: "open-1", status: "open" });
    const closed = linkedMarket({ id: "closed-1", status: "closed" as MarketStatus });
    const mismatched = linkedMarket({ id: "mm-1", resolutionMismatch: true });
    const repo = new FakeMatchingRepository({
      "canon-1": [open, closed, mismatched],
    });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({
        "open-1": 0.4,
        "closed-1": 0.6,
        "mm-1": 0.8,
      }),
    });

    expect(signals).toEqual([]);
  });
});

// --- computeSignals: null/unusable probabilities ---------------------------

describe("computeSignals — null / unusable Yes probabilities", () => {
  it("drops markets whose Yes implied probability is null", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const noProb = linkedMarket({ id: "c", sourceId: "kalshi" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b, noProb] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.3, b: 0.65, c: null }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.perPlatform.map((l) => l.source).sort()).toEqual(["manifold", "polymarket"]);
    expect(signals[0]?.gap).toBeCloseTo(0.35, 10);
  });

  it("returns [] when dropping unusable probs leaves fewer than two markets", async () => {
    const a = linkedMarket({ id: "a" });
    const b = linkedMarket({ id: "b" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals("canon-1", {
      repo,
      // Only one usable probability remains.
      getYesImpliedProb: probResolver({ a: 0.5, b: null }),
    });

    expect(signals).toEqual([]);
  });

  it("drops non-finite probabilities (NaN / Infinity)", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const c = linkedMarket({ id: "c", sourceId: "kalshi" });
    const d = linkedMarket({ id: "d", sourceId: "predictit" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b, c, d] });

    const probs: Record<string, number> = {
      a: 0.25,
      b: 0.75,
      c: Number.NaN,
      d: Number.POSITIVE_INFINITY,
    };
    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: (m: LinkedMarket) => Promise.resolve(probs[m.id] ?? null),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.perPlatform.map((l) => l.source).sort()).toEqual(["manifold", "polymarket"]);
    expect(signals[0]?.gap).toBeCloseTo(0.5, 10);
  });
});

// --- computeSignals: gap + perPlatform (Requirements 3.1 input, 3.2) -------

describe("computeSignals — gap and perPlatform", () => {
  it("computes the correct max-min gap across >= 2 aligned markets", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const c = linkedMarket({ id: "c", sourceId: "kalshi" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b, c] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.2, b: 0.55, c: 0.9 }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.gap).toBeCloseTo(0.7, 10); // 0.9 - 0.2
  });

  it("carries each platform's implied probability in perPlatform", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.42, b: 0.58 }),
    });

    const bySource = Object.fromEntries(
      (signals[0]?.perPlatform ?? []).map((l) => [l.source, l.impliedProb]),
    );
    expect(bySource).toEqual({ polymarket: 0.42, manifold: 0.58 });
  });

  it("yields a zero gap when aligned markets agree exactly", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.5, b: 0.5 }),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.gap).toBe(0);
  });

  it("uses the injected source resolver for per-platform labels", async () => {
    const a = linkedMarket({ id: "a", sourceId: "src-uuid-1" });
    const b = linkedMarket({ id: "b", sourceId: "src-uuid-2" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const slugs: Record<string, string> = {
      "src-uuid-1": "polymarket",
      "src-uuid-2": "manifold",
    };
    const signals = await computeSignals(
      "canon-1",
      { repo, getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }) },
      { resolveSource: (m) => slugs[m.sourceId] ?? m.sourceId },
    );

    expect(signals[0]?.perPlatform.map((l) => l.source).sort()).toEqual(["manifold", "polymarket"]);
  });
});

// --- computeSignals: title (contract field) --------------------------------

describe("computeSignals — title", () => {
  it("falls back to the canonicalEventId when no title resolver is given", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }),
    });

    expect(signals[0]?.title).toBe("canon-1");
  });

  it("uses the resolved title when a resolver is provided", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals(
      "canon-1",
      { repo, getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }) },
      { resolveTitle: () => Promise.resolve("BTC > $100k (2025)") },
    );

    expect(signals[0]?.title).toBe("BTC > $100k (2025)");
  });

  it("falls back to the id when the resolver returns blank/null", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const blank = await computeSignals(
      "canon-1",
      { repo, getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }) },
      { resolveTitle: () => Promise.resolve("   ") },
    );
    expect(blank[0]?.title).toBe("canon-1");

    const nul = await computeSignals(
      "canon-1",
      { repo, getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }) },
      { resolveTitle: () => Promise.resolve(null) },
    );
    expect(nul[0]?.title).toBe("canon-1");
  });
});

// --- computeSignals: display-only invariant (Requirement 3.3) --------------

describe("computeSignals — display-only invariant", () => {
  it("marks every returned signal executable === false", async () => {
    const a = linkedMarket({ id: "a", sourceId: "polymarket" });
    const b = linkedMarket({ id: "b", sourceId: "manifold" });
    const repo = new FakeMatchingRepository({ "canon-1": [a, b] });

    const signals = await computeSignals("canon-1", {
      repo,
      getYesImpliedProb: probResolver({ a: 0.3, b: 0.6 }),
    });

    expect(signals).toHaveLength(1);
    for (const signal of signals) {
      expect(signal.executable).toBe(false);
    }
  });
});

// --- rankSignals (Requirement 3.1) -----------------------------------------

function signal(gap: number, canonicalEventId: string): SpreadSignal {
  return {
    canonicalEventId,
    title: canonicalEventId,
    perPlatform: [
      { source: "polymarket", impliedProb: 0.5 },
      { source: "manifold", impliedProb: 0.5 + gap },
    ],
    gap,
    executable: false,
  };
}

describe("rankSignals", () => {
  it("orders signals by gap descending", () => {
    const ranked = rankSignals([signal(0.1, "a"), signal(0.5, "b"), signal(0.3, "c")]);
    expect(ranked.map((s) => s.canonicalEventId)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [signal(0.1, "a"), signal(0.5, "b")];
    const snapshot = input.map((s) => s.canonicalEventId);
    rankSignals(input);
    expect(input.map((s) => s.canonicalEventId)).toEqual(snapshot);
  });

  it("preserves input order on equal gaps (stable)", () => {
    const ranked = rankSignals([signal(0.2, "first"), signal(0.2, "second")]);
    expect(ranked.map((s) => s.canonicalEventId)).toEqual(["first", "second"]);
  });

  it("returns [] for an empty input", () => {
    expect(rankSignals([])).toEqual([]);
  });
});

// --- computeSignalsForMany (Requirements 3.1, 3.4) -------------------------

describe("computeSignalsForMany", () => {
  it("computes per-event signals and ranks them by gap descending", async () => {
    const small = [
      linkedMarket({ id: "s1", sourceId: "polymarket" }),
      linkedMarket({ id: "s2", sourceId: "manifold" }),
    ];
    const big = [
      linkedMarket({ id: "b1", sourceId: "polymarket" }),
      linkedMarket({ id: "b2", sourceId: "manifold" }),
    ];
    const repo = new FakeMatchingRepository({
      "canon-small": small,
      "canon-big": big,
    });

    const signals = await computeSignalsForMany(["canon-small", "canon-big"], {
      repo,
      getYesImpliedProb: probResolver({
        s1: 0.45,
        s2: 0.55, // gap 0.1
        b1: 0.1,
        b2: 0.9, // gap 0.8
      }),
    });

    expect(signals.map((s) => s.canonicalEventId)).toEqual(["canon-big", "canon-small"]);
    expect(signals.every((s) => s.executable === false)).toBe(true);
  });

  it("omits canonical events with insufficient aligned markets", async () => {
    const usable = [
      linkedMarket({ id: "u1", sourceId: "polymarket" }),
      linkedMarket({ id: "u2", sourceId: "manifold" }),
    ];
    const insufficient = [linkedMarket({ id: "only" })];
    const repo = new FakeMatchingRepository({
      "canon-usable": usable,
      "canon-insufficient": insufficient,
    });

    const signals = await computeSignalsForMany(["canon-usable", "canon-insufficient"], {
      repo,
      getYesImpliedProb: probResolver({ u1: 0.3, u2: 0.7, only: 0.5 }),
    });

    expect(signals.map((s) => s.canonicalEventId)).toEqual(["canon-usable"]);
  });
});
