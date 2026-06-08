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
import {
  computeSignals,
  computeSignalsForMany,
  rankSignals,
  type SpreadSignal,
} from "./signals.js";

/**
 * Property-based test for the **display-only invariant** (design.md
 * "Correctness Properties" → Property 5 "Display-only invariant"; task 6.7).
 *
 * The universal rule, straight from the `computeSignals` postcondition ("each
 * signal carries ... an explicit `executable: false` flag (v1 is
 * display-only)"), the `SpreadSignal` contract (`executable: false`), and the
 * read-only / Compliance section:
 *
 *   For **every** signal returned by `computeSignals`, `computeSignalsForMany`,
 *   or `rankSignals`, `executable === false`. There is NEVER a returned signal
 *   with `executable !== false`. v1 exposes no execution / order-placement
 *   path, so the flag — pinned here across the whole input space — is the
 *   contract the API and UI rely on.
 *
 * This pins the v1 read-only guarantee against a WIDE variety of generated
 * inputs: canonical events with random numbers of markets, random statuses,
 * random `resolutionMismatch` flags, and random Yes implied probabilities over
 * the full `[0, 1]` range including the extremes `0`/`1` and `null`, exercised
 * through the single-event (`computeSignals`), many-event
 * (`computeSignalsForMany`), and ranking (`rankSignals`) entry points.
 *
 * Empty results trivially satisfy the invariant (nothing to violate it);
 * non-empty results must have every signal `executable === false`. We also
 * assert `gap >= 0` as a sanity invariant of a display-only signal.
 *
 * Everything is in-memory and deterministic (a fake repo + a prob lookup), so
 * we run many randomized scenarios cheaply.
 *
 * **Validates: Requirements 3.3, 12.1**
 */

/** In-memory + cheap: pin the read-only guarantee across many scenarios. */
const NUM_RUNS = 300;

// ---------------------------------------------------------------------------
// Generated market spec
// ---------------------------------------------------------------------------

/**
 * One generated market for a canonical event. `id`/`sourceId` are assigned by
 * (event, index) in the property body so each market is distinctly keyed.
 */
interface MarketSpec {
  status: MarketStatus;
  resolutionMismatch: boolean;
  /** The Yes implied probability the resolver will return for this market. */
  prob: number | null;
}

/**
 * A Yes implied probability spanning the FULL `[0, 1]` range — including the
 * extremes `0` and `1` — plus `null` (unavailable). Extremes are weighted in
 * so 0/1 boundaries (which produce the widest possible gap of 1) are well
 * represented.
 */
const arbProb: fc.Arbitrary<number | null> = fc.oneof(
  { weight: 5, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },
  { weight: 1, arbitrary: fc.constant(0) },
  { weight: 1, arbitrary: fc.constant(1) },
  { weight: 1, arbitrary: fc.constant<number | null>(null) },
);

const arbMarketSpec: fc.Arbitrary<MarketSpec> = fc.record({
  status: fc.constantFrom<MarketStatus>("open", "closed", "resolved"),
  resolutionMismatch: fc.boolean(),
  prob: arbProb,
});

/**
 * 0..6 markets per canonical event so scenarios straddle the "≥ 2 aligned"
 * boundary in both directions (events that emit a signal and events that don't,
 * i.e. the trivially-satisfying empty case).
 */
const arbMarketSpecs: fc.Arbitrary<MarketSpec[]> = fc.array(arbMarketSpec, {
  minLength: 0,
  maxLength: 6,
});

/** 1..4 canonical events, each with its own market list, for the "many" path. */
const arbEvents: fc.Arbitrary<MarketSpec[][]> = fc.array(arbMarketSpecs, {
  minLength: 1,
  maxLength: 4,
});

// ---------------------------------------------------------------------------
// Fixtures: fake repository + resolvers
// ---------------------------------------------------------------------------

function criteria(): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {} };
}

