import { describe, it, expect } from "vitest";
import type {
  CanonicalEvent,
  CanonicalLinkOptions,
  CandidateQuery,
  LinkedMarket,
  Market,
  MatchingRepository,
  ResolutionCriteria,
} from "@pma/core";
import {
  DEFAULT_CUTOFF_TOLERANCE_MS,
  criteriaAligned,
  explainCriteriaAlignment,
  linkAfterAlignment,
} from "./layer4-alignment.js";

/**
 * Unit tests for Layer-4 resolution-criteria alignment + linking (task 6.4):
 * the `criteriaAligned` guard (dataSource / cutoffTime-within-tolerance /
 * rounding, with the documented null policy), the field-by-field breakdown, and
 * `linkAfterAlignment` calling the repository with the correct mismatch flag and
 * returning the canonical event + eligibility flags.
 *
 * Null-handling policy under test (conservative default, avoids false arbitrage):
 *   - both unknown            → aligned
 *   - equal (normalized)      → aligned
 *   - both known but different → mismatch
 *   - exactly one unknown     → mismatch (unless asymmetricNullAligned=true)
 *
 * Validates: Requirements 11.3, 2.3
 */

// --- fixtures --------------------------------------------------------------

function criteria(overrides: Partial<ResolutionCriteria> = {}): ResolutionCriteria {
  return {
    dataSource: null,
    cutoffTime: null,
    rounding: null,
    raw: {},
    ...overrides,
  };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m-1",
    sourceId: "src-1",
    eventId: null,
    canonicalEventId: null,
    externalId: "ext-1",
    question: "Will BTC close above $100,000 in 2025?",
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    ...overrides,
  };
}

/**
 * Fake {@link MatchingRepository} that records `linkToCanonical` calls and
 * returns a deterministic canonical event. `findCandidates` /
 * `marketsForCanonical` are unused by Layer 4 and throw if called.
 */
class FakeMatchingRepository implements MatchingRepository {
  readonly linkCalls: Array<{
    marketA: Market;
    marketB: Market;
    options: CanonicalLinkOptions;
  }> = [];

  readonly canonical: CanonicalEvent = {
    id: "canon-1",
    title: "BTC > $100k (2025)",
    category: "crypto",
    subjectEntity: "BTC",
    thresholdValue: 100000,
    targetDate: null,
  };

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.reject(new Error("findCandidates is not used by Layer 4"));
  }

  linkToCanonical(
    marketA: Market,
    marketB: Market,
    options: CanonicalLinkOptions,
  ): Promise<CanonicalEvent> {
    this.linkCalls.push({ marketA, marketB, options });
    return Promise.resolve(this.canonical);
  }

  marketsForCanonical(_canonicalEventId: string): Promise<LinkedMarket[]> {
    return Promise.reject(new Error("marketsForCanonical is not used by Layer 4"));
  }
}

// --- criteriaAligned: aligned cases ----------------------------------------

describe("criteriaAligned — aligned", () => {
  it("treats fully-equal criteria as aligned", () => {
    const a = criteria({
      dataSource: "CoinGecko close",
      cutoffTime: "2025-12-31T23:59:59.000Z",
      rounding: "nearest cent",
    });
    expect(criteriaAligned(a, { ...a, raw: {} })).toBe(true);
  });

  it("treats both-null (all fields unknown) as aligned", () => {
    expect(criteriaAligned(criteria(), criteria())).toBe(true);
  });

  it("is case- and whitespace-insensitive on dataSource and rounding", () => {
    const a = criteria({ dataSource: "CoinGecko Close", rounding: "Nearest Cent" });
    const b = criteria({
      dataSource: "  coingecko   close ",
      rounding: "nearest  cent",
    });
    expect(criteriaAligned(a, b)).toBe(true);
  });

  it("treats whitespace-only fields as unknown (aligned with null)", () => {
    const a = criteria({ dataSource: "   " });
    const b = criteria({ dataSource: null });
    expect(criteriaAligned(a, b)).toBe(true);
  });
});

// --- criteriaAligned: divergent cases --------------------------------------

