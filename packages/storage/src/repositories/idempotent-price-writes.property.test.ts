/**
 * Property-based test for **idempotent price writes** (design "Correctness
 * Properties" → Property 2; task 3.5).
 *
 * Encodes the universal rule from the design:
 *
 *   ∀ price points p, writing p more than once (e.g. reconnect backfill
 *   overlapping live ticks) — in any order, via any write path — yields
 *   exactly one row keyed by (market_id, outcome_id, ts).
 *
 * Concretely, for one randomly seeded market with one or more outcomes we
 * generate a *stream* of price observations whose `ts` values are drawn from a
 * small fixed pool, so the same `(outcome_id, ts)` key recurs (duplicates) and
 * the stream is shuffled (reorderings). The stream is partitioned into a random
 * sequence of write operations, each performed either as repeated single
 * `writePricePoint` calls or as one `writePricePoints` batch, so both code
 * paths — and conflicts *across* paths — are exercised. We then assert:
 *   - the persisted row count equals the number of *distinct*
 *     `(market_id, outcome_id, ts)` keys in the stream (no duplicate rows,
 *     regardless of repetition or ordering); and
 *   - each stored point holds the last-written `(price, volume)` for its key
 *     (last-write-wins), which is necessarily one of the submitted values.
 *
 * This is an integration property: it runs against the docker-compose
 * TimescaleDB and skips gracefully when the database is unreachable (see
 * test-support.connectOrSkip). Each fast-check run isolates its data behind a
 * freshly created `source` and cleans it up in a `finally`, so runs (and
 * shrink replays) never interfere.
 *
 * **Validates: Requirements 7.2**
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { Pool } from "pg";
import type { OutcomeUpsert, PricePoint } from "@pma/core";
import { MarketRepository, OutcomeRepository, PricePointRepository } from "./index.js";
import { connectOrSkip, createSource, cleanupSource, uniqueKey } from "../test-support.js";

/**
 * Number of fast-check runs. Kept modest because each run performs many real
 * database round-trips (create source → seed market+outcomes → write stream →
 * read back → cleanup).
 */
const NUM_RUNS = 25;

/** Generous timeout: the whole property drives many DB round-trips per run. */
const TEST_TIMEOUT_MS = 120_000;

/**
 * A small fixed pool of distinct, whole-millisecond ISO 8601 timestamps. Drawing
 * `ts` from a tiny pool guarantees duplicate `(outcome_id, ts)` keys arise in a
 * generated stream (the essence of the reconnect-backfill-overlap scenario).
 * Whole-millisecond instants round-trip exactly through `timestamptz`.
 */
const TS_POOL: readonly string[] = Array.from({ length: 6 }, (_, i) =>
  new Date(Date.UTC(2025, 0, 1, 0, i, 0, 0)).toISOString(),
);

/** Up to this many outcomes are seeded per run (distinct labels). */
const MAX_OUTCOMES = 3;
const OUTCOME_LABELS = ["Yes", "No", "Maybe"] as const;

let pool: Pool | null = null;

beforeAll(async () => {
  pool = await connectOrSkip();
});

afterAll(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A generated price observation referencing seeded fixtures by index. */
interface PointSpec {
  /** Which seeded outcome this point targets (0..outcomeCount-1). */
  outcomeSlot: number;
  /** Which pooled timestamp this point uses (index into TS_POOL). */
  tsIndex: number;
  /** Price in [0,1] (satisfies the `price BETWEEN 0 AND 1` CHECK). */
  price: number;
  /** Observed volume; nullable. */
  volume: number | null;
}

/** One write operation: either a batch write or a run of single writes. */
interface WriteOp {
  useBatch: boolean;
  points: PointSpec[];
}

/** The full generated scenario for a single run. */
interface Scenario {
  outcomeCount: number;
  ops: WriteOp[];
}

const priceArb = fc.double({ min: 0, max: 1, noNaN: true });
const volumeArb = fc.option(fc.double({ min: 0, max: 1e6, noNaN: true }), { nil: null });

const pointSpecArb = (outcomeCount: number): fc.Arbitrary<PointSpec> =>
  fc.record({
    outcomeSlot: fc.nat({ max: outcomeCount - 1 }),
    tsIndex: fc.nat({ max: TS_POOL.length - 1 }),
    price: priceArb,
    volume: volumeArb,
  });

const writeOpArb = (outcomeCount: number): fc.Arbitrary<WriteOp> =>
  fc.record({
    useBatch: fc.boolean(),
    points: fc.array(pointSpecArb(outcomeCount), { minLength: 1, maxLength: 5 }),
  });

/**
 * A scenario: a number of outcomes to seed plus a sequence of write operations.
 * `chain` is used so per-point indices are constrained to the chosen outcome
 * count (so a generated point always targets a real seeded outcome).
 */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: MAX_OUTCOMES })
  .chain((outcomeCount) =>
    fc.record({
      outcomeCount: fc.constant(outcomeCount),
      ops: fc.array(writeOpArb(outcomeCount), { minLength: 1, maxLength: 5 }),
    }),
  );

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable composite key for a persisted price point. */
function keyOf(marketId: string, outcomeId: string, ts: string): string {
  return `${marketId}\u0000${outcomeId}\u0000${ts}`;
}

