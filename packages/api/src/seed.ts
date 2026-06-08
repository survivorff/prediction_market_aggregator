/**
 * Demo seed script — populates the database with a small, illustrative dataset
 * so the gateway has something to serve in a local demo (the real adapters
 * cannot reach upstream platforms from a sandbox).
 *
 * It writes three sources (Polymarket, Manifold, Predict.fun), a shared
 * CanonicalEvent linking a "BTC > $100k" market on each platform (so the
 * comparison view shows a 3-way spread + a signal), a couple of standalone
 * markets, outcomes, and a little price history. Everything goes through the
 * real `@pma/storage` repositories, so the seeded shapes match what ingestion
 * would produce.
 *
 * Idempotent: re-running upserts the same rows (no duplicates). Run with:
 *   npm run seed --workspace @pma/api
 */

import { randomUUID } from "node:crypto";
import {
  createPool,
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  type Queryable,
} from "@pma/storage";
import type { MarketUpsert, ResolutionCriteria } from "@pma/core";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

function criteria(dataSource: string, cutoff: string): ResolutionCriteria {
  return { dataSource, cutoffTime: cutoff, rounding: "nearest", raw: { dataSource } };
}

/** Upsert a source by key; returns its id. */
async function upsertSource(
  db: Queryable,
  key: string,
  name: string,
  type: string,
  baseCurrency: string,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO source (key, name, type, base_currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [key, name, type, baseCurrency],
  );
  return res.rows[0]!.id;
}

/** Upsert a canonical event with a fixed id so re-seeding is idempotent. */
async function upsertCanonical(
  db: Queryable,
  id: string,
  title: string,
  category: string,
  subjectEntity: string,
  threshold: number,
): Promise<string> {
  await db.query(
    `INSERT INTO canonical_event (id, title, category, subject_entity, threshold_value, target_date)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title`,
    [id, title, category, subjectEntity, threshold, new Date(NOW + 90 * DAY).toISOString()],
  );
  return id;
}