/** Build a distinctly-keyed {@link LinkedMarket} from a spec + (event, index). */
function toLinkedMarket(
  spec: MarketSpec,
  canonicalEventId: string,
  eventIdx: number,
  marketIdx: number,
): LinkedMarket {
  return {
    id: `m-${eventIdx}-${marketIdx}`,
    sourceId: `src-${eventIdx}-${marketIdx}`, // distinct per market
    eventId: null,
    canonicalEventId,
    externalId: `ext-${eventIdx}-${marketIdx}`,
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
 * Fake {@link MatchingRepository} returning fixed market sets per canonical
 * event id. `findCandidates` / `linkToCanonical` are unused by signal
 * computation and reject if called.
 */
class FakeMatchingRepository implements MatchingRepository {
  constructor(private readonly byCanonical: Map<string, LinkedMarket[]>) {}

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.reject(new Error("findCandidates is not used by computeSignals"));
  }

  linkToCanonical(_a: Market, _b: Market, _options: CanonicalLinkOptions): Promise<CanonicalEvent> {
    return Promise.reject(new Error("linkToCanonical is not used by computeSignals"));
  }

  marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    return Promise.resolve(this.byCanonical.get(canonicalEventId) ?? []);
  }
}

/** Assert the display-only invariant over a batch of returned signals. */
function assertDisplayOnly(signals: readonly SpreadSignal[]): void {
  // Empty results trivially satisfy the invariant; non-empty must all hold it.
  for (const signal of signals) {
    // Requirements 3.3 / 12.1: every returned signal is non-executable.
    expect(signal.executable).toBe(false);
    // Sanity invariant of a display-only gap signal.
    expect(signal.gap).toBeGreaterThanOrEqual(0);
  }
  // There is NEVER a returned signal with executable !== false.
  expect(signals.every((s) => s.executable === false)).toBe(true);
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 5: display-only invariant — every returned signal is executable=false (Req 3.3, 12.1)", () => {
  it("holds for computeSignals across a wide variety of single-event inputs", async () => {
    await fc.assert(
      fc.asyncProperty(arbMarketSpecs, async (specs) => {
        const canonicalId = "canon-single";
        const markets = specs.map((spec, i) => toLinkedMarket(spec, canonicalId, 0, i));
        const repo = new FakeMatchingRepository(new Map([[canonicalId, markets]]));

        const probById = new Map<string, number | null>(
          markets.map((m, i) => [m.id, specs[i]!.prob]),
        );
        const getYesImpliedProb = (m: LinkedMarket): Promise<number | null> =>
          Promise.resolve(probById.get(m.id) ?? null);

        const signals = await computeSignals(canonicalId, { repo, getYesImpliedProb });

        assertDisplayOnly(signals);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("holds for computeSignalsForMany across many events, and for rankSignals over the result", async () => {
    await fc.assert(
      fc.asyncProperty(arbEvents, async (events) => {
        const byCanonical = new Map<string, LinkedMarket[]>();
        const probById = new Map<string, number | null>();

        const canonicalIds = events.map((specs, eventIdx) => {
          const canonicalId = `canon-${eventIdx}`;
          const markets = specs.map((spec, marketIdx) => {
            const market = toLinkedMarket(spec, canonicalId, eventIdx, marketIdx);
            probById.set(market.id, spec.prob);
            return market;
          });
          byCanonical.set(canonicalId, markets);
          return canonicalId;
        });

        const repo = new FakeMatchingRepository(byCanonical);
        const getYesImpliedProb = (m: LinkedMarket): Promise<number | null> =>
          Promise.resolve(probById.get(m.id) ?? null);

        const signals = await computeSignalsForMany(canonicalIds, {
          repo,
          getYesImpliedProb,
        });

        // Many-event entry point: every returned signal is display-only.
        assertDisplayOnly(signals);

        // Ranking is a pure reordering — the invariant must survive it.
        assertDisplayOnly(rankSignals(signals));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
