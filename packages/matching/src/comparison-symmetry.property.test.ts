import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  CandidateQuery,
  CanonicalEvent,
  CanonicalLinkOptions,
  LinkedMarket,
  Market,
  MatchingRepository,
  ResolutionCriteria,
} from "@pma/core";
import { computeSignals } from "./signals.js";

/**
 * Property-based test for **comparison symmetry** (design.md "Correctness
 * Properties" → Property 9 "Comparison symmetry"; task 6.8).
 *
 * Two universal rules, straight from Requirement 2.2 ("WHEN markets are linked
 * to the same canonical event THEN the linkage SHALL be symmetric (if A links
 * to B, B links to A) and the computed maximum spread SHALL be identical
 * regardless of row ordering") and the `ComparisonView.maxSpread` /
 * `SpreadSignal.gap` contracts:
 *
 *   1. **Symmetric, order-independent linkage.** Linking A to the same
 *      canonical event as B is an *undirected* operation: afterwards A and B
 *      belong to the same canonical event regardless of the argument order
 *      (`link(A, B)` ≡ `link(B, A)`), and the resulting canonical-event
 *      membership *partition* depends only on the SET of links, never on the
 *      order or orientation in which they were applied. Concretely, applying
 *      the same set of undirected links to two independent repositories — in
 *      different permutations and orientations — yields identical membership
 *      partitions.
 *
 *   2. **Order-independent maxSpread.** The cross-platform "maxSpread" (the
 *      `computeSignals` gap = max − min of the aligned Yes implied
 *      probabilities) is identical no matter what order
 *      `marketsForCanonical` returns the rows in. Permuting the row array
 *      neither changes the gap nor the per-platform set.
 *
 * ## Modelling canonical membership (test-only repository)
 *
 * The signal/no-false-arbitrage tests use a fake repo that returns a *fixed*
 * market list. Symmetry, however, is a property of the *linking* operation, so
 * this file builds a fuller {@link InMemoryMatchingRepository} that actually
 * MODELS canonical membership with union-find semantics:
 *
 *   - `linkToCanonical(A, B, { mismatch })` places A and B in the same
 *     canonical event — creating one if neither is linked, attaching the
 *     unlinked side if exactly one is linked, and MERGING the two components if
 *     both are already linked (to different events). It is fully symmetric in
 *     its first two arguments and stamps `resolutionMismatch = true` on the
 *     endpoints when `mismatch` is set.
 *   - `marketsForCanonical(id)` returns that event's members (each a
 *     {@link LinkedMarket} carrying its `resolutionMismatch` flag).
 *
 * This repository is deliberately scoped to this test file (clearly marked
 * not-for-production); production wires the Postgres-backed repository from
 * `@pma/storage`.
 *
 * Everything is in-memory and deterministic, so we run many randomized link
 * sets / orderings / orientations and many randomized probability orderings.
 *
 * **Validates: Requirements 2.2**
 */

/** In-memory + cheap: exercise many link sets / orderings / orientations. */
const NUM_RUNS = 350;

// ---------------------------------------------------------------------------
// Test-only in-memory MatchingRepository (union-find canonical membership)
// ---------------------------------------------------------------------------

function criteria(): ResolutionCriteria {
  return { dataSource: null, cutoffTime: null, rounding: null, raw: {} };
}

/** Build a minimal open, aligned {@link LinkedMarket} for a given id. */
function makeMarket(id: string, sourceId: string): LinkedMarket {
  return {
    id,
    sourceId,
    eventId: null,
    canonicalEventId: null,
    externalId: `ext-${id}`,
    question: "Will BTC close above $100,000 in 2025?",
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    resolutionCriteria: criteria(),
    resolutionMismatch: false,
  };
}

/**
 * A test-only {@link MatchingRepository} that models canonical-event membership
 * as a union-find partition over a fixed universe of markets. NOT for
 * production — it exists only to exercise the symmetry / order-independence
 * property of linkage.
 */
class InMemoryMatchingRepository implements MatchingRepository {
  /** All known markets, keyed by id (the fixed universe). */
  private readonly markets = new Map<string, LinkedMarket>();
  /** marketId → its canonical-event id (absent ⇒ unlinked / singleton). */
  private readonly canonicalOf = new Map<string, string>();
  /** canonical-event id → its member market ids. */
  private readonly members = new Map<string, Set<string>>();
  /** Monotonic counter so freshly created canonical events get distinct ids. */
  private nextCanonical = 0;

