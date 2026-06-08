import { describe, it, expect } from "vitest";
import type {
  CandidateQuery,
  CanonicalEvent,
  CanonicalLinkOptions,
  LinkedMarket,
  Market,
  MatchingRepository,
  ResolutionCriteria,
} from "@pma/core";
import {
  DEFAULT_WINDOW_DAYS,
  OPEN_WINDOW_FROM,
  OPEN_WINDOW_TO,
  extractSubjectEntity,
  extractThreshold,
  resolveTimeAnchor,
  buildTimeWindow,
  buildCandidateQuery,
  findCandidatePool,
  type MatchCandidate,
} from "./layer1-prefilter.js";

/**
 * Unit tests for the Layer-1 rules/metadata pre-filter (task 6.1): subject and
 * threshold extraction, the `around(endDate)` time window, query assembly, and
 * the `findCandidatePool` repository seam. Pure logic — the only collaborator
 * is an in-memory fake {@link MatchingRepository} (no DB).
 *
 * Requirements: 11.1 (rules/metadata pre-filter — category, time window,
 * subject entity, threshold).
 */

// --- test fixtures ---------------------------------------------------------

function criteria(cutoffTime: string | null = null): ResolutionCriteria {
  return { dataSource: null, cutoffTime, rounding: null, raw: {} };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m-self",
    sourceId: "src-1",
    eventId: null,
    canonicalEventId: null,
    externalId: "ext-1",
    question: "Will it happen?",
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    ...overrides,
  };
}

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    market: market(),
    category: "crypto",
    endDate: "2025-01-15T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Minimal in-memory {@link MatchingRepository}. `findCandidates` records the
 * last query it received and returns a preset pool, so tests can assert on the
 * exact query Layer 1 built and that the pool is returned unchanged.
 */
class FakeMatchingRepository implements MatchingRepository {
  lastQuery: CandidateQuery | null = null;
  calls = 0;

  constructor(private readonly pool: Market[] = []) {}

  findCandidates(query: CandidateQuery): Promise<Market[]> {
    this.lastQuery = query;
    this.calls += 1;
    return Promise.resolve(this.pool);
  }

  linkToCanonical(_a: Market, _b: Market, _options: CanonicalLinkOptions): Promise<CanonicalEvent> {
    throw new Error("not used in Layer 1 tests");
  }

  marketsForCanonical(_id: string): Promise<LinkedMarket[]> {
    throw new Error("not used in Layer 1 tests");
  }
}

// --- extractSubjectEntity --------------------------------------------------

describe("extractSubjectEntity", () => {
  it("normalizes crypto names and tickers to a canonical ticker", () => {
    expect(extractSubjectEntity("Will Bitcoin reach $100,000?")).toBe("BTC");
    expect(extractSubjectEntity("will btc hit 100k this year")).toBe("BTC");
    expect(extractSubjectEntity("Ethereum above 5000?")).toBe("ETH");
    expect(extractSubjectEntity("ETH/USD by December")).toBe("ETH");
    expect(extractSubjectEntity("Will Solana flip something?")).toBe("SOL");
  });

  it("picks the earliest crypto mention when several appear", () => {
    expect(extractSubjectEntity("Will ETH flip BTC by 2030?")).toBe("ETH");
    expect(extractSubjectEntity("Will Bitcoin outpace Ethereum?")).toBe("BTC");
  });

  it("does not match a ticker alias inside a larger word", () => {
    // "eth" appears inside "ethics" / "ethanol" but must not match as a word.
    expect(extractSubjectEntity("Will ethics reform pass?")).not.toBe("ETH");
  });

  it("extracts a proper-noun run for candidate/person names", () => {
    expect(extractSubjectEntity("Will Donald Trump win the election?")).toBe("Donald Trump");
    expect(extractSubjectEntity("Will Joe Biden run again?")).toBe("Joe Biden");
  });

  it("skips leading question/function stopwords before the name", () => {
    // "Will" is a stopword; the run starts at the real subject.
    expect(extractSubjectEntity("Will Kamala Harris concede?")).toBe("Kamala Harris");
  });

  it("stops a proper-noun run at a punctuation boundary", () => {
    expect(extractSubjectEntity("Will Donald Trump, the former president, win?")).toBe(
      "Donald Trump",
    );
  });

  it("returns null when no confident subject is found", () => {
    expect(extractSubjectEntity("will it rain tomorrow?")).toBeNull();
    expect(extractSubjectEntity("")).toBeNull();
    expect(extractSubjectEntity("   ")).toBeNull();
  });

  it("prefers a crypto subject over a later proper noun", () => {
    // Crypto alias runs first even though a proper noun also exists.
    expect(extractSubjectEntity("Will Bitcoin beat the Nasdaq?")).toBe("BTC");
  });
});

