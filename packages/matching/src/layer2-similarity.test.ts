import { describe, it, expect } from "vitest";
import type { Market, ResolutionCriteria } from "@pma/core";
import {
  SIM_THRESHOLD,
  AUTO_CONFIRM_THRESHOLD,
  cosineSimilarity,
  embedTexts,
  scoreCandidates,
  selectBest,
  meetsAutoConfirm,
  type EmbeddingProvider,
  type ScoredMarket,
} from "./layer2-similarity.js";
import { BagOfWordsEmbeddingProvider } from "./test-support.js";

/**
 * Unit tests for Layer-2 semantic similarity (task 6.2): cosine-similarity
 * correctness and edge cases, threshold-gated + sorted candidate scoring, the
 * empty-pool short-circuit, threshold-boundary behavior, and the "embed the
 * candidate once" guarantee. A deterministic {@link BagOfWordsEmbeddingProvider}
 * stands in for a real model so scoring is fully reproducible.
 *
 * Requirements: 11.1 (rules/metadata pre-filter followed by semantic similarity
 * on question text).
 */

// --- fixtures --------------------------------------------------------------

function criteria(): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {} };
}

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m-1",
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

/**
 * A fixed-vector provider keyed by exact question text — lets tests pin the
 * cosine outcomes precisely (independent of any tokenization scheme). Counts
 * `embed` calls so we can assert the candidate is embedded once.
 */
class FixedVectorProvider implements EmbeddingProvider {
  embedCalls = 0;
  constructor(private readonly table: Record<string, number[]>) {}
  embed(text: string): Promise<number[]> {
    this.embedCalls += 1;
    const vec = this.table[text];
    if (vec === undefined) throw new Error(`no fixed vector for: ${text}`);
    return Promise.resolve(vec);
  }
}

// --- cosineSimilarity ------------------------------------------------------

describe("cosineSimilarity", () => {
  it("returns 1 for identical (parallel) vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    // Scaling does not change direction → still 1.
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [0, 3, 4])).toBe(0);
  });

  it("returns -1 for opposite (antiparallel) vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 12);
  });

  it("returns 0 when either operand is a zero vector", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("throws on mismatched vector lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });

  it("stays within [-1, 1] despite floating-point error", () => {
    const a = [0.1, 0.2, 0.3];
    const sim = cosineSimilarity(a, a);
    expect(sim).toBeLessThanOrEqual(1);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeCloseTo(1, 12);
  });

  it("is symmetric in its arguments", () => {
    const a = [0.5, 1.5, -2];
    const b = [3, -1, 0.25];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 12);
  });
});

// --- embedTexts ------------------------------------------------------------

describe("embedTexts", () => {
  it("returns [] for an empty input without calling the provider", async () => {
    const provider = new BagOfWordsEmbeddingProvider();
    const out = await embedTexts(provider, []);
    expect(out).toEqual([]);
    expect(provider.embedCalls).toBe(0);
    expect(provider.embedAllCalls).toBe(0);
  });

  it("uses the batch path when the provider implements embedAll", async () => {
    const provider = new BagOfWordsEmbeddingProvider();
    const out = await embedTexts(provider, ["a b", "c d"]);
    expect(out).toHaveLength(2);
    expect(provider.embedAllCalls).toBe(1);
    expect(provider.embedCalls).toBe(0);
  });

  it("falls back to embed when no batch path exists, preserving order", async () => {
    const provider: EmbeddingProvider = {
      embed: (t) => Promise.resolve([t.length]),
    };
    const out = await embedTexts(provider, ["a", "abc", "ab"]);
    expect(out).toEqual([[1], [3], [2]]);
  });
});

// --- scoreCandidates -------------------------------------------------------

