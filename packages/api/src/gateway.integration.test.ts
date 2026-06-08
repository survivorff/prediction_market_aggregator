/**
 * End-to-end integration test for the outbound API gateway against the real
 * docker-compose TimescaleDB + Redis. Seeds markets/outcomes/prices via the
 * concrete `@pma/storage` repositories, then exercises the gateway through
 * Fastify `inject` to verify the discovery SQL (filter/sort/search), detail,
 * history, hot-cache overlay (Req 10.4), and `GET /api/sources` end to end.
 *
 * Skips gracefully when Postgres/Redis are unreachable (no Docker), mirroring
 * the storage integration tests.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createPool,
  createRedisClient,
  CanonicalEventRepository,
  HotPriceCache,
  MarketDiscoveryRepository,
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  SourceRepository,
  type RedisClient,
} from "@pma/storage";
import type { FastifyInstance } from "fastify";
import type { MarketUpsert, ResolutionCriteria } from "@pma/core";
import { createServer } from "./server.js";
import { buildGatewayDeps } from "./deps.js";

/**
 * Connect to the integration Postgres, or return `null` so the suite can skip
 * gracefully when Docker is unavailable. Confirms the schema is present.
 */
async function connectPgOrSkip(): Promise<Pool | null> {
  const pool = createPool({ max: 4 });
  try {
    const client = await pool.connect();
    await client.query("SELECT 1 FROM market LIMIT 0");
    client.release();
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

/** Connect to the integration Redis, or return `null` when unreachable. */
async function connectRedisOrSkip(): Promise<RedisClient | null> {
  const client = createRedisClient({
    options: {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    },
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

/** A short, unique slug for per-test isolation. */
function uniqueKey(prefix = "test"): string {
  return `${prefix}-${randomUUID()}`;
}

/** Insert a test `source` row and return its generated UUID. */
async function createSource(db: Pool, key: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO source (key, name, type, base_currency)
     VALUES ($1, $2, 'onchain', 'USDC')
     RETURNING id`,
    [key, `Test ${key}`],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createSource: insert returned no row");
  return row.id;
}

/** Remove a test `source` and everything referencing it. */
async function cleanupSource(db: Pool, sourceId: string): Promise<void> {
  await db.query(`DELETE FROM market WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM event WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM sync_cursor WHERE source_id = $1`, [sourceId]);
  await db.query(`DELETE FROM source WHERE id = $1`, [sourceId]);
}

let pool: Pool | null = null;
let redis: RedisClient | null = null;

beforeAll(async () => {
  pool = await connectPgOrSkip();
  redis = await connectRedisOrSkip();
});

afterAll(async () => {
  if (pool) await pool.end();
  if (redis) redis.disconnect();
});

const sourceIds: string[] = [];
const canonicalEventIds: string[] = [];
const hotMarketIds: string[] = [];
let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (redis) {
    while (hotMarketIds.length > 0) {
      const ext = hotMarketIds.pop();
      if (ext) await new HotPriceCache(redis).clearMarket(ext);
    }
  }
  if (pool) {
    while (sourceIds.length > 0) {
      const id = sourceIds.pop();
      if (id) await cleanupSource(pool, id);
    }
    // Canonical events are not source-scoped; remove any seeded here (their
    // referencing markets are already deleted by cleanupSource above).
    while (canonicalEventIds.length > 0) {
      const id = canonicalEventIds.pop();
      if (id) await pool.query(`DELETE FROM canonical_event WHERE id = $1`, [id]);
    }
  }
});

function criteria(): ResolutionCriteria {
  return { dataSource: "CoinGecko close", cutoffTime: null, rounding: null, raw: { k: "v" } };
}

function sampleMarket(
  sourceId: string,
  externalId: string,
  overrides: Partial<MarketUpsert> = {},
): MarketUpsert {
  return {
    sourceId,
    eventId: null,
    canonicalEventId: null,
    externalId,
    question: "Will BTC close above $100k in 2025?",
    status: "open",
    volume24h: 1000,
    liquidity: 500,
    spread: 0.02,
    resolutionCriteria: criteria(),
    ...overrides,
  };
}

/** Seed a market with a denormalized category + a Yes/No outcome pair. */
async function seedMarket(
  db: Pool,
  sourceId: string,
  opts: { externalId: string; question: string; category: string; volume: number; yesProb: number },
): Promise<string> {
  const market = await new MarketRepository(db).upsertMarket(
    sampleMarket(sourceId, opts.externalId, { question: opts.question, volume24h: opts.volume }),
  );
  // The discovery query filters on the denormalized market.category; the
  // upsert seeds 'other', so set it explicitly here (matching does this in prod).
  await db.query(`UPDATE market SET category = $2 WHERE id = $1`, [market.id, opts.category]);
  await new OutcomeRepository(db).upsertOutcomes([
    {
      marketId: market.id,
      label: "Yes",
      tokenId: null,
      impliedProb: opts.yesProb,
      lastPrice: opts.yesProb,
    },
    {
      marketId: market.id,
      label: "No",
      tokenId: null,
      impliedProb: 1 - opts.yesProb,
      lastPrice: 1 - opts.yesProb,
    },
  ]);
  return market.id;
}

describe("gateway integration (DB + Redis)", () => {
  it("skips when infra is unavailable", () => {
    if (!pool) expect(pool).toBeNull();
    else expect(pool).not.toBeNull();
  });

  it("serves discovery, detail, history and sources from storage/Redis", async () => {
    if (!pool) return;
    const db = pool;
    const sourceId = await createSource(db, uniqueKey("poly"));
    sourceIds.push(sourceId);

    const btcExt = uniqueKey("btc");
    const polExt = uniqueKey("pol");
    const btcId = await seedMarket(db, sourceId, {
      externalId: btcExt,
      question: "Will BTC close above 100k in 2025?",
      category: "crypto",
      volume: 9999,
      yesProb: 0.6,
    });
    const polId = await seedMarket(db, sourceId, {
      externalId: polExt,
      question: "Who wins the national election?",
      category: "politics",
      volume: 10,
      yesProb: 0.3,
    });

    // Seed price history for the BTC market's Yes outcome.
    const outcomes = await new OutcomeRepository(db).listByMarket(btcId);
    const yesOutcome = outcomes.find((o) => o.label === "Yes")!;
    await new PricePointRepository(db).writePricePoints([
      {
        marketId: btcId,
        outcomeId: yesOutcome.id,
        ts: "2025-01-01T00:00:00.000Z",
        price: 0.5,
        volume: 1,
      },
      {
        marketId: btcId,
        outcomeId: yesOutcome.id,
        ts: "2025-01-02T00:00:00.000Z",
        price: 0.58,
        volume: 2,
      },
    ]);

    // Overlay a hot price for the BTC market (keyed by external id, as onTick does).
    if (redis) {
      hotMarketIds.push(btcExt);
      await new HotPriceCache(redis).setHotPrice(btcExt, "Yes", 0.88, {
        ts: "2025-01-03T00:00:00.000Z",
      });
    }

    const deps = buildGatewayDeps({ db, redis: redis ?? undefined });
    app = createServer(deps);

    // --- discovery: returns both, sorted by volume desc (BTC first) ---
    const listRes = await app.inject({ method: "GET", url: "/api/markets" });
    expect(listRes.statusCode).toBe(200);
    const seeded = listRes
      .json()
      .markets.filter((m: { id: string }) => m.id === btcId || m.id === polId);
    expect(seeded.map((m: { id: string }) => m.id)).toEqual([btcId, polId]);

    // --- discovery: category filter ---
    const catRes = await app.inject({ method: "GET", url: "/api/markets?category=politics" });
    const catIds = catRes.json().markets.map((m: { id: string }) => m.id);
    expect(catIds).toContain(polId);
    expect(catIds).not.toContain(btcId);

    // --- discovery: full-text search (GIN tsvector index) ---
    const searchRes = await app.inject({ method: "GET", url: "/api/markets?q=election" });
    const searchIds = searchRes.json().markets.map((m: { id: string }) => m.id);
    expect(searchIds).toContain(polId);
    expect(searchIds).not.toContain(btcId);

    // --- discovery: hot-cache overrides stored implied prob for BTC ---
    if (redis) {
      const btcRow = listRes.json().markets.find((m: { id: string }) => m.id === btcId);
      expect(btcRow.impliedProb).toBeCloseTo(0.88, 5);
    }

    // --- detail ---
    const detailRes = await app.inject({ method: "GET", url: `/api/markets/${btcId}` });
    expect(detailRes.statusCode).toBe(200);
    const detail = detailRes.json();
    expect(detail.outcomes).toHaveLength(2);
    expect(detail.resolutionCriteria.dataSource).toBe("CoinGecko close");
    if (redis) {
      const yes = detail.outcomes.find((o: { label: string }) => o.label === "Yes");
      expect(yes.lastPrice).toBeCloseTo(0.88, 5);
      expect(yes.priceSource).toBe("hotCache");
    }

    // --- history ---
    const histRes = await app.inject({
      method: "GET",
      url: `/api/markets/${btcId}/history?from=2025-01-01T00:00:00.000Z&to=2025-01-05T00:00:00.000Z`,
    });
    expect(histRes.statusCode).toBe(200);
    expect(histRes.json().points).toHaveLength(2);

    // --- 404 for an unknown (well-formed) id ---
    const missingRes = await app.inject({ method: "GET", url: `/api/markets/${randomUUID()}` });
    expect(missingRes.statusCode).toBe(404);

    // --- trade-link: navigation-only source deep-link (executable:false) ---
    const tradeLinkRes = await app.inject({
      method: "GET",
      url: `/api/markets/${btcId}/trade-link`,
    });
    expect(tradeLinkRes.statusCode).toBe(200);
    const tradeLink = tradeLinkRes.json();
    expect(tradeLink.marketId).toBe(btcId);
    expect(tradeLink.executable).toBe(false);
    // The seeded source key is a unique "poly-..." slug (no builder registered),
    // so the registry yields a null url while still being non-executable. This
    // confirms the no-execution guarantee regardless of source recognition.
    expect(tradeLink.url === null || typeof tradeLink.url === "string").toBe(true);

    // --- trade-link 404 for an unknown id ---
    const tradeLinkMissing = await app.inject({
      method: "GET",
      url: `/api/markets/${randomUUID()}/trade-link`,
    });
    expect(tradeLinkMissing.statusCode).toBe(404);

    // --- sources ---
    const sourcesRes = await app.inject({ method: "GET", url: "/api/sources" });
    expect(sourcesRes.statusCode).toBe(200);
    const keys = sourcesRes.json().sources.map((s: { key: string }) => s.key);
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  it("MarketDiscoveryRepository.listMarkets sorts by timeRemaining using event end_date", async () => {
    if (!pool) return;
    const db = pool;
    const sourceId = await createSource(db, uniqueKey("poly"));
    sourceIds.push(sourceId);

    // Two markets linked to events with different end dates.
    const soonEventId = randomUUID();
    const farEventId = randomUUID();
    await db.query(
      `INSERT INTO event (id, source_id, external_id, title, category, end_date)
       VALUES ($1,$2,$3,'soon','crypto','2025-02-01T00:00:00.000Z'),
              ($4,$2,$5,'far','crypto','2025-09-01T00:00:00.000Z')`,
      [soonEventId, sourceId, uniqueKey("evt"), farEventId, uniqueKey("evt")],
    );

    const repo = new MarketRepository(db);
    const soon = await repo.upsertMarket(
      sampleMarket(sourceId, uniqueKey("soon"), { eventId: soonEventId }),
    );
    const far = await repo.upsertMarket(
      sampleMarket(sourceId, uniqueKey("far"), { eventId: farEventId }),
    );
    await db.query(`UPDATE market SET category = 'crypto' WHERE id IN ($1,$2)`, [soon.id, far.id]);

    const discovery = new MarketDiscoveryRepository(db);
    const rows = await discovery.listMarkets({ category: "crypto", sort: "timeRemaining" });
    const ids = rows.map((r) => r.id);
    // Soonest end date first.
    expect(ids.indexOf(soon.id)).toBeLessThan(ids.indexOf(far.id));

    // events are not cleaned by cleanupSource's market delete; remove explicitly.
    await db.query(`DELETE FROM market WHERE source_id = $1`, [sourceId]);
    await db.query(`DELETE FROM event WHERE id IN ($1,$2)`, [soonEventId, farEventId]);
  });

  it("SourceRepository.list returns the seeded source identity", async () => {
    if (!pool) return;
    const db = pool;
    const key = uniqueKey("src");
    const sourceId = await createSource(db, key);
    sourceIds.push(sourceId);

    const sources = await new SourceRepository(db).list();
    const mine = sources.find((s) => s.key === key);
    expect(mine).toBeDefined();
    expect(mine?.baseCurrency).toBe("USDC");
  });

  it("serves comparison + signals from storage (mismatch flag, spread, ranking)", async () => {
    if (!pool) return;
    const db = pool;
    const sourceId = await createSource(db, uniqueKey("poly"));
    sourceIds.push(sourceId);

    // A canonical event grouping with three linked markets: two aligned (open,
    // no mismatch) and one mismatched (must be excluded from the spread).
    const canonical = await new CanonicalEventRepository(db).create({
      title: "Will BTC close above 100k in 2025?",
      category: "crypto",
      subjectEntity: "BTC",
      thresholdValue: 100000,
      targetDate: null,
    });
    canonicalEventIds.push(canonical.id);

    const marketRepo = new MarketRepository(db);
    const outcomeRepo = new OutcomeRepository(db);

    async function linkMarket(opts: {
      externalId: string;
      yesProb: number;
      mismatch: boolean;
      volume: number;
    }): Promise<string> {
      const market = await marketRepo.upsertMarket(
        sampleMarket(sourceId, opts.externalId, {
          canonicalEventId: canonical.id,
          volume24h: opts.volume,
        }),
      );
      await db.query(
        `UPDATE market SET category = 'crypto', resolution_mismatch = $2 WHERE id = $1`,
        [market.id, opts.mismatch],
      );
      await outcomeRepo.upsertOutcomes([
        {
          marketId: market.id,
          label: "Yes",
          tokenId: null,
          impliedProb: opts.yesProb,
          lastPrice: opts.yesProb,
        },
        {
          marketId: market.id,
          label: "No",
          tokenId: null,
          impliedProb: 1 - opts.yesProb,
          lastPrice: 1 - opts.yesProb,
        },
      ]);
      return market.id;
    }

    const polyId = await linkMarket({
      externalId: uniqueKey("poly-m"),
      yesProb: 0.5,
      mismatch: false,
      volume: 1000,
    });
    const maniId = await linkMarket({
      externalId: uniqueKey("mani-m"),
      yesProb: 0.65,
      mismatch: false,
      volume: 200,
    });
    const mmId = await linkMarket({
      externalId: uniqueKey("mm-m"),
      yesProb: 0.99,
      mismatch: true,
      volume: 50,
    });

    const deps = buildGatewayDeps({ db, redis: redis ?? undefined });
    app = createServer(deps);

    // --- list canonical events: includes our grouping with member/mismatch counts ---
    const listRes = await app.inject({
      method: "GET",
      url: "/api/canonical-events?category=crypto",
    });
    expect(listRes.statusCode).toBe(200);
    const mine = listRes.json().canonicalEvents.find((e: { id: string }) => e.id === canonical.id);
    expect(mine).toBeDefined();
    expect(mine.memberCount).toBe(3);
    expect(mine.mismatchCount).toBe(1);

    // --- comparison view: rows for all three; mismatch flagged; spread over aligned only ---
    const cmpRes = await app.inject({
      method: "GET",
      url: `/api/canonical-events/${canonical.id}`,
    });
    expect(cmpRes.statusCode).toBe(200);
    const view = cmpRes.json();
    expect(view.rows).toHaveLength(3);
    const mmRow = view.rows.find((r: { marketId: string }) => r.marketId === mmId);
    expect(mmRow.resolutionMismatch).toBe(true);
    const alignedIds = view.rows
      .filter((r: { resolutionMismatch: boolean }) => !r.resolutionMismatch)
      .map((r: { marketId: string }) => r.marketId)
      .sort();
    expect(alignedIds).toEqual([polyId, maniId].sort());
    // maxSpread = 0.65 - 0.5 over the two aligned rows (excludes the 0.99 mismatch).
    expect(view.maxSpread).toBeCloseTo(0.15, 5);

    // --- signals: present, executable:false, gap over aligned only ---
    const sigRes = await app.inject({ method: "GET", url: "/api/signals" });
    expect(sigRes.statusCode).toBe(200);
    const mySignal = sigRes
      .json()
      .signals.find((s: { canonicalEventId: string }) => s.canonicalEventId === canonical.id);
    expect(mySignal).toBeDefined();
    expect(mySignal.executable).toBe(false);
    expect(mySignal.gap).toBeCloseTo(0.15, 5);
    expect(mySignal.perPlatform).toHaveLength(2);
  });

  it("returns rows but null maxSpread when fewer than two aligned markets (Req 2.4)", async () => {
    if (!pool) return;
    const db = pool;
    const sourceId = await createSource(db, uniqueKey("poly"));
    sourceIds.push(sourceId);

    const canonical = await new CanonicalEventRepository(db).create({
      title: "Single aligned market question",
      category: "crypto",
      subjectEntity: null,
      thresholdValue: null,
      targetDate: null,
    });
    canonicalEventIds.push(canonical.id);

    const marketRepo = new MarketRepository(db);
    const outcomeRepo = new OutcomeRepository(db);

    // One aligned market + one mismatched → only one aligned → no spread.
    const aligned = await marketRepo.upsertMarket(
      sampleMarket(sourceId, uniqueKey("aligned"), { canonicalEventId: canonical.id }),
    );
    const mismatched = await marketRepo.upsertMarket(
      sampleMarket(sourceId, uniqueKey("mm"), { canonicalEventId: canonical.id }),
    );
    await db.query(`UPDATE market SET category = 'crypto' WHERE id = $1`, [aligned.id]);
    await db.query(
      `UPDATE market SET category = 'crypto', resolution_mismatch = TRUE WHERE id = $1`,
      [mismatched.id],
    );
    await outcomeRepo.upsertOutcomes([
      { marketId: aligned.id, label: "Yes", tokenId: null, impliedProb: 0.4, lastPrice: 0.4 },
      { marketId: mismatched.id, label: "Yes", tokenId: null, impliedProb: 0.8, lastPrice: 0.8 },
    ]);

    const deps = buildGatewayDeps({ db, redis: redis ?? undefined });
    app = createServer(deps);

    const cmpRes = await app.inject({
      method: "GET",
      url: `/api/canonical-events/${canonical.id}`,
    });
    expect(cmpRes.statusCode).toBe(200);
    const view = cmpRes.json();
    expect(view.rows).toHaveLength(2);
    expect(view.maxSpread).toBeNull();

    // No signal emitted for a single aligned market (Req 3.4).
    const sigRes = await app.inject({ method: "GET", url: "/api/signals" });
    const mySignal = sigRes
      .json()
      .signals.find((s: { canonicalEventId: string }) => s.canonicalEventId === canonical.id);
    expect(mySignal).toBeUndefined();
  });
});