describe("criteriaAligned — divergent (mismatch)", () => {
  it("flags a divergent dataSource", () => {
    const a = criteria({ dataSource: "CoinGecko close" });
    const b = criteria({ dataSource: "Binance close" });
    expect(criteriaAligned(a, b)).toBe(false);
    expect(explainCriteriaAlignment(a, b).divergentFields).toEqual(["dataSource"]);
  });

  it("flags a divergent rounding rule", () => {
    const a = criteria({ rounding: "round half up" });
    const b = criteria({ rounding: "truncate" });
    expect(criteriaAligned(a, b)).toBe(false);
    expect(explainCriteriaAlignment(a, b).divergentFields).toEqual(["rounding"]);
  });

  it("lists multiple divergent fields", () => {
    const a = criteria({ dataSource: "AP", rounding: "exact" });
    const b = criteria({ dataSource: "Reuters", rounding: "nearest" });
    const result = explainCriteriaAlignment(a, b);
    expect(result.aligned).toBe(false);
    expect(result.divergentFields).toEqual(expect.arrayContaining(["dataSource", "rounding"]));
    expect(result.divergentFields).toHaveLength(2);
  });
});

// --- criteriaAligned: cutoffTime tolerance ---------------------------------

describe("criteriaAligned — cutoffTime tolerance", () => {
  it("aligns cutoff times within the default tolerance (1h)", () => {
    const a = criteria({ cutoffTime: "2025-12-31T23:00:00.000Z" });
    // 30 minutes later — within the 1h default.
    const b = criteria({ cutoffTime: "2025-12-31T23:30:00.000Z" });
    expect(criteriaAligned(a, b)).toBe(true);
  });

  it("flags cutoff times beyond the default tolerance", () => {
    const a = criteria({ cutoffTime: "2025-12-31T00:00:00.000Z" });
    // A full day later — well beyond the 1h default.
    const b = criteria({ cutoffTime: "2026-01-01T00:00:00.000Z" });
    expect(criteriaAligned(a, b)).toBe(false);
    expect(explainCriteriaAlignment(a, b).divergentFields).toEqual(["cutoffTime"]);
  });

  it("honors a custom cutoffToleranceMs", () => {
    const a = criteria({ cutoffTime: "2025-12-31T00:00:00.000Z" });
    const b = criteria({ cutoffTime: "2026-01-01T00:00:00.000Z" });
    const oneDay = 24 * 60 * 60 * 1000;
    expect(criteriaAligned(a, b, { cutoffToleranceMs: oneDay })).toBe(true);
    expect(criteriaAligned(a, b, { cutoffToleranceMs: oneDay - 1 })).toBe(false);
  });

  it("aligns identical unparseable cutoff strings via normalized equality", () => {
    const a = criteria({ cutoffTime: "end of year" });
    const b = criteria({ cutoffTime: "End of Year" });
    expect(criteriaAligned(a, b)).toBe(true);
  });

  it("flags a parseable-vs-unparseable cutoff pair", () => {
    const a = criteria({ cutoffTime: "2025-12-31T23:59:59.000Z" });
    const b = criteria({ cutoffTime: "sometime in december" });
    expect(criteriaAligned(a, b)).toBe(false);
  });

  it("exposes DEFAULT_CUTOFF_TOLERANCE_MS as one hour", () => {
    expect(DEFAULT_CUTOFF_TOLERANCE_MS).toBe(60 * 60 * 1000);
  });
});

// --- criteriaAligned: asymmetric-null policy -------------------------------

