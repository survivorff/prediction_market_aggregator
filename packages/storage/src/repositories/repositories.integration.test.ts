/**
 * Functional-correctness integration tests for the `@pma/storage`
 * repositories, run against the docker-compose TimescaleDB.
 *
 * These cover the happy-path and idempotency behaviour of the concrete
 * repositories (Requirements 7.1, 7.2, 10.1, 10.2). Dedicated property-based
 * idempotency tests are added by tasks 3.4 / 3.5.
 *
 * When the database is unreachable the whole suite skips gracefully (see
 * test-support.connectOrSkip) rather than hard-failing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Pool } from "pg";
import type { MarketUpsert, OutcomeUpsert, PricePoint, ResolutionCriteria } from "@pma/core";
import {
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  CanonicalEventRepository,
  CursorRepository,
} from "./index.js";
import {
  connectOrSkip,
  createSource,
  cleanupSource,
  cleanupCanonicalEvent,
  uniqueKey,
} from "../test-support.js";

let pool: Pool | null = null;

beforeAll(async () => {
  pool = await connectOrSkip();
});

afterAll(async () => {
  if (pool) await pool.end();
});

const sourceIds: string[] = [];
const canonicalIds: string[] = [];

afterEach(async () => {
  if (!pool) return;
  while (canonicalIds.length > 0) {
    const id = canonicalIds.pop();
    if (id) await cleanupCanonicalEvent(pool, id);
  }
  while (sourceIds.length > 0) {
    const id = sourceIds.pop();
    if (id) await cleanupSource(pool, id);
  }
});

/** Register a fresh isolated source for a test and track it for cleanup. */
async function freshSource(): Promise<{ db: Pool; sourceId: string }> {
  if (!pool) throw new Error("pool unavailable");
  const sourceId = await createSource(pool, uniqueKey("src"));
  sourceIds.push(sourceId);
  return { db: pool, sourceId };
}

function sampleCriteria(): ResolutionCriteria {
  return {
    dataSource: "CoinGecko close",
    cutoffTime: "2025-12-31T00:00:00.000Z",
    rounding: "nearest cent",
    raw: { note: "preserved", nested: { a: 1 } },
  };
}

function sampleMarket(sourceId: string, externalId: string): MarketUpsert {
  return {
    sourceId,
    eventId: null,
    canonicalEventId: null,
    externalId,
    question: "Will BTC close above $100k in 2025?",
    status: "open",
    volume24h: 12345.67,
    liquidity: 9876.5,
    spread: 0.02,
    resolutionCriteria: sampleCriteria(),
  };
}