// --- extractThreshold ------------------------------------------------------

describe("extractThreshold", () => {
  it("extracts plain numbers", () => {
    expect(extractThreshold("Will turnout exceed 5000 voters?")).toBe(5000);
    expect(extractThreshold("Score above 42?")).toBe(42);
  });

  it("handles a dollar sign and comma grouping", () => {
    expect(extractThreshold("Will Bitcoin reach $100,000?")).toBe(100000);
    expect(extractThreshold("Price over $1,250.50?")).toBe(1250.5);
  });

  it("applies k / m / bn / trillion magnitude suffixes", () => {
    expect(extractThreshold("Will BTC hit 100k?")).toBe(100000);
    expect(extractThreshold("Market cap above $1.5m?")).toBe(1_500_000);
    expect(extractThreshold("Revenue over $2bn?")).toBe(2_000_000_000);
    expect(extractThreshold("Will it cross 50 million?")).toBe(50_000_000);
    expect(extractThreshold("Debt above 3 trillion?")).toBe(3_000_000_000_000);
  });

  it("returns the percent value itself for percentages", () => {
    expect(extractThreshold("Will inflation exceed 5%?")).toBe(5);
    expect(extractThreshold("Approval above 47.5%?")).toBe(47.5);
  });

  it("prefers the leftmost strong ($/suffix/%) match over a bare number", () => {
    // The bare "3" must not win over the "$100,000" threshold.
    expect(extractThreshold("Will Bitcoin reach $100,000 within 3 months?")).toBe(100000);
  });

  it("treats a bare 4-digit year as not-a-threshold", () => {
    expect(extractThreshold("Will Trump win the 2024 election?")).toBeNull();
    // A year plus a real threshold still extracts the threshold.
    expect(extractThreshold("By 2024, will BTC top $100k?")).toBe(100000);
  });

  it("does not read a following word's letter as a suffix", () => {
    // "100 marbles" — the 'm' belongs to a word, not a magnitude suffix.
    expect(extractThreshold("Will there be 100 marbles?")).toBe(100);
  });

  it("returns null when there is no number", () => {
    expect(extractThreshold("Will Donald Trump win?")).toBeNull();
    expect(extractThreshold("")).toBeNull();
  });
});

// --- resolveTimeAnchor / buildTimeWindow -----------------------------------

describe("resolveTimeAnchor", () => {
  it("prefers the resolution cutoffTime over the endDate", () => {
    const c = candidate({
      market: market({
        resolutionCriteria: criteria("2025-03-01T00:00:00.000Z"),
      }),
      endDate: "2025-06-01T00:00:00.000Z",
    });
    expect(resolveTimeAnchor(c)).toBe("2025-03-01T00:00:00.000Z");
  });

  it("falls back to endDate when cutoffTime is absent", () => {
    const c = candidate({ endDate: "2025-06-01T00:00:00.000Z" });
    expect(resolveTimeAnchor(c)).toBe("2025-06-01T00:00:00.000Z");
  });

  it("returns null when neither is present or parseable", () => {
    expect(resolveTimeAnchor(candidate({ endDate: null }))).toBeNull();
    expect(resolveTimeAnchor(candidate({ endDate: "not-a-date" }))).toBeNull();
  });
});