  /** Register a market into the universe (unlinked initially). */
  register(market: LinkedMarket): void {
    this.markets.set(market.id, market);
  }

  /** The canonical-event id a market currently belongs to, or `null`. */
  canonicalIdOf(marketId: string): string | null {
    return this.canonicalOf.get(marketId) ?? null;
  }

  findCandidates(_query: CandidateQuery): Promise<Market[]> {
    return Promise.reject(new Error("findCandidates is not used by the comparison-symmetry test"));
  }

  /**
   * Symmetric, union-find link of two markets into one canonical event.
   * Mirrors the design contract: "linking A to B places both in the same
   * canonical event ... membership is order-independent".
   */
  linkToCanonical(
    marketA: Market,
    marketB: Market,
    options: CanonicalLinkOptions,
  ): Promise<CanonicalEvent> {
    const a = marketA.id;
    const b = marketB.id;
    const ca = this.canonicalOf.get(a);
    const cb = this.canonicalOf.get(b);

    let canonicalId: string;
    if (ca === undefined && cb === undefined) {
      // Neither linked → create a fresh canonical event with both.
      canonicalId = this.createCanonical();
      this.attach(a, canonicalId);
      this.attach(b, canonicalId);
    } else if (ca !== undefined && cb === undefined) {
      // Only A linked → attach B to A's event.
      canonicalId = ca;
      this.attach(b, canonicalId);
    } else if (ca === undefined && cb !== undefined) {
      // Only B linked → attach A to B's event.
      canonicalId = cb;
      this.attach(a, canonicalId);
    } else if (ca === cb) {
      // Both already in the same event → no-op.
      canonicalId = ca as string;
    } else {
      // Both linked to different events → merge B's into A's.
      canonicalId = this.merge(ca as string, cb as string);
    }

    // Stamp the mismatch flag on the two endpoints when set (Requirement 2.3 /
    // Layer 4); membership (what symmetry compares) is unaffected by the flag.
    if (options.mismatch) {
      this.flagMismatch(a);
      this.flagMismatch(b);
    }

    return Promise.resolve(this.canonicalEvent(canonicalId));
  }

  marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    const ids = this.members.get(canonicalEventId);
    if (ids === undefined) return Promise.resolve([]);
    const out: LinkedMarket[] = [];
    for (const id of ids) {
      const m = this.markets.get(id);
      if (m !== undefined) out.push(m);
    }
    return Promise.resolve(out);
  }

  // --- internal helpers ----------------------------------------------------

  private createCanonical(): string {
    const id = `canon-${this.nextCanonical}`;
    this.nextCanonical += 1;
    this.members.set(id, new Set<string>());
    return id;
  }

  private attach(marketId: string, canonicalId: string): void {
    this.canonicalOf.set(marketId, canonicalId);
    this.members.get(canonicalId)?.add(marketId);
    const m = this.markets.get(marketId);
    if (m !== undefined) m.canonicalEventId = canonicalId;
  }

  /** Merge `from` into `into`, returning the surviving canonical id. */
  private merge(into: string, from: string): string {
    const fromMembers = this.members.get(from) ?? new Set<string>();
    for (const id of fromMembers) this.attach(id, into);
    this.members.delete(from);
    return into;
  }

  private flagMismatch(marketId: string): void {
    const m = this.markets.get(marketId);
    if (m !== undefined) m.resolutionMismatch = true;
  }

  private canonicalEvent(id: string): CanonicalEvent {
    return {
      id,
      title: id,
      category: "crypto",
      subjectEntity: null,
      thresholdValue: null,
      targetDate: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Part 1 — symmetric / order-independent linkage
// ---------------------------------------------------------------------------

/** A single undirected link between two distinct market indices, plus its flag. */
interface LinkSpec {
  a: number;
  b: number;
  mismatch: boolean;
}

/** Generate a pair of DISTINCT indices in `[0, n)` without rejection sampling. */
function arbDistinctPair(n: number): fc.Arbitrary<[number, number]> {
  return fc
    .integer({ min: 0, max: n - 1 })
    .chain((a) =>
      fc.integer({ min: 0, max: n - 2 }).map((x): [number, number] => [a, x >= a ? x + 1 : x]),
    );
}

/**
 * A full scenario: a universe of `numMarkets` markets, a SET of undirected
 * links, plus two independent ways to replay that set — a permutation of the
 * links and a per-link orientation (which argument goes first) for each repo.
 */
interface LinkScenario {
  numMarkets: number;
  links: LinkSpec[];
  /** A permutation of `[0, links.length)` giving repo B's apply order. */
  order2: number[];
  /** Per-link orientation for repo A (true ⇒ apply as (b, a)). */
  orient1: boolean[];
  /** Per-link orientation for repo B (true ⇒ apply as (b, a)). */
  orient2: boolean[];
}

const arbScenario: fc.Arbitrary<LinkScenario> = fc.integer({ min: 2, max: 8 }).chain((numMarkets) =>
  fc
    .array(
      arbDistinctPair(numMarkets).chain(([a, b]) =>
        fc.boolean().map((mismatch): LinkSpec => ({ a, b, mismatch })),
      ),
      { minLength: 0, maxLength: 12 },
    )
    .chain((links) => {
      const indices = links.map((_link, i) => i);
      const permArb: fc.Arbitrary<number[]> =
        indices.length === 0
          ? fc.constant<number[]>([])
          : fc.shuffledSubarray(indices, {
              minLength: indices.length,
              maxLength: indices.length,
            });
      const boolArr = fc.array(fc.boolean(), {
        minLength: links.length,
        maxLength: links.length,
      });
      return fc.record<LinkScenario>({
        numMarkets: fc.constant(numMarkets),
        links: fc.constant(links),
        order2: permArb,
        orient1: boolArr,
        orient2: boolArr,
      });
    }),
);

/** Build a fresh repository populated with `numMarkets` unlinked markets. */
function freshRepo(numMarkets: number): InMemoryMatchingRepository {
  const repo = new InMemoryMatchingRepository();
  for (let i = 0; i < numMarkets; i += 1) {
    repo.register(makeMarket(`m-${i}`, `src-${i}`));
  }
  return repo;
}

/**
 * The canonical-event membership partition of a repo over the fixed universe,
 * normalized so it is comparable across repos that minted different canonical
 * ids: a sorted list of sorted member-id groups (unlinked markets are
 * singletons). This is the "set of member-id-sets" the property compares.
 */
function normalizedPartition(repo: InMemoryMatchingRepository, numMarkets: number): string {
  const groups = new Map<string, string[]>();
  const singletons: string[][] = [];
  for (let i = 0; i < numMarkets; i += 1) {
    const id = `m-${i}`;
    const cid = repo.canonicalIdOf(id);
    if (cid === null) {
      singletons.push([id]);
    } else {
      const g = groups.get(cid);
      if (g === undefined) groups.set(cid, [id]);
      else g.push(id);
    }
  }
  const components = [...groups.values(), ...singletons].map((g) => [...g].sort());
  components.sort((x, y) => {
    const a = x.join(",");
    const b = y.join(",");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return JSON.stringify(components);
}

async function applyLink(
  repo: InMemoryMatchingRepository,
  link: LinkSpec,
  reversed: boolean,
): Promise<void> {
  const first = makeMarket(`m-${link.a}`, `src-${link.a}`);
  const second = makeMarket(`m-${link.b}`, `src-${link.b}`);
  const [x, y] = reversed ? [second, first] : [first, second];
  await repo.linkToCanonical(x, y, { mismatch: link.mismatch });
}

describe("Property 9: comparison symmetry — canonical-event linkage is symmetric / order-independent (Req 2.2)", () => {
  it("places both endpoints in the same canonical event, and the membership partition is independent of link order and orientation", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { numMarkets, links, order2, orient1, orient2 } = scenario;

        // Repo A: links in natural order, orientation per orient1.
        const repoA = freshRepo(numMarkets);
        for (let i = 0; i < links.length; i += 1) {
          await applyLink(repoA, links[i]!, orient1[i]!);
        }

        // Repo B: links in a different permutation, with a different (often
        // swapped) orientation — same UNDIRECTED set of links.
        const repoB = freshRepo(numMarkets);
        for (const j of order2) {
          await applyLink(repoB, links[j]!, orient2[j]!);
        }

        // (1) Symmetric linkage: after applying a link, BOTH endpoints share a
        // (non-null) canonical event in each repo, and each event's membership
        // contains both endpoints.
        for (const link of links) {
          const idA = `m-${link.a}`;
          const idB = `m-${link.b}`;
          for (const repo of [repoA, repoB]) {
            const cidA = repo.canonicalIdOf(idA);
            const cidB = repo.canonicalIdOf(idB);
            expect(cidA).not.toBeNull();
            expect(cidA).toBe(cidB);
            const memberIds = (await repo.marketsForCanonical(cidA as string)).map((m) => m.id);
            expect(memberIds).toContain(idA);
            expect(memberIds).toContain(idB);
          }
        }

        // (2) Order-/orientation-independence: the two repos built from the
        // same link SET have identical membership partitions.
        expect(normalizedPartition(repoB, numMarkets)).toBe(normalizedPartition(repoA, numMarkets));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2 — order-independent maxSpread (computeSignals gap)
// ---------------------------------------------------------------------------

/** A generated aligned, usable market: distinct source + a finite 0..1 prob. */
interface AlignedMarketSpec {
  prob: number;
}

const arbAlignedMarkets: fc.Arbitrary<AlignedMarketSpec[]> = fc.array(
  fc.record<AlignedMarketSpec>({
    prob: fc.double({ min: 0, max: 1, noNaN: true }),
  }),
  { minLength: 2, maxLength: 6 },
);

/** Build a repo whose `marketsForCanonical` returns exactly `markets`, in order. */
function fixedListRepo(markets: LinkedMarket[]): MatchingRepository {
  return {
    findCandidates(_q: CandidateQuery): Promise<Market[]> {
      return Promise.reject(new Error("findCandidates is not used here"));
    },
    linkToCanonical(_a: Market, _b: Market, _o: CanonicalLinkOptions): Promise<CanonicalEvent> {
      return Promise.reject(new Error("linkToCanonical is not used here"));
    },
    marketsForCanonical(_id: string): Promise<LinkedMarket[]> {
      return Promise.resolve(markets);
    },
  };
}

/** Sort a per-platform list by source so two orderings are comparable. */
function sortedLegs(
  legs: ReadonlyArray<{ source: string; impliedProb: number }>,
): Array<{ source: string; impliedProb: number }> {
  return [...legs].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

describe("Property 9: comparison symmetry — maxSpread is identical regardless of row ordering (Req 2.2)", () => {
  it("computeSignals' gap and per-platform set are invariant under any permutation of the canonical event's markets", async () => {
    const CANONICAL_ID = "canon-spread";

    const scenario = arbAlignedMarkets.chain((specs) => {
      const indices = specs.map((_s, i) => i);
      const permArb = fc.shuffledSubarray(indices, {
        minLength: indices.length,
        maxLength: indices.length,
      });
      return fc.record({
        specs: fc.constant(specs),
        permutation: permArb,
      });
    });

    await fc.assert(
      fc.asyncProperty(scenario, async ({ specs, permutation }) => {
        // Distinct source per market so legs are uniquely attributable.
        const markets: LinkedMarket[] = specs.map((spec, i) => {
          const m = makeMarket(`m-${i}`, `src-${i}`);
          m.canonicalEventId = CANONICAL_ID;
          return m;
        });
        const probById = new Map<string, number>(markets.map((m, i) => [m.id, specs[i]!.prob]));
        const getYesImpliedProb = (m: LinkedMarket): Promise<number | null> =>
          Promise.resolve(probById.get(m.id) ?? null);

        // Original order.
        const signalsOriginal = await computeSignals(CANONICAL_ID, {
          repo: fixedListRepo(markets),
          getYesImpliedProb,
        });

        // Permuted order — same SET of rows, different sequence.
        const permuted = permutation.map((j) => markets[j]!);
        const signalsPermuted = await computeSignals(CANONICAL_ID, {
          repo: fixedListRepo(permuted),
          getYesImpliedProb,
        });

        // ≥ 2 usable aligned markets ⇒ exactly one signal in both orderings.
        expect(signalsOriginal).toHaveLength(1);
        expect(signalsPermuted).toHaveLength(1);
        const original = signalsOriginal[0]!;
        const reordered = signalsPermuted[0]!;

        // maxSpread (gap) is BIT-IDENTICAL regardless of row order: max/min over
        // the same multiset pick the same values, so the difference is the same.
        expect(reordered.gap).toBe(original.gap);
        expect(original.gap).toBeGreaterThanOrEqual(0);

        // The per-platform set is identical (legs may be emitted in a different
        // order, but the {source → prob} mapping is the same).
        expect(sortedLegs(reordered.perPlatform)).toEqual(sortedLegs(original.perPlatform));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
