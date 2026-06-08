/**
 * Runnable entrypoint for the ingestion runner.
 *
 * Wires the real adapters (Polymarket, Manifold, Predict.fun) + a live
 * Postgres pool and Redis client into the {@link file://./runner.ts | runner}
 * orchestration, then drives a periodic loop: every `INGEST_INTERVAL_MS` it runs
 * a metadata sync for each source and (re)starts its price streams. This is the
 * production/dev bootstrap; the orchestration itself is unit-tested with fakes.
 *
 * Adding a platform is a one-liner here (`registry.register(new XAdapter())`)
 * with no other change (Requirement 8.4).
 *
 * Env:
 *   DATABASE_URL          Postgres (default postgres://pma:pma@localhost:5432/pma)
 *   REDIS_URL             Redis (default redis://localhost:6379)
 *   INGEST_INTERVAL_MS    metadata re-sync cadence (default 60000)
 *   POLL_INTERVAL_MS      price-poll cadence for non-WS sources (default 15000)
 *   HEALTH_INTERVAL_MS    WS disconnect-check cadence (default 5000)
 *   PREDICTFUN_API_KEY    Predict.fun mainnet key; when unset, the public
 *                         testnet base URL is used (no key required).
 *
 * The runner is strictly read-only — it never touches any order-placement
 * endpoint (Requirement 12.1).
 */

import {
  ManifoldAdapter,
  PolymarketAdapter,
  PredictFunAdapter,
  PREDICTFUN_TESTNET_BASE_URL,
  type FetchLike,
  type WebSocketFactory,
  type WebSocketLike,
} from "@pma/adapters";
import {
  createPool,
  createRedisClient,
  FanoutPublisher,
  HotPriceCache,
  MarketRepository,
  MatchingRepository,
  OutcomeRepository,
  PricePointRepository,
  type RedisClient,
} from "@pma/storage";
import {
  BagOfWordsEmbeddingProvider,
  InMemoryCalibrationQueue,
  InMemoryMatchLabelStore,
} from "@pma/matching";
import type { MarketSource } from "@pma/core";
import { InMemoryAdapterRegistry } from "./registry.js";
import { TokenBucketRateLimiter } from "./with-retry.js";
import {
  loadActiveMarketSet,
  resolveSourceId,
  runMatchingPass,
  startSourcePriceStream,
  syncSourceMetadata,
  type IngestionRunnerDeps,
  type MatchingPassDeps,
  type PriceIdStrategy,
} from "./runner.js";
import type { ResilientPriceStreamHandle } from "./resilient-price-stream.js";

const log = (message: string, meta?: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console
  console.log(`[ingest] ${message}`, meta ? JSON.stringify(meta) : "");
};

/**
 * Wrap global `fetch` with a per-request timeout so an unreachable upstream
 * fails fast (AbortError) instead of hanging the sync loop forever. A
 * caller-supplied `signal` takes precedence. Structurally a {@link FetchLike}.
 */
function timeoutFetch(timeoutMs: number): FetchLike {
  return (input, init) =>
    fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    }) as ReturnType<FetchLike>;
}

/**
 * A {@link WebSocketFactory} over Node's global `WebSocket` (Node ≥ 21), wrapped
 * to the adapter's minimal {@link WebSocketLike} surface. Used by the WebSocket-
 * capable Polymarket adapter; the polling adapters never call it.
 */
function nodeWebSocketFactory(): WebSocketFactory {
  return (url: string): WebSocketLike => {
    const ws = new WebSocket(url);
    return {
      addEventListener: (type, listener) =>
        ws.addEventListener(type, listener as (ev: Event) => void),
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    };
  };
}

/** Per-source price-id strategy: Polymarket keys prices by CLOB token, others by market id. */
const PRICE_ID_STRATEGY: Record<string, PriceIdStrategy> = {
  polymarket: "yesTokenId",
  manifold: "marketExternalId",
  predictfun: "marketExternalId",
};

/** Build the configured adapters. Predict.fun uses the public testnet unless a mainnet key is set. */
function buildAdapters(fetchImpl: FetchLike, webSocketFactory: WebSocketFactory): MarketSource[] {
  const predictApiKey = process.env.PREDICTFUN_API_KEY;
  const predictfun =
    predictApiKey !== undefined && predictApiKey !== ""
      ? new PredictFunAdapter({ apiKey: predictApiKey, fetchImpl })
      : new PredictFunAdapter({ baseUrl: PREDICTFUN_TESTNET_BASE_URL, fetchImpl });
  return [
    new PolymarketAdapter({ fetchImpl, webSocketFactory }),
    new ManifoldAdapter({ fetchImpl }),
    predictfun,
  ];
}