/** Materialize a generated spec into a concrete {@link PricePoint}. */
function materialize(spec: PointSpec, marketId: string, outcomeIds: string[]): PricePoint {
  return {
    marketId,
    // outcomeSlot is already constrained to a valid index by the generator.
    outcomeId: outcomeIds[spec.outcomeSlot] as string,
    ts: TS_POOL[spec.tsIndex] as string,
    price: spec.price,
    volume: spec.volume,
  };
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 2: idempotent price writes — exactly one row per (market_id, outcome_id, ts)", () => {
  it("skips when the database is unavailable", () => {
    // Surfaces *why* the property did not run, mirroring the functional suite.
    if (!pool) expect(pool).toBeNull();
    else expect(pool).not.toBeNull();
  });

  it(
    "a stream of duplicate, reordered price points collapses to one row per key (LWW)",
    async () => {
      if (!pool) return;
      const db = pool;

      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          // Fresh, isolated source per run so runs (and shrink replays) never
          // interfere; always cleaned up, even on assertion failure.
          const sourceId = await createSource(db, uniqueKey("src"));
          try {
            // Seed a market and the chosen number of outcomes (FK targets).
            const market = await new MarketRepository(db).upsertMarket({
              sourceId,
              eventId: null,
              canonicalEventId: null,
              externalId: uniqueKey("mkt"),
              question: "Will the property hold for all reorderings?",
              status: "open",
              volume24h: null,
              liquidity: null,
              spread: null,
              resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
            });

            const outcomeRepo = new OutcomeRepository(db);
            const seededOutcomes = await outcomeRepo.upsertOutcomes(
              Array.from(
                { length: scenario.outcomeCount },
                (_, i): OutcomeUpsert => ({
                  marketId: market.id,
                  label: OUTCOME_LABELS[i] as string,
                  tokenId: null,
                  impliedProb: 0.5,
                  lastPrice: 0.5,
                }),
              ),
            );
            const outcomeIds = seededOutcomes.map((o) => o.id);

            const priceRepo = new PricePointRepository(db);

            // Replay the stream in execution order to compute the expected
            // persisted state. Setting expected[key] for every point in order
            // yields last-write-wins for both paths: a single write applies
            // each point, and a batch applies only the last occurrence of a
            // key — both end at the last occurrence's value.
            const expected = new Map<string, { price: number; volume: number | null }>();

            for (const op of scenario.ops) {
              const points = op.points.map((spec) => materialize(spec, market.id, outcomeIds));
              for (const p of points) {
                expected.set(keyOf(p.marketId, p.outcomeId, p.ts), {
                  price: p.price,
                  volume: p.volume,
                });
              }
              // Exercise both write paths; conflicts across paths are tested
              // because keys recur across operations.
              if (op.useBatch) {
                await priceRepo.writePricePoints(points);
              } else {
                for (const p of points) await priceRepo.writePricePoint(p);
              }
            }

            // Core property: exactly one row per distinct key — the persisted
            // row count equals the number of distinct keys in the stream,
            // regardless of duplicates or ordering.
            const countResult = await db.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM price_point WHERE market_id = $1`,
              [market.id],
            );
            expect(Number(countResult.rows[0]?.count)).toBe(expected.size);

            // Last-write-wins: each stored point holds the final submitted
            // (price, volume) for its key (hence one of the submitted values).
            const rows = await db.query<{
              outcome_id: string;
              ts: Date;
              price: string;
              volume: string | null;
            }>(`SELECT outcome_id, ts, price, volume FROM price_point WHERE market_id = $1`, [
              market.id,
            ]);
            expect(rows.rows.length).toBe(expected.size);
            for (const row of rows.rows) {
              const key = keyOf(market.id, row.outcome_id, row.ts.toISOString());
              const want = expected.get(key);
              expect(want).toBeDefined();
              if (!want) continue;
              expect(Number(row.price)).toBeCloseTo(want.price, 9);
              if (want.volume === null) {
                expect(row.volume).toBeNull();
              } else {
                expect(Number(row.volume)).toBeCloseTo(want.volume, 6);
              }
            }

            return true;
          } finally {
            await cleanupSource(db, sourceId);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