/** Upsert an event (so a market can have an end_date / time-remaining). */
async function upsertEvent(
  db: Queryable,
  sourceId: string,
  externalId: string,
  title: string,
  category: string,
  endDate: string,
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO event (source_id, external_id, title, category, end_date)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_id, external_id) DO UPDATE SET title = EXCLUDED.title, end_date = EXCLUDED.end_date
     RETURNING id`,
    [sourceId, externalId, title, category, endDate],
  );
  return res.rows[0]!.id;
}

interface SeedMarket {
  sourceId: string;
  externalId: string;
  question: string;
  category: string;
  status: "open" | "closed" | "resolved";
  volume24h: number | null;
  liquidity: number | null;
  spread: number | null;
  eventId: string | null;
  canonicalEventId: string | null;
  resolutionMismatch: boolean;
  yesProb: number;
  criteria: ResolutionCriteria;
}

/** Upsert a market + its denormalized category + mismatch flag + Yes/No outcomes. */
async function seedMarket(db: Queryable, m: SeedMarket): Promise<string> {
  const upsert: MarketUpsert = {
    sourceId: m.sourceId,
    eventId: m.eventId,
    canonicalEventId: m.canonicalEventId,
    externalId: m.externalId,
    question: m.question,
    status: m.status,
    volume24h: m.volume24h,
    liquidity: m.liquidity,
    spread: m.spread,
    resolutionCriteria: m.criteria,
  };
  const market = await new MarketRepository(db).upsertMarket(upsert);
  // The MarketRepository intentionally never clobbers the denormalized
  // category / canonical link / mismatch flag, so set them explicitly here
  // (in production these are set by event sync + the matching engine).
  await db.query(
    `UPDATE market
       SET category = $2, canonical_event_id = $3, resolution_mismatch = $4
     WHERE id = $1`,
    [market.id, m.category, m.canonicalEventId, m.resolutionMismatch],
  );
  await new OutcomeRepository(db).upsertOutcomes([
    { marketId: market.id, label: "Yes", tokenId: null, impliedProb: m.yesProb, lastPrice: m.yesProb },
    { marketId: market.id, label: "No", tokenId: null, impliedProb: 1 - m.yesProb, lastPrice: 1 - m.yesProb },
  ]);
  return market.id;
}

/** Write a simple ascending Yes-price history for a market. */
async function seedHistory(db: Queryable, marketId: string, end: number): Promise<void> {
  const outcomes = await new OutcomeRepository(db).listByMarket(marketId);
  const yes = outcomes.find((o) => o.label === "Yes");
  if (!yes) return;
  const repo = new PricePointRepository(db);
  const points = Array.from({ length: 8 }, (_, i) => ({
    marketId,
    outcomeId: yes.id,
    ts: new Date(end - (7 - i) * DAY).toISOString(),
    price: 0.3 + i * 0.02,
    volume: 100 + i * 10,
  }));
  await repo.writePricePoints(points);
}

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const polymarket = await upsertSource(pool, "polymarket", "Polymarket", "onchain", "USDC");
    const manifold = await upsertSource(pool, "manifold", "Manifold", "onchain", "MANA");
    const predictfun = await upsertSource(pool, "predictfun", "Predict.fun", "onchain", "USDB");

    // Canonical event: "Will BTC close above $100k in 2025?" linked on both platforms.
    const canon = await upsertCanonical(
      pool,
      "11111111-1111-1111-1111-111111111111",
      "Will BTC close above $100,000 in 2025?",
      "crypto",
      "BTC",
      100000,
    );

    const end = NOW + 90 * DAY;
    const polyEvent = await upsertEvent(pool, polymarket, "evt-btc-100k", "BTC 2025", "crypto", new Date(end).toISOString());
    const maniEvent = await upsertEvent(pool, manifold, "evt-btc-100k", "BTC 2025", "crypto", new Date(end).toISOString());
    const predEvent = await upsertEvent(pool, predictfun, "btc-100k-2025", "BTC 2025", "crypto", new Date(end).toISOString());

    const polyBtc = await seedMarket(pool, {
      sourceId: polymarket,
      externalId: "poly-btc-100k",
      question: "Will BTC close above $100,000 in 2025?",
      category: "crypto",
      status: "open",
      volume24h: 152340.55,
      liquidity: 84210,
      spread: 0.02,
      eventId: polyEvent,
      canonicalEventId: canon,
      resolutionMismatch: false,
      yesProb: 0.45,
      criteria: criteria("Coinbase BTC-USD close", new Date(end).toISOString()),
    });
    const maniBtc = await seedMarket(pool, {
      sourceId: manifold,
      externalId: "mani-btc-100k",
      question: "Will Bitcoin reach $100k by end of 2025?",
      category: "crypto",
      status: "open",
      volume24h: 3120.5,
      liquidity: 2854.7,
      spread: null,
      eventId: maniEvent,
      canonicalEventId: canon,
      resolutionMismatch: false,
      yesProb: 0.62,
      criteria: criteria("Coinbase BTC-USD close", new Date(end).toISOString()),
    });

    // Predict.fun (BNB Chain) — the third venue on the same canonical event, so
    // the comparison view shows a 3-way cross-platform spread. Its Yes implied
    // probability is the order-book mid the adapter would compute live.
    const predBtc = await seedMarket(pool, {
      sourceId: predictfun,
      externalId: "472",
      question: "Will BTC close above $100,000 in 2025?",
      category: "crypto",
      status: "open",
      volume24h: 58200.25,
      liquidity: 31040,
      spread: 0.04,
      eventId: predEvent,
      canonicalEventId: canon,
      resolutionMismatch: false,
      yesProb: 0.6,
      criteria: criteria("Chainlink BTC/USD close", new Date(end).toISOString()),
    });

    // A couple of standalone markets so discovery has variety.
    await seedMarket(pool, {
      sourceId: polymarket,
      externalId: "poly-election",
      question: "Who wins the 2028 US presidential election?",
      category: "politics",
      status: "open",
      volume24h: 982000,
      liquidity: 410000,
      spread: 0.03,
      eventId: null,
      canonicalEventId: null,
      resolutionMismatch: false,
      yesProb: 0.51,
      criteria: criteria("AP race call", new Date(NOW + 365 * DAY).toISOString()),
    });
    await seedMarket(pool, {
      sourceId: manifold,
      externalId: "mani-agi",
      question: "Will an AI model pass a hard reasoning benchmark in 2025?",
      category: "tech",
      status: "open",
      volume24h: null,
      liquidity: 5400,
      spread: null,
      eventId: null,
      canonicalEventId: null,
      resolutionMismatch: false,
      yesProb: 0.37,
      criteria: criteria("Creator resolution", new Date(NOW + 200 * DAY).toISOString()),
    });

    await seedHistory(pool, polyBtc, NOW);
    await seedHistory(pool, maniBtc, NOW);
    await seedHistory(pool, predBtc, NOW);

    // eslint-disable-next-line no-console
    console.log("[seed] done:", {
      sources: ["polymarket", "manifold", "predictfun"],
      canonicalEvent: canon,
      markets: ["poly-btc-100k", "mani-btc-100k", "472", "poly-election", "mani-agi"],
      runId: randomUUID(),
    });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[seed] failed:", err);
  process.exit(1);
});
