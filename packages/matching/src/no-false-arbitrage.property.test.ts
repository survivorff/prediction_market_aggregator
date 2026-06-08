import { describe, it, expect } from "vitest";
import fc from "fast-check";
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
import { computeSignals } from "./signals.js";

/**
 * Property-based test for **no false arbitrage** (design.md "Correctness
 * Properties" → Property 4 / P6 "no-false-arbitrage"; task 6.6).
 *
 * The universal rule, straight from the `computeSignals` postconditions and
 * Requirements 3.2 / 3.4:
 *
 *   For every spread signal a canonical event produces, **every** market that
 *   contributes to it is an OPEN, `resolutionMismatch = false` market with a
 *   usable Yes implied probability. A market that is tainted — flagged
 *   `resolutionMismatch = true`, or `closed`/`resolved`, or missing a usable
 *   probability — NEVER appears in the signal and can NEVER widen its gap. And
 *   below two such *aligned-usable* markets, no signal is emitted at all.
 *
 * To make source attribution decidable we give every generated market a
 * **distinct `sourceId`** (the default per-platform label), so each
 * `perPlatform` leg maps back to exactly one generated market. We can then
 * assert the contributing set is precisely the aligned-usable set, that no
 * tainted source leaks in, and that the reported gap equals max−min over only
 * the aligned-usable probabilities.
 *
 * Everything is in-memory and deterministic (a fake repo + a prob lookup), so
 * we run many randomized mixes of aligned and tainted markets, including counts
 * straddling the "≥ 2" boundary.
 *
 * **Validates: Requirements 3.2, 3.4**
 */

/** In-memory + cheap: exercise many aligned/tainted mixes. */
const NUM_RUNS = 400;

const CANONICAL_ID = "canon-under-test";

// ---------------------------------------------------------------------------
// Generated market spec
// ---------------------------------------------------------------------------

/**
 * One generated market for the canonical event. `id`/`sourceId` are assigned by
 * index in the property body so each market is distinctly attributable.
 */
interface MarketSpec {
  status: MarketStatus;
  resolutionMismatch: boolean;
  /** The Yes implied probability the resolver will return for this market. */
  prob: number | null;
}

/**
 * A Yes implied probability that is either usable (a finite `0..1` value) or one
 * of the "unusable" sentinels the null policy must drop: `null`, `NaN`, `±∞`.
 */
const arbProb: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 4, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
  { weight: 1, arbitrary: fc.constant<number | null>(null) },
  { weight: 1, arbitrary: fc.constant(Number.NaN) },
  { weight: 1, arbitrary: fc.constant(Number.POSITIVE_INFINITY) },
  { weight: 1, arbitrary: fc.constant(Number.NEGATIVE_INFINITY) },
);

const arbMarketSpec: fc.Arbitrary<MarketSpec> = fc.record({
  status: fc.constantFrom<MarketStatus>("open", "closed", "resolved"),
  resolutionMismatch: fc.boolean(),
  prob: arbProb,
});

/**
 * 0..8 markets per canonical event so scenarios straddle the "≥ 2 aligned"
 * boundary in both directions (none/one/many aligned-usable markets).
 */
const arbMarketSpecs: fc.Arbitrary<MarketSpec[]> = fc.array(arbMarketSpec, {
  minLength: 0,
  maxLength: 8,
});

// ---------------------------------------------------------------------------
// Fixtures: fake repository + resolvers
// ---------------------------------------------------------------------------

function criteria(): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {} };
}

/** Build a distinctly-attributable {@link LinkedMarket} from a spec + index. */
function toLinkedMarket(spec: MarketSpec, index: number): LinkedMarket {
  return {
    id: `m-${index}`,
    sourceId: `src-${index}`, // distinct → default source label is unique
    eventId: null,
    canonicalEventId: CANONICAL_ID,
    externalId: `ext-${index}`,
    question: "Will BTC close above $100,000 in 2025?",
    status: spec.status,
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    resolutionMismatch: spec.resolutionMismatch,
  };
}