describe("buildTimeWindow", () => {
  it("builds a symmetric +/- window around the anchor (default width)", () => {
    const c = candidate({ endDate: "2025-01-15T00:00:00.000Z" });
    const w = buildTimeWindow(c);
    expect(w.from).toBe("2025-01-08T00:00:00.000Z");
    expect(w.to).toBe("2025-01-22T00:00:00.000Z");
    // Sanity: the window spans 2 * DEFAULT_WINDOW_DAYS.
    const spanDays = (Date.parse(w.to) - Date.parse(w.from)) / (24 * 60 * 60 * 1000);
    expect(spanDays).toBe(2 * DEFAULT_WINDOW_DAYS);
  });

  it("honors a custom window width in days", () => {
    const c = candidate({ endDate: "2025-01-15T00:00:00.000Z" });
    const w = buildTimeWindow(c, 1);
    expect(w.from).toBe("2025-01-14T00:00:00.000Z");
    expect(w.to).toBe("2025-01-16T00:00:00.000Z");
  });

  it("anchors on the cutoffTime when present", () => {
    const c = candidate({
      market: market({
        resolutionCriteria: criteria("2025-01-15T12:00:00.000Z"),
      }),
      endDate: "2099-01-01T00:00:00.000Z",
    });
    const w = buildTimeWindow(c, 1);
    expect(w.from).toBe("2025-01-14T12:00:00.000Z");
    expect(w.to).toBe("2025-01-16T12:00:00.000Z");
  });

  it("returns the wide-open window when there is no usable anchor", () => {
    const c = candidate({ endDate: null });
    const w = buildTimeWindow(c);
    expect(w.from).toBe(OPEN_WINDOW_FROM);
    expect(w.to).toBe(OPEN_WINDOW_TO);
  });
});

// --- buildCandidateQuery ---------------------------------------------------

describe("buildCandidateQuery", () => {
  it("assembles category, time window, subject, threshold, and exclude id", () => {
    const c = candidate({
      market: market({
        id: "m-123",
        question: "Will Bitcoin reach $100,000?",
        resolutionCriteria: criteria("2025-01-15T00:00:00.000Z"),
      }),
      category: "crypto",
      endDate: "2025-01-15T00:00:00.000Z",
    });

    const query = buildCandidateQuery(c);

    expect(query.category).toBe("crypto");
    expect(query.subjectEntity).toBe("BTC");
    expect(query.threshold).toBe(100000);
    expect(query.excludeMarketId).toBe("m-123");
    expect(query.timeWindow.from).toBe("2025-01-08T00:00:00.000Z");
    expect(query.timeWindow.to).toBe("2025-01-22T00:00:00.000Z");
  });

  it("yields null subject/threshold when none can be extracted", () => {
    const c = candidate({
      market: market({ question: "Will it rain tomorrow?" }),
      category: "other",
    });
    const query = buildCandidateQuery(c);
    expect(query.subjectEntity).toBeNull();
    expect(query.threshold).toBeNull();
    expect(query.category).toBe("other");
  });

  it("passes a custom window width through to the time window", () => {
    const c = candidate({ endDate: "2025-01-15T00:00:00.000Z" });
    const query = buildCandidateQuery(c, { windowDays: 30 });
    expect(query.timeWindow.from).toBe("2024-12-16T00:00:00.000Z");
    expect(query.timeWindow.to).toBe("2025-02-14T00:00:00.000Z");
  });
});

// --- findCandidatePool -----------------------------------------------------

describe("findCandidatePool", () => {
  it("builds the correct query and returns the repository's pool", async () => {
    const pool: Market[] = [
      market({ id: "cand-a", externalId: "a", question: "Bitcoin to $100k?" }),
      market({ id: "cand-b", externalId: "b", question: "BTC hits 100000?" }),
    ];
    const repo = new FakeMatchingRepository(pool);

    const c = candidate({
      market: market({
        id: "m-self",
        question: "Will Bitcoin reach $100,000?",
        resolutionCriteria: criteria("2025-01-15T00:00:00.000Z"),
      }),
      category: "crypto",
      endDate: "2025-01-15T00:00:00.000Z",
    });

    const result = await findCandidatePool(c, repo);

    expect(result).toEqual(pool);
    expect(repo.calls).toBe(1);
    expect(repo.lastQuery).toEqual({
      category: "crypto",
      timeWindow: {
        from: "2025-01-08T00:00:00.000Z",
        to: "2025-01-22T00:00:00.000Z",
      },
      subjectEntity: "BTC",
      threshold: 100000,
      excludeMarketId: "m-self",
    });
  });

  it("returns an empty pool unchanged", async () => {
    const repo = new FakeMatchingRepository([]);
    const result = await findCandidatePool(candidate(), repo);
    expect(result).toEqual([]);
    expect(repo.calls).toBe(1);
  });

  it("forwards custom options to the query it builds", async () => {
    const repo = new FakeMatchingRepository([]);
    const c = candidate({ endDate: "2025-01-15T00:00:00.000Z" });
    await findCandidatePool(c, repo, { windowDays: 2 });
    expect(repo.lastQuery?.timeWindow).toEqual({
      from: "2025-01-13T00:00:00.000Z",
      to: "2025-01-17T00:00:00.000Z",
    });
  });
});
