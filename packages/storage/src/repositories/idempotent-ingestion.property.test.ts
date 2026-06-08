/**
 * Property-based test for **idempotent ingestion** (design "Correctness
 * Properties" → Property 1 / P2; task 3.4).
 *
 * Encodes the universal rule from the design:
 *
 *   ∀ markets m, for any number of repeated syncs over the same upstream state,
 *   the persisted row count and content are unchanged after the first sync:
 *       upsert(m) ∘ upsert(m) ≡ upsert(m)
 *
 * Concretely, for a randomly generated *set* of markets under a single source
 * we apply `MarketRepository.upsertMarket` once, snapshot the persisted state,
 * apply the identical upserts twice more, and assert:
 *   - the source's market row count is unchanged (no duplicate rows);
 *   - the persisted, mapped content is byte-for-byte identical; and
 *   - `updated_at` does not advance (the `IS DISTINCT FROM` content guard makes
 *     an identical re-sync a true no-op).
 *
 * This is an integration property: it runs against the docker-compose
 * TimescaleDB and skips gracefully when the database is unreachable (see
 * test-support.connectOrSkip). Each fast-check run isolates its data behind a
 * freshly created `source` and cleans it up in a `finally`, so runs (and
 * shrink replays) never interfere.
 *
 * **Validates: Requirements 7.1**
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc from "fast-check";
import type { Pool } from "pg";
import type { MarketStatus, MarketUpsert, ResolutionCriteria } from "@pma/core";
import { MarketRepository } from "./index.js";
import { mapMarketRow, type MarketRow } from "../mappers.js";
import { connectOrSkip, createSource, cleanupSource, uniqueKey } from "../test-support.js";

/**
 * Number of fast-check runs. Kept modest because each run performs several real
 * database round-trips (create source → multi-upsert × 3 passes → snapshot ×2 →
 * cleanup).
 */
const NUM_RUNS = 25;

/** Generous timeout: the whole property drives many DB round-trips per run. */
const TEST_TIMEOUT_MS = 120_000;

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

/**
 * Printable text with control characters (incl. the NUL byte Postgres rejects
 * in `text`/`jsonb`) stripped, so generated content is always storable. The
 * idempotency property is independent of the exact characters used.
 */
const safeText = (opts?: { maxLength?: number }): fc.Arbitrary<string> =>
  fc.string(opts).map((s) =>
    Array.from(s)
      .filter((c) => c >= " ")
      .join(""),
  );

/** A nullable, finite, non-negative numeric metadata field (e.g. volume/liquidity). */
const nullableNonNegative = (max: number): fc.Arbitrary<number | null> =>
  fc.option(fc.double({ min: 0, max, noNaN: true }), { nil: null });

/** Arbitrary JSON-serializable scalar for the preserved `raw` resolution bag. */
const rawScalar = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    safeText({ maxLength: 12 }),
    fc.integer({ min: -1_000_000, max: 1_000_000 }),
    fc.double({ min: -1e6, max: 1e6, noNaN: true }),
    fc.boolean(),
    fc.constant(null),
  );

/** A {@link ResolutionCriteria} with nullable structured fields and a preserved raw bag. */
const resolutionCriteriaArb = (): fc.Arbitrary<ResolutionCriteria> =>
  fc.record({
    dataSource: fc.option(safeText({ maxLength: 24 }), { nil: null }),
    cutoffTime: fc.option(safeText({ maxLength: 24 }), { nil: null }),
    rounding: fc.option(safeText({ maxLength: 24 }), { nil: null }),
    raw: fc.dictionary(safeText({ maxLength: 8 }), rawScalar(), { maxKeys: 4 }),
  });

const statusArb: fc.Arbitrary<MarketStatus> = fc.constantFrom("open", "closed", "resolved");

/** The mutable fields of a market (everything except the idempotency key). */
interface MarketSpec {
  token: string;
  question: string;
  status: MarketStatus;
  volume24h: number | null;
  liquidity: number | null;
  spread: number | null;
  resolutionCriteria: ResolutionCriteria;
}