describe("scoreCandidates", () => {
  it("returns an empty result for an empty pool without embedding anything", async () => {
    const provider = new BagOfWordsEmbeddingProvider();
    const result = await scoreCandidates("Will BTC hit $100k?", [], provider);
    expect(result).toEqual([]);
    expect(provider.embedCalls).toBe(0);
    expect(provider.embedAllCalls).toBe(0);
  });

  it("filters out pool markets below the similarity threshold", async () => {
    // Candidate shares all words with A, none with B.
    const provider = new BagOfWordsEmbeddingProvider();
    const pool = [
      market({ id: "a", question: "Will Bitcoin reach one hundred thousand" }),
      market({ id: "b", question: "Who wins the marathon race today" }),
    ];
    const result = await scoreCandidates(
      "Will Bitcoin reach one hundred thousand",
      pool,
      provider,
      { simThreshold: 0.5 },
    );
    expect(result.map((s) => s.market.id)).toEqual(["a"]);
    expect(result[0]?.similarity).toBeCloseTo(1, 12);
  });

  it("sorts kept matches by similarity descending (best first = argmax)", async () => {
    // Fixed vectors: candidate = [1,0,0]; high ~1, mid ~0.6, low excluded.
    const provider = new FixedVectorProvider({
      cand: [1, 0, 0],
      high: [1, 0, 0],
      mid: [0.6, 0.8, 0],
      low: [0, 1, 0],
    });
    const pool = [
      market({ id: "mid", question: "mid" }),
      market({ id: "low", question: "low" }),
      market({ id: "high", question: "high" }),
    ];
    const result = await scoreCandidates("cand", pool, provider, {
      simThreshold: 0.5,
    });
    expect(result.map((s) => s.market.id)).toEqual(["high", "mid"]);
    expect(result[0]?.similarity).toBeGreaterThanOrEqual(result[1]?.similarity ?? 0);
    expect(result[0]?.similarity).toBeCloseTo(1, 12);
    expect(result[1]?.similarity).toBeCloseTo(0.6, 12);
  });

  it("keeps a match exactly at the threshold (inclusive >=)", async () => {
    // Candidate=[1,0]; on=[1,0] (sim 1.0); at=[0.8,0.6] (sim exactly 0.8).
    const provider = new FixedVectorProvider({
      cand: [1, 0],
      on: [1, 0],
      at: [0.8, 0.6],
      below: [0.6, 0.8], // sim 0.6 < 0.8 → excluded
    });
    const pool = [
      market({ id: "on", question: "on" }),
      market({ id: "at", question: "at" }),
      market({ id: "below", question: "below" }),
    ];
    const result = await scoreCandidates("cand", pool, provider, {
      simThreshold: 0.8,
    });
    expect(result.map((s) => s.market.id)).toEqual(["on", "at"]);
    expect(result[1]?.similarity).toBeCloseTo(0.8, 12);
  });

  it("excludes a match just below the threshold boundary", async () => {
    const provider = new FixedVectorProvider({
      cand: [1, 0],
      just: [0.8, 0.6], // sim exactly 0.8
    });
    const pool = [market({ id: "just", question: "just" })];
    // Threshold a hair above 0.8 → excluded.
    const result = await scoreCandidates("cand", pool, provider, {
      simThreshold: 0.8000001,
    });
    expect(result).toEqual([]);
  });

  it("embeds the candidate question exactly once and reuses it", async () => {
    const provider = new BagOfWordsEmbeddingProvider();
    const pool = [
      market({ id: "a", question: "alpha beta gamma" }),
      market({ id: "b", question: "delta epsilon zeta" }),
      market({ id: "c", question: "alpha beta delta" }),
    ];
    await scoreCandidates("alpha beta gamma", pool, provider, {
      simThreshold: 0,
    });
    // Candidate embedded once via embed(); pool embedded via one embedAll batch.
    expect(provider.embedCalls).toBe(1);
    expect(provider.embedAllCalls).toBe(1);
  });

  it("embeds the candidate once even without a batch path on the provider", async () => {
    let embedCount = 0;
    const provider: EmbeddingProvider = {
      embed: (t) => {
        embedCount += 1;
        return Promise.resolve([t.length, tokenCount(t)]);
      },
    };
    const pool = [
      market({ id: "a", question: "one two" }),
      market({ id: "b", question: "three four five" }),
    ];
    await scoreCandidates("one two", pool, provider, { simThreshold: -1 });
    // 1 candidate + 2 pool questions = 3 single embed calls, candidate not re-embedded per pool item.
    expect(embedCount).toBe(3);
  });

  it("defaults the threshold to SIM_THRESHOLD when unspecified", async () => {
    // Candidate identical to A (sim 1 ≥ SIM_THRESHOLD); orthogonal to B.
    const provider = new BagOfWordsEmbeddingProvider();
    const pool = [
      market({ id: "a", question: "shared identical question text here" }),
      market({ id: "b", question: "completely different words entirely" }),
    ];
    const result = await scoreCandidates("shared identical question text here", pool, provider);
    expect(result.map((s) => s.market.id)).toEqual(["a"]);
  });
});

// --- selectBest / meetsAutoConfirm ----------------------------------------

describe("selectBest", () => {
  it("returns the first (argmax) element of a sorted scored list", () => {
    const scored: ScoredMarket[] = [
      { market: market({ id: "hi" }), similarity: 0.95 },
      { market: market({ id: "lo" }), similarity: 0.8 },
    ];
    expect(selectBest(scored)?.market.id).toBe("hi");
  });

  it("returns null for an empty list", () => {
    expect(selectBest([])).toBeNull();
  });
});

describe("meetsAutoConfirm", () => {
  it("is true at or above the auto-confirm threshold", () => {
    expect(meetsAutoConfirm({ market: market(), similarity: AUTO_CONFIRM_THRESHOLD })).toBe(true);
    expect(meetsAutoConfirm({ market: market(), similarity: 0.95 })).toBe(true);
  });

  it("is false below the auto-confirm threshold and for null", () => {
    expect(meetsAutoConfirm({ market: market(), similarity: 0.89 })).toBe(false);
    expect(meetsAutoConfirm(null)).toBe(false);
  });

  it("honors a custom auto-confirm threshold", () => {
    expect(meetsAutoConfirm({ market: market(), similarity: 0.7 }, 0.6)).toBe(true);
  });
});

// --- exported calibration constants ---------------------------------------

describe("calibration constants", () => {
  it("expose sane SIM_THRESHOLD < AUTO_CONFIRM_THRESHOLD in [0,1]", () => {
    expect(SIM_THRESHOLD).toBeGreaterThan(0);
    expect(SIM_THRESHOLD).toBeLessThanOrEqual(1);
    expect(AUTO_CONFIRM_THRESHOLD).toBeLessThanOrEqual(1);
    // Auto-confirm is stricter than the keep-threshold (design: a kept pair may
    // still be below auto-confirm and go to calibration).
    expect(AUTO_CONFIRM_THRESHOLD).toBeGreaterThanOrEqual(SIM_THRESHOLD);
  });
});

/** Count whitespace-delimited tokens (local test helper). */
function tokenCount(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}