describe("criteriaAligned — asymmetric null policy", () => {
  it("treats one-known/one-unknown dataSource as mismatch by default (conservative)", () => {
    const a = criteria({ dataSource: "CoinGecko close" });
    const b = criteria({ dataSource: null });
    expect(criteriaAligned(a, b)).toBe(false);
    expect(explainCriteriaAlignment(a, b).divergentFields).toEqual(["dataSource"]);
  });

  it("treats one-known/one-unknown cutoffTime as mismatch by default", () => {
    const a = criteria({ cutoffTime: "2025-12-31T23:59:59.000Z" });
    const b = criteria({ cutoffTime: null });
    expect(criteriaAligned(a, b)).toBe(false);
  });

  it("treats one-known/one-unknown rounding as mismatch by default", () => {
    const a = criteria({ rounding: "nearest cent" });
    const b = criteria({ rounding: null });
    expect(criteriaAligned(a, b)).toBe(false);
  });

  it("aligns asymmetric-null fields when asymmetricNullAligned=true", () => {
    const a = criteria({
      dataSource: "CoinGecko close",
      cutoffTime: "2025-12-31T23:59:59.000Z",
      rounding: "nearest cent",
    });
    const b = criteria();
    expect(criteriaAligned(a, b, { asymmetricNullAligned: true })).toBe(true);
    // ...but still flags when both sides are known and differ.
    const c = criteria({ dataSource: "Binance close" });
    expect(criteriaAligned(a, c, { asymmetricNullAligned: true })).toBe(false);
  });
});

// --- explainCriteriaAlignment ----------------------------------------------

describe("explainCriteriaAlignment", () => {
  it("reports per-field alignment and an empty divergentFields when aligned", () => {
    const a = criteria({ dataSource: "AP", cutoffTime: null, rounding: "exact" });
    const result = explainCriteriaAlignment(a, { ...a, raw: {} });
    expect(result).toEqual({
      aligned: true,
      dataSourceAligned: true,
      cutoffTimeAligned: true,
      roundingAligned: true,
      divergentFields: [],
    });
  });
});

// --- linkAfterAlignment ----------------------------------------------------

describe("linkAfterAlignment", () => {
  it("links with mismatch=false and eligibleForSignals=true when aligned", async () => {
    const repo = new FakeMatchingRepository();
    const rc = criteria({ dataSource: "CoinGecko close", rounding: "nearest cent" });
    const candidate = market({ id: "cand", resolutionCriteria: rc });
    const best = market({ id: "best", resolutionCriteria: { ...rc, raw: {} } });

    const result = await linkAfterAlignment(candidate, best, repo);

    expect(result.mismatch).toBe(false);
    expect(result.eligibleForSignals).toBe(true);
    expect(result.canonical).toBe(repo.canonical);
    expect(repo.linkCalls).toHaveLength(1);
    expect(repo.linkCalls[0]?.options).toEqual({ mismatch: false });
    expect(repo.linkCalls[0]?.marketA.id).toBe("cand");
    expect(repo.linkCalls[0]?.marketB.id).toBe("best");
  });

  it("links with mismatch=true and eligibleForSignals=false on divergence", async () => {
    const repo = new FakeMatchingRepository();
    const candidate = market({
      id: "cand",
      resolutionCriteria: criteria({ dataSource: "CoinGecko close" }),
    });
    const best = market({
      id: "best",
      resolutionCriteria: criteria({ dataSource: "Binance close" }),
    });

    const result = await linkAfterAlignment(candidate, best, repo);

    expect(result.mismatch).toBe(true);
    expect(result.eligibleForSignals).toBe(false);
    expect(result.canonical).toBe(repo.canonical);
    expect(repo.linkCalls).toHaveLength(1);
    expect(repo.linkCalls[0]?.options).toEqual({ mismatch: true });
  });

  it("passes alignment options through to the guard", async () => {
    const repo = new FakeMatchingRepository();
    const candidate = market({
      id: "cand",
      resolutionCriteria: criteria({ cutoffTime: "2025-12-31T00:00:00.000Z" }),
    });
    const best = market({
      id: "best",
      resolutionCriteria: criteria({ cutoffTime: "2026-01-01T00:00:00.000Z" }),
    });
    const oneDay = 24 * 60 * 60 * 1000;

    // Beyond the default 1h tolerance → mismatch.
    const tight = await linkAfterAlignment(candidate, best, repo);
    expect(tight.mismatch).toBe(true);

    // Within a 1-day tolerance → aligned.
    const loose = await linkAfterAlignment(candidate, best, repo, {
      cutoffToleranceMs: oneDay,
    });
    expect(loose.mismatch).toBe(false);
    expect(repo.linkCalls).toHaveLength(2);
    expect(repo.linkCalls[1]?.options).toEqual({ mismatch: false });
  });
});