/**
 * Fake {@link MatchingRepository} returning a fixed market set for the canonical
 * event under test. `findCandidates` / `linkToCanonical` are unused by
 * `computeSignals` and reject if called.
 */
class FakeMatchingRepository implements MatchingRepository {
  constructor(private readonly markets: LinkedMarket[]) {}

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.reject(new Error("findCandidates is not used by computeSignals"));
  }

  linkToCanonical(_a: Market, _b: Market, _options: CanonicalLinkOptions): Promise<CanonicalEvent> {
    return Promise.reject(new Error("linkToCanonical is not used by computeSignals"));
  }

  marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    if (canonicalEventId !== CANONICAL_ID) return Promise.resolve([]);
    return Promise.resolve(this.markets);
  }
}

/** A market is aligned-usable iff open, not mismatched, and has a finite prob. */
function isAlignedUsable(spec: MarketSpec): boolean {
  return (
    spec.status === "open" &&
    spec.resolutionMismatch === false &&
    spec.prob !== null &&
    Number.isFinite(spec.prob)
  );
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 4 (P6): no false arbitrage — signals never include tainted markets (Req 3.2, 3.4)", () => {
  it("every contributing market is open + resolutionMismatch=false + usable, and signals are absent below two", async () => {
    await fc.assert(
      fc.asyncProperty(arbMarketSpecs, async (specs) => {
        const markets = specs.map(toLinkedMarket);
        const repo = new FakeMatchingRepository(markets);

        // Resolver keyed by the per-market id (returns null/NaN/±∞ verbatim so
        // the implementation's null policy is exercised, not bypassed).
        const probById = new Map<string, number | null>(
          markets.map((m, i) => [m.id, specs[i]!.prob]),
        );
        const getYesImpliedProb = (m: LinkedMarket): Promise<number | null> =>
          Promise.resolve(probById.get(m.id) ?? null);

        const signals = await computeSignals(CANONICAL_ID, { repo, getYesImpliedProb });

        // The ground-truth aligned-usable set (by distinct sourceId) and probs.
        const alignedUsable = markets.filter((_m, i) => isAlignedUsable(specs[i]!));
        const alignedSources = alignedUsable.map((m) => m.sourceId).sort();
        const taintedSources = new Set(
          markets.filter((_m, i) => !isAlignedUsable(specs[i]!)).map((m) => m.sourceId),
        );
        const probBySource = new Map(markets.map((m, i) => [m.sourceId, specs[i]!.prob]));

        // --- Requirement 3.4: absence below two aligned-usable markets -------
        if (alignedUsable.length < 2) {
          expect(signals).toEqual([]);
          return;
        }

        // At least two aligned-usable markets → exactly one signal.
        expect(signals).toHaveLength(1);
        const signal = signals[0]!;

        // 3.4: one leg per aligned-usable market (no more, no fewer).
        expect(signal.perPlatform).toHaveLength(alignedUsable.length);

        const legSources = signal.perPlatform.map((leg) => leg.source).sort();

        // --- Requirement 3.2: NO false arbitrage -----------------------------
        // Contributing sources are exactly the aligned-usable set: a subset of
        // aligned markets (so none missing) AND no tainted source leaks in.
        expect(legSources).toEqual(alignedSources);
        for (const leg of signal.perPlatform) {
          expect(taintedSources.has(leg.source)).toBe(false);
          // Source attribution: each leg's probability is its market's real,
          // finite Yes probability — a tainted market can't masquerade.
          expect(leg.impliedProb).toBe(probBySource.get(leg.source));
          expect(Number.isFinite(leg.impliedProb)).toBe(true);
        }

        // The gap is max−min over ONLY the aligned-usable probabilities, so a
        // tainted market (e.g. an extreme mismatched prob) can never widen it.
        const usableProbs = alignedUsable.map((m) => probBySource.get(m.sourceId) as number);
        const expectedGap = Math.max(...usableProbs) - Math.min(...usableProbs);
        expect(signal.gap).toBeCloseTo(expectedGap, 12);
        expect(signal.gap).toBeGreaterThanOrEqual(0);

        // Display-only invariant holds here too (primary coverage in 6.7).
        expect(signal.executable).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