const marketSpecArb = (): fc.Arbitrary<MarketSpec> =>
  fc.record({
    // A random component for the externalId; uniqueness is guaranteed by the
    // index suffix added in toUpserts (so a set never self-collides).
    token: safeText({ maxLength: 12 }),
    question: safeText({ maxLength: 60 }),
    status: statusArb,
    volume24h: nullableNonNegative(1e9),
    liquidity: nullableNonNegative(1e9),
    // spread has a CHECK (spread >= 0) constraint.
    spread: nullableNonNegative(100),
    resolutionCriteria: resolutionCriteriaArb(),
  });

/** A set of markets (possibly empty) to ingest under one source. */
const marketSetArb = (): fc.Arbitrary<MarketSpec[]> =>
  fc.array(marketSpecArb(), { minLength: 0, maxLength: 5 });

/** Materialize specs into `MarketUpsert`s with unique externalIds for one source. */
function toUpserts(sourceId: string, specs: MarketSpec[]): MarketUpsert[] {
  return specs.map((spec, index) => ({
    sourceId,
    eventId: null,
    canonicalEventId: null,
    // Index suffix guarantees uniqueness within the set regardless of `token`.
    externalId: `mkt-${spec.token}-${index}`,
    question: spec.question,
    status: spec.status,
    volume24h: spec.volume24h,
    liquidity: spec.liquidity,
    spread: spec.spread,
    resolutionCriteria: spec.resolutionCriteria,
  }));
}

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

interface Snapshot {
  count: number;
  /** Mapped domain content keyed by externalId (order-independent). */
  byExternalId: Record<string, ReturnType<typeof mapMarketRow>>;
  /** `updated_at` (ISO) keyed by externalId, to assert no-net-change. */
  updatedAtByExternalId: Record<string, string>;
}

/** Read the full persisted state for a source as a comparable snapshot. */
async function snapshot(db: Pool, sourceId: string): Promise<Snapshot> {
  const result = await db.query<MarketRow>(
    `SELECT id, source_id, event_id, canonical_event_id, external_id, question,
            category, status, volume_24h, liquidity, spread, resolution_criteria,
            resolution_mismatch, updated_at
       FROM market
      WHERE source_id = $1
      ORDER BY external_id`,
    [sourceId],
  );
  const byExternalId: Snapshot["byExternalId"] = {};
  const updatedAtByExternalId: Snapshot["updatedAtByExternalId"] = {};
  for (const row of result.rows) {
    const market = mapMarketRow(row);
    byExternalId[market.externalId] = market;
    updatedAtByExternalId[market.externalId] =
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  }
  return { count: result.rows.length, byExternalId, updatedAtByExternalId };
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 1 (P2): idempotent ingestion — upsert ∘ upsert ≡ upsert", () => {
  it("skips when the database is unavailable", () => {
    // Surfaces *why* the property did not run, mirroring the functional suite.
    if (!pool) expect(pool).toBeNull();
    else expect(pool).not.toBeNull();
  });

  it(
    "repeated upserts of the same market set leave row count and content unchanged",
    async () => {
      if (!pool) return;
      const db = pool;

      await fc.assert(
        fc.asyncProperty(marketSetArb(), async (specs) => {
          // Fresh, isolated source per run so runs (and shrink replays) never
          // interfere; always cleaned up, even on assertion failure.
          const sourceId = await createSource(db, uniqueKey("src"));
          try {
            const repo = new MarketRepository(db);
            const upserts = toUpserts(sourceId, specs);

            // First sync.
            for (const m of upserts) await repo.upsertMarket(m);
            const afterFirst = await snapshot(db, sourceId);

            // The first sync persisted exactly one row per (unique) externalId.
            expect(afterFirst.count).toBe(upserts.length);

            // Repeat the identical sync twice more: upsert ∘ upsert (∘ upsert).
            for (let pass = 0; pass < 2; pass++) {
              for (const m of upserts) await repo.upsertMarket(m);
            }
            const afterRepeats = await snapshot(db, sourceId);

            // No duplicate rows: row count is unchanged after repeats.
            expect(afterRepeats.count).toBe(afterFirst.count);

            // Content is identical (same ids, same mapped fields).
            expect(afterRepeats.byExternalId).toEqual(afterFirst.byExternalId);

            // No net change: identical re-upserts never advance updated_at.
            expect(afterRepeats.updatedAtByExternalId).toEqual(afterFirst.updatedAtByExternalId);

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