describe("storage repositories (integration)", () => {
  it("skips when the database is unavailable", () => {
    if (!pool) {
      // Surface why the functional assertions did not run.
      expect(pool).toBeNull();
    } else {
      expect(pool).not.toBeNull();
    }
  });

  describe("MarketRepository", () => {
    it("inserts a market and resolves an internal id", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);

      const ext = uniqueKey("mkt");
      const created = await repo.upsertMarket(sampleMarket(sourceId, ext));

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.sourceId).toBe(sourceId);
      expect(created.externalId).toBe(ext);
      expect(created.status).toBe("open");
      // NUMERIC columns come back as numbers, not strings.
      expect(created.volume24h).toBeCloseTo(12345.67, 5);
      expect(created.liquidity).toBeCloseTo(9876.5, 5);
      expect(created.spread).toBeCloseTo(0.02, 5);
      // JSONB round-trips including the preserved raw record.
      expect(created.resolutionCriteria).toEqual(sampleCriteria());
    });

    it("is idempotent: re-upserting the same state yields one row and same id", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);
      const ext = uniqueKey("mkt");
      const market = sampleMarket(sourceId, ext);

      const first = await repo.upsertMarket(market);
      const second = await repo.upsertMarket(market);
      const third = await repo.upsertMarket(market);

      expect(second.id).toBe(first.id);
      expect(third.id).toBe(first.id);

      const countResult = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM market WHERE source_id = $1 AND external_id = $2`,
        [sourceId, ext],
      );
      expect(countResult.rows[0]?.count).toBe("1");
    });

    it("does not advance updated_at when re-upserting identical content", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);
      const ext = uniqueKey("mkt");
      const market = sampleMarket(sourceId, ext);

      const created = await repo.upsertMarket(market);
      const firstUpdatedAt = await db.query<{ updated_at: Date }>(
        `SELECT updated_at FROM market WHERE id = $1`,
        [created.id],
      );
      await repo.upsertMarket(market);
      const secondUpdatedAt = await db.query<{ updated_at: Date }>(
        `SELECT updated_at FROM market WHERE id = $1`,
        [created.id],
      );
      expect(secondUpdatedAt.rows[0]?.updated_at.toISOString()).toBe(
        firstUpdatedAt.rows[0]?.updated_at.toISOString(),
      );
    });

    it("updates mutable fields on conflict", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);
      const ext = uniqueKey("mkt");

      const created = await repo.upsertMarket(sampleMarket(sourceId, ext));
      const updated = await repo.upsertMarket({
        ...sampleMarket(sourceId, ext),
        status: "closed",
        volume24h: 222,
        spread: null,
      });

      expect(updated.id).toBe(created.id);
      expect(updated.status).toBe("closed");
      expect(updated.volume24h).toBe(222);
      expect(updated.spread).toBeNull();
    });

    it("findByExternalId and getById resolve persisted rows", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);
      const ext = uniqueKey("mkt");
      const created = await repo.upsertMarket(sampleMarket(sourceId, ext));

      const byExternal = await repo.findByExternalId(sourceId, ext);
      const byId = await repo.getById(created.id);
      expect(byExternal?.id).toBe(created.id);
      expect(byId?.externalId).toBe(ext);

      expect(await repo.findByExternalId(sourceId, "missing")).toBeNull();
      expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
    });
  });

  describe("OutcomeRepository", () => {
    it("upserts a single outcome idempotently on (market_id, label)", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const market = await new MarketRepository(db).upsertMarket(
        sampleMarket(sourceId, uniqueKey("mkt")),
      );
      const repo = new OutcomeRepository(db);

      const outcome: OutcomeUpsert = {
        marketId: market.id,
        label: "Yes",
        tokenId: "token-123",
        impliedProb: 0.62,
        lastPrice: 0.62,
      };
      const first = await repo.upsertOutcome(outcome);
      const second = await repo.upsertOutcome({ ...outcome, impliedProb: 0.7 });

      expect(second.id).toBe(first.id);
      expect(second.impliedProb).toBeCloseTo(0.7, 5);

      const list = await repo.listByMarket(market.id);
      expect(list).toHaveLength(1);
      expect(list[0]?.label).toBe("Yes");
    });

    it("batch upserts multiple outcomes returning input order", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const market = await new MarketRepository(db).upsertMarket(
        sampleMarket(sourceId, uniqueKey("mkt")),
      );
      const repo = new OutcomeRepository(db);

      const outcomes: OutcomeUpsert[] = [
        {
          marketId: market.id,
          label: "Yes",
          tokenId: null,
          impliedProb: 0.6,
          lastPrice: 0.6,
        },
        {
          marketId: market.id,
          label: "No",
          tokenId: null,
          impliedProb: 0.4,
          lastPrice: 0.4,
        },
      ];
      const result = await repo.upsertOutcomes(outcomes);
      expect(result.map((o) => o.label)).toEqual(["Yes", "No"]);

      // Re-run is idempotent: still two rows, ids stable.
      const rerun = await repo.upsertOutcomes(outcomes);
      expect(rerun[0]?.id).toBe(result[0]?.id);
      expect(rerun[1]?.id).toBe(result[1]?.id);
      expect(await repo.listByMarket(market.id)).toHaveLength(2);
    });

    it("returns [] for an empty batch", async () => {
      if (!pool) return;
      const { db } = await freshSource();
      const repo = new OutcomeRepository(db);
      expect(await repo.upsertOutcomes([])).toEqual([]);
    });
  });

  describe("PricePointRepository", () => {
    async function seedMarketWithOutcome(): Promise<{
      marketId: string;
      outcomeId: string;
    }> {
      if (!pool) throw new Error("pool unavailable");
      const { db, sourceId } = await freshSource();
      const market = await new MarketRepository(db).upsertMarket(
        sampleMarket(sourceId, uniqueKey("mkt")),
      );
      const outcome = await new OutcomeRepository(db).upsertOutcome({
        marketId: market.id,
        label: "Yes",
        tokenId: null,
        impliedProb: 0.5,
        lastPrice: 0.5,
      });
      return { marketId: market.id, outcomeId: outcome.id };
    }

    it("writes a price point and reads it back via latest()", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      const point: PricePoint = {
        marketId,
        outcomeId,
        ts: "2025-01-01T00:00:00.000Z",
        price: 0.55,
        volume: 100,
      };
      await repo.writePricePoint(point);

      const latest = await repo.latest(marketId, outcomeId);
      expect(latest?.price).toBeCloseTo(0.55, 5);
      expect(latest?.ts).toBe("2025-01-01T00:00:00.000Z");
      expect(latest?.volume).toBe(100);
    });

    it("is idempotent on (market_id, outcome_id, ts): one row per key", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      const ts = "2025-02-02T12:00:00.000Z";

      await repo.writePricePoint({
        marketId,
        outcomeId,
        ts,
        price: 0.5,
        volume: 1,
      });
      // Re-write same key (e.g. reconnect backfill overlapping a live tick).
      await repo.writePricePoint({
        marketId,
        outcomeId,
        ts,
        price: 0.6,
        volume: 2,
      });

      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM price_point
         WHERE market_id = $1 AND outcome_id = $2 AND ts = $3`,
        [marketId, outcomeId, ts],
      );
      expect(count.rows[0]?.count).toBe("1");
      const latest = await repo.latest(marketId, outcomeId);
      expect(latest?.price).toBeCloseTo(0.6, 5);
    });

    it("batch write collapses intra-batch duplicate keys to one row", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      const ts = "2025-03-03T00:00:00.000Z";

      await repo.writePricePoints([
        { marketId, outcomeId, ts, price: 0.4, volume: null },
        { marketId, outcomeId, ts, price: 0.45, volume: null },
        {
          marketId,
          outcomeId,
          ts: "2025-03-03T00:01:00.000Z",
          price: 0.5,
          volume: null,
        },
      ]);

      const count = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM price_point WHERE market_id = $1`,
        [marketId],
      );
      expect(count.rows[0]?.count).toBe("2");
    });

    it("history returns points in ascending ts order within range", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      await repo.writePricePoints([
        {
          marketId,
          outcomeId,
          ts: "2025-04-01T00:00:00.000Z",
          price: 0.3,
          volume: null,
        },
        {
          marketId,
          outcomeId,
          ts: "2025-04-01T01:00:00.000Z",
          price: 0.35,
          volume: null,
        },
        {
          marketId,
          outcomeId,
          ts: "2025-04-02T00:00:00.000Z",
          price: 0.4,
          volume: null,
        },
      ]);

      const series = await repo.history(marketId, {
        from: "2025-04-01T00:00:00.000Z",
        to: "2025-04-01T23:59:59.000Z",
      });
      expect(series.map((p) => p.ts)).toEqual([
        "2025-04-01T00:00:00.000Z",
        "2025-04-01T01:00:00.000Z",
      ]);
    });

    it("history downsamples to one point per bucket when interval is set", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      await repo.writePricePoints([
        {
          marketId,
          outcomeId,
          ts: "2025-05-01T00:00:00.000Z",
          price: 0.3,
          volume: null,
        },
        {
          marketId,
          outcomeId,
          ts: "2025-05-01T00:30:00.000Z",
          price: 0.35,
          volume: null,
        },
        {
          marketId,
          outcomeId,
          ts: "2025-05-01T01:00:00.000Z",
          price: 0.4,
          volume: null,
        },
      ]);

      const series = await repo.history(marketId, {
        from: "2025-05-01T00:00:00.000Z",
        to: "2025-05-01T02:00:00.000Z",
        interval: "1h",
      });
      // Two 1h buckets; each keeps its latest point.
      expect(series).toHaveLength(2);
      expect(series[0]?.price).toBeCloseTo(0.35, 5);
      expect(series[1]?.price).toBeCloseTo(0.4, 5);
    });

    it("latest returns null when no points exist", async () => {
      if (!pool) return;
      const { marketId, outcomeId } = await seedMarketWithOutcome();
      const repo = new PricePointRepository(pool);
      expect(await repo.latest(marketId, outcomeId)).toBeNull();
    });
  });

  describe("CanonicalEventRepository", () => {
    it("creates, fetches by id, and lists by category", async () => {
      if (!pool) return;
      const repo = new CanonicalEventRepository(pool);
      const created = await repo.create({
        title: uniqueKey("BTC >100k"),
        category: "crypto",
        subjectEntity: "BTC",
        thresholdValue: 100000,
        targetDate: "2025-12-31T00:00:00.000Z",
      });
      canonicalIds.push(created.id);

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.thresholdValue).toBe(100000);

      const fetched = await repo.getById(created.id);
      expect(fetched?.title).toBe(created.title);
      expect(fetched?.subjectEntity).toBe("BTC");
      expect(fetched?.targetDate).toBe("2025-12-31T00:00:00.000Z");

      const listed = await repo.listByCategory("crypto");
      expect(listed.some((c) => c.id === created.id)).toBe(true);

      expect(await repo.getById("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("preserves null structured fields", async () => {
      if (!pool) return;
      const repo = new CanonicalEventRepository(pool);
      const created = await repo.create({
        title: uniqueKey("no-meta"),
        category: "other",
        subjectEntity: null,
        thresholdValue: null,
        targetDate: null,
      });
      canonicalIds.push(created.id);
      const fetched = await repo.getById(created.id);
      expect(fetched?.subjectEntity).toBeNull();
      expect(fetched?.thresholdValue).toBeNull();
      expect(fetched?.targetDate).toBeNull();
    });
  });

  describe("CursorRepository", () => {
    it("loads null before any save, then round-trips a saved cursor", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new CursorRepository(db);

      expect(await repo.loadCursor(sourceId, "market")).toBeNull();

      await repo.saveCursor(sourceId, "market", "cursor-1");
      expect(await repo.loadCursor(sourceId, "market")).toBe("cursor-1");

      // Independent stream key.
      expect(await repo.loadCursor(sourceId, "event")).toBeNull();

      // Overwrite in place.
      await repo.saveCursor(sourceId, "market", "cursor-2");
      expect(await repo.loadCursor(sourceId, "market")).toBe("cursor-2");

      // Reset to start with null.
      await repo.saveCursor(sourceId, "market", null);
      expect(await repo.loadCursor(sourceId, "market")).toBeNull();
    });

    it("MarketRepository exposes the market-scoped cursor view", async () => {
      if (!pool) return;
      const { db, sourceId } = await freshSource();
      const repo = new MarketRepository(db);
      expect(await repo.loadCursor(sourceId)).toBeNull();
      await repo.saveCursor(sourceId, "page-token");
      expect(await repo.loadCursor(sourceId)).toBe("page-token");
    });
  });
});
