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
import { matchMarket } from "./match-market.js";
import { BagOfWordsEmbeddingProvider } from "./test-support.js";
import { InMemoryCalibrationQueue, InMemoryMatchLabelStore } from "./layer3-calibration.js";
import type { MatchCandidate } from "./layer1-prefilter.js";

/**
 * Unit tests for the `matchMarket` orchestrator with in-memory fakes (a fake
 * MatchingRepository, the deterministic bag-of-words embedding provider, and
 * the reference calibration queue / label store). They verify the four-layer
 * flow: no pool → NoMatch; aligned auto-confirm → Matched (eligible for
 * signals); divergent criteria → Matched but flagged mismatch (excluded);
 * high-value → routed to the calibration queue.
 */

function criteria(overrides: Partial<ResolutionCriteria> = {}): ResolutionCriteria {
  return { dataSource: "Coinbase BTC-USD close", cutoffTime: null, rounding: null, raw: {}, ...overrides };
}

let nextId = 1;
function makeMarket(question: string, overrides: Partial<Market> = {}): Market {
  return {
    id: `m-${nextId++}`,
    sourceId: "src-1",
    eventId: null,
    canonicalEventId: null,
    externalId: `ext-${nextId}`,
    question,
    status: "open",
    volume24h: 1000,
    liquidity: 500,
    spread: 0.02,
    resolutionCriteria: criteria(),
    ...overrides,
  };
}

function candidateOf(market: Market): MatchCandidate {
  return { market, category: "crypto", endDate: null };
}

/** A market on a DIFFERENT source than the candidate (cross-platform match). */
function otherSourceMarket(question: string, overrides: Partial<Market> = {}): Market {
  return makeMarket(question, { sourceId: "src-2", ...overrides });
}

/** A fake MatchingRepository: a fixed candidate pool + recorded links. */
class FakeMatchingRepo implements MatchingRepository {
  links: Array<{ a: string; b: string; mismatch: boolean; canonicalId: string }> = [];
  private canonicalSeq = 1;

  constructor(private readonly pool: Market[]) {}

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.resolve(this.pool);
  }

  linkToCanonical(a: Market, b: Market, options: CanonicalLinkOptions): Promise<CanonicalEvent> {
    const canonicalId = a.canonicalEventId ?? b.canonicalEventId ?? `canon-${this.canonicalSeq++}`;
    this.links.push({ a: a.id, b: b.id, mismatch: options.mismatch, canonicalId });
    return Promise.resolve({
      id: canonicalId,
      title: a.question,
      category: "crypto",
      subjectEntity: null,
      thresholdValue: null,
      targetDate: null,
    });
  }

  marketsForCanonical(_id: string): Promise<LinkedMarket[]> {
    return Promise.resolve([]);
  }
}

function deps(pool: Market[]) {
  return {
    repo: new FakeMatchingRepo(pool),
    embeddings: new BagOfWordsEmbeddingProvider(),
    queue: new InMemoryCalibrationQueue(),
    labels: new InMemoryMatchLabelStore(),
  };
}

const Q = "Will BTC close above 100000 USD by end of 2025";

describe("matchMarket", () => {
  it("returns NoMatch when the candidate pool is empty", async () => {
    const d = deps([]);
    const result = await matchMarket(candidateOf(makeMarket(Q)), d);
    expect(result.kind).toBe("NoMatch");
  });

  it("auto-confirms and links an aligned same-question pair (eligible for signals)", async () => {
    const existing = otherSourceMarket(Q); // identical question + same criteria → aligned
    const d = deps([existing]);

    const result = await matchMarket(candidateOf(makeMarket(Q)), d);

    expect(result.kind).toBe("Matched");
    if (result.kind === "Matched") {
      expect(result.mismatch).toBe(false);
      expect(result.eligibleForSignals).toBe(true);
    }
    expect(d.repo.links).toHaveLength(1);
    expect(d.repo.links[0]?.mismatch).toBe(false);
  });

  it("links but flags a mismatch when resolution criteria materially diverge", async () => {
    // Same question (auto-confirm) but a different data source → not aligned.
    const existing = otherSourceMarket(Q, {
      resolutionCriteria: criteria({ dataSource: "Binance BTC-USDT close" }),
    });
    const d = deps([existing]);

    const result = await matchMarket(candidateOf(makeMarket(Q)), d);

    expect(result.kind).toBe("Matched");
    if (result.kind === "Matched") {
      expect(result.mismatch).toBe(true);
      expect(result.eligibleForSignals).toBe(false);
    }
    expect(d.repo.links[0]?.mismatch).toBe(true);
  });

  it("routes a high-value pair to the calibration queue instead of auto-linking", async () => {
    const existing = otherSourceMarket(Q);
    const d = deps([existing]);

    const result = await matchMarket(candidateOf(makeMarket(Q)), d, {
      calibration: { isHighValue: () => true },
    });

    expect(result.kind).toBe("PendingCalibration");
    // Nothing was linked; the pair is awaiting human review.
    expect(d.repo.links).toHaveLength(0);
    expect(await d.queue.size()).toBe(1);
  });

  it("returns NoMatch when no candidate clears the similarity threshold", async () => {
    const unrelated = otherSourceMarket("Who wins the 2028 presidential election in France");
    const d = deps([unrelated]);

    const result = await matchMarket(candidateOf(makeMarket(Q)), d);
    expect(result.kind).toBe("NoMatch");
    expect(d.repo.links).toHaveLength(0);
  });

  it("excludes same-source candidates (cross-platform aggregator links across venues)", async () => {
    // An identical question on the SAME source as the candidate must NOT match.
    const sameSource = makeMarket(Q, { sourceId: "src-1" });
    const d = deps([sameSource]);
    const result = await matchMarket(candidateOf(makeMarket(Q, { sourceId: "src-1" })), d);
    expect(result.kind).toBe("NoMatch");
    expect(d.repo.links).toHaveLength(0);

    // The same pair across sources DOES match (crossSourceOnly default).
    const d2 = deps([makeMarket(Q, { sourceId: "src-2" })]);
    const crossResult = await matchMarket(candidateOf(makeMarket(Q, { sourceId: "src-1" })), d2);
    expect(crossResult.kind).toBe("Matched");
  });
});