async function main(): Promise<void> {
  const ingestIntervalMs = Number(process.env.INGEST_INTERVAL_MS ?? 60_000);
  const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
  const healthIntervalMs = Number(process.env.HEALTH_INTERVAL_MS ?? 5_000);
  const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? 10_000);
  const matchMaxMarkets = Number(process.env.MATCH_MAX_MARKETS ?? 300);

  const pool = createPool();
  const redis: RedisClient = createRedisClient();
  await redis.ping();

  // Resolve each source's internal UUID up front (synchronous registry seam),
  // then register the adapters so their meta.id carries the real id.
  const adapters = buildAdapters(timeoutFetch(requestTimeoutMs), nodeWebSocketFactory());
  const idByKey = new Map<string, string>();
  for (const adapter of adapters) {
    idByKey.set(adapter.meta.key, await resolveSourceId(pool, adapter));
  }
  const registry = new InMemoryAdapterRegistry((meta) => {
    const id = idByKey.get(meta.key);
    if (id === undefined) throw new Error(`No resolved source id for "${meta.key}"`);
    return id;
  });
  for (const adapter of adapters) registry.register(adapter);

  const deps: IngestionRunnerDeps = {
    db: pool,
    marketRepo: new MarketRepository(pool),
    outcomeRepo: new OutcomeRepository(pool),
    pricePointRepo: new PricePointRepository(pool),
    hotPriceCache: new HotPriceCache(redis),
    fanoutPublisher: new FanoutPublisher(redis),
    rateLimiter: new TokenBucketRateLimiter({ capacity: 5, refillPerSecond: 5 }),
    schedulePolling: (poll) => {
      const timer = setInterval(() => void poll().catch((e) => log("poll error", { error: String(e) })), pollIntervalMs);
      void poll().catch((e) => log("poll error", { error: String(e) }));
      return () => clearInterval(timer);
    },
    scheduleHealthCheck: (check) => {
      const timer = setInterval(check, healthIntervalMs);
      return () => clearInterval(timer);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    logger: log,
  };

  // Same-question matching collaborators. The embedding provider is the
  // deterministic offline bag-of-words model for v1 — swap in a real model
  // (hosted or local) behind the EmbeddingProvider port for production-quality
  // matching. The calibration queue + label store are in-memory for v1
  // (auto-confirmed links persist directly; only ambiguous pairs queue).
  const matchingDeps: MatchingPassDeps = {
    db: pool,
    matchingRepo: new MatchingRepository(pool),
    embeddings: new BagOfWordsEmbeddingProvider(),
    calibrationQueue: new InMemoryCalibrationQueue(),
    matchLabels: new InMemoryMatchLabelStore(),
    logger: log,
  };

  // One live price-stream handle per source; replaced each cycle as the active
  // set changes.
  const streams = new Map<string, ResilientPriceStreamHandle>();

  // Sync + (re)stream one source. Isolated per source so a slow/failing source
  // never blocks the others.
  const runSource = async (source: MarketSource): Promise<void> => {
    try {
      await syncSourceMetadata(source, deps);
      const strategy = PRICE_ID_STRATEGY[source.meta.key] ?? "marketExternalId";
      const active = await loadActiveMarketSet(source, deps, strategy);
      // Replace the previous stream (active set may have changed).
      streams.get(source.meta.key)?.stop();
      const handle = startSourcePriceStream(source, active, deps);
      if (handle) streams.set(source.meta.key, handle);
      else streams.delete(source.meta.key);
    } catch (error) {
      log("source cycle failed", { source: source.meta.key, error: String(error) });
    }
  };

  // Run every source concurrently: a long sync (e.g. Manifold's tens of
  // thousands of markets) must not starve the others (e.g. Predict.fun).
  const runCycle = async (): Promise<void> => {
    await Promise.allSettled(registry.all().map((source) => runSource(source)));
    // After metadata is refreshed across all sources, run a bounded
    // same-question matching pass so live data forms cross-platform canonical
    // events (the comparison view + spread signals).
    try {
      await runMatchingPass(matchingDeps, matchMaxMarkets);
    } catch (error) {
      log("matching pass failed", { error: String(error) });
    }
  };

  log("ingestion runner started", {
    sources: registry.all().map((s) => s.meta.key),
    ingestIntervalMs,
    pollIntervalMs,
    requestTimeoutMs,
    matchMaxMarkets,
  });

  // Run the first cycle without blocking startup, then on a fixed cadence.
  await runCycle();
  const loop = setInterval(() => void runCycle(), ingestIntervalMs);

  const shutdown = async (signal: string): Promise<void> => {
    log(`${signal} received — shutting down`);
    clearInterval(loop);
    for (const handle of streams.values()) handle.stop();
    await pool.end().catch(() => undefined);
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[ingest] failed to start:", err);
  process.exit(1);
});
