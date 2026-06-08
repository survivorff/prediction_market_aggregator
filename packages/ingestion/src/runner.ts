/**
 * Ingestion runner — the orchestration that turns the pipeline's library
 * functions into a running service (the "resident runner" the docs flag as the
 * one missing piece between the implemented `syncMarkets` / price-stream library
 * and live data).
 *
 * Responsibilities, per registered source:
 * 1. **Resolve the source id.** Upsert the `source` row (idempotent on `key`)
 *    so the adapter's placeholder `meta.id` is replaced by the real internal
 *    UUID (used as the `(source_id, external_id)` idempotency key).
 * 2. **Metadata sync.** Run {@link syncMarkets} through a per-source resilient
 *    fetch wrapper (token-bucket rate limiting + jittered backoff), persisting
 *    markets + outcomes idempotently and advancing the cursor only after a page
 *    is durably written.
 * 3. **Price streams.** Select the currently-active markets (via
 *    {@link classifyTier}), build an external→internal id resolver, and start a
 *    resilient price stream (WebSocket-with-reconnect-backfill where the adapter
 *    supports it, tiered polling otherwise) feeding the {@link onTick} pipeline
 *    (hot cache + idempotent price write + fan-out publish).
 *
 * Everything non-deterministic (clock, sleep, poll/health-check schedulers,
 * rate limiter) is injected via {@link IngestionRunnerDeps}, so the
 * orchestration is unit-testable with fakes and no real network/timers. The
 * executable wiring (real Postgres/Redis/adapters + the periodic loop) lives in
 * {@link file://./main.ts | main.ts}.
 *
 * Requirements: 7.1/7.3 (idempotent sync + cursor-after-durable-write, via
 * `syncMarkets`), 7.5 (resilient fetch), 7.4/7.6/4.4 (tiered streaming +
 * reconnect-backfill), 10.4/9.2 (hot cache + fan-out, via `onTick`), 8.4
 * (registry-driven — adding a platform needs no call-site change here).
 */

import type { Category, Market, MarketSource } from "@pma/core";
import {
  MarketRepository,
  OutcomeRepository,
  mapMarketRow,
  timestampToIso,
  type MarketRow,
  type Queryable,
} from "@pma/storage";
import {
  matchMarket,
  type CalibrationQueue,
  type EmbeddingProvider,
  type MatchLabelStore,
  type MatchMarketOptions,
} from "@pma/matching";
import type { MatchingRepository } from "@pma/core";
import { syncMarkets, type SyncResult } from "./sync-markets.js";
import { createFetchWrapper, type RateLimiter } from "./with-retry.js";
import {
  classifyTier,
  type HotPriceWriter,
  type IdResolver,
  type PricePointWriter,
  type PricePublisher,
  type ResolvedIds,
  type SchedulePolling,
  type TierOptions,
} from "./price-stream.js";
import {
  startResilientPriceStream,
  type ReconnectOptions,
  type ResilientPriceStreamHandle,
  type ScheduleHealthCheck,
} from "./resilient-price-stream.js";

/** Minimal logger seam (defaults to a no-op so the orchestration stays quiet in tests). */
export type RunnerLogger = (message: string, meta?: Record<string, unknown>) => void;

/** Injected dependencies for the ingestion runner. All I/O + timing is here. */
export interface IngestionRunnerDeps {
  /** Postgres handle (pool or transaction) for source/market/outcome reads & writes. */
  db: Queryable;
  /** Idempotent market upserts + the market-sync keyset cursor. */
  marketRepo: MarketRepository;
  /** Idempotent outcome upserts (written alongside each market). */
  outcomeRepo: OutcomeRepository;
  /** Idempotent TimescaleDB price-point append (the `onTick` durable write). */
  pricePointRepo: PricePointWriter;
  /** Redis hot latest-price cache (`onTick` Req 10.4). */
  hotPriceCache: HotPriceWriter;
  /** WebSocket fan-out publisher (`onTick` Req 9.2). */
  fanoutPublisher: PricePublisher;
  /** Shared per-source token-bucket rate limiter for metadata fetches (Req 7.5). */
  rateLimiter: RateLimiter;
  /** Poll scheduler for the non-WebSocket price path (e.g. Manifold/Predict.fun). */
  schedulePolling: SchedulePolling;
  /** Recurring disconnect-check scheduler for the WebSocket reconnect flow. */
  scheduleHealthCheck: ScheduleHealthCheck;
  /** Sleep used for reconnect backoff. */
  sleep: (ms: number) => Promise<void>;
  /** Wall clock (injectable for deterministic tiering/backfill anchoring). */
  now: () => Date;
  /** Tiering thresholds (active vs long-tail). */
  tierOptions?: TierOptions;
  /** Reconnect backoff tuning for the resilient stream. */
  reconnect?: ReconnectOptions;
  /** Optional structured logger. Defaults to a no-op. */
  logger?: RunnerLogger;
}

/** The columns `mapMarketRow` expects, selected for a source's markets. */
const MARKET_COLUMNS = `id, source_id, event_id, canonical_event_id, external_id,
  question, category, status, volume_24h, liquidity, spread,
  resolution_criteria, resolution_mismatch, updated_at`;

/**
 * Upsert a `source` row by its stable `key` and return its internal UUID. This
 * is the {@link import("./registry.js").SourceIdResolver} backing data: the
 * adapter authored only its `key`, and ingestion needs the real id for the
 * `(source_id, external_id)` idempotency key. Idempotent on `key`.
 */
export async function resolveSourceId(db: Queryable, source: MarketSource): Promise<string> {
  const { key, name, type, baseCurrency } = source.meta;
  const result = await db.query<{ id: string }>(
    `INSERT INTO source (key, name, type, base_currency)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [key, name, type, baseCurrency],
  );
  return result.rows[0]!.id;
}

/**
 * Run one metadata-sync pass for a source through a per-source resilient fetch
 * wrapper, persisting markets + outcomes idempotently (Req 7.1/7.3/7.5).
 */
export async function syncSourceMetadata(
  source: MarketSource,
  deps: IngestionRunnerDeps,
): Promise<SyncResult> {
  const fetchWrapper = createFetchWrapper({
    sourceKey: source.meta.key,
    rateLimiter: deps.rateLimiter,
  });
  const result = await syncMarkets(source, deps.marketRepo, {
    fetchWrapper,
    outcomeRepo: deps.outcomeRepo,
  });
  deps.logger?.("metadata sync complete", {
    source: result.sourceKey,
    processed: result.processed,
    pages: result.pages,
  });
  return result;
}

/** A source's active markets plus the external→internal id resolver for `onTick`. */
export interface ActiveMarketSet {
  /** Price-stream ids of currently-active markets (see {@link PriceIdStrategy}). */
  activeIds: string[];
  /** Maps a tick's `(priceId, outcomeLabel)` → internal ids. */
  resolveIds: IdResolver;
}

/**
 * How a source identifies a market on its price endpoints — the id passed to
 * `subscribePrices`/`fetchPriceSnapshot` and echoed back on each tick:
 *
 * - `"marketExternalId"` — the platform-native market id (Manifold contract id,
 *   Predict.fun market id). The default.
 * - `"yesTokenId"` — the Yes outcome's on-chain token id (Polymarket CLOB asset
 *   id): Polymarket keys prices by token, not by its Gamma market id.
 */
export type PriceIdStrategy = "marketExternalId" | "yesTokenId";

/** The canonical Yes-outcome label used when selecting the `yesTokenId`. */
const YES_LABEL = "Yes";

/**
 * Load a source's markets, classify them, and build the {@link ActiveMarketSet}
 * for price streaming: the price-stream ids of currently-active markets plus a
 * resolver from `(priceId, label)` to internal `(marketId, outcomeId)` (built
 * once here so it stays off the per-tick hot path, per the `IdResolver`
 * contract).
 *
 * The `priceIdStrategy` selects which id a source uses on its price endpoints
 * (see {@link PriceIdStrategy}); the resolver is keyed consistently with it so
 * each tick resolves back to the right internal `(marketId, outcomeId)`.
 */
export async function loadActiveMarketSet(
  source: MarketSource,
  deps: IngestionRunnerDeps,
  priceIdStrategy: PriceIdStrategy = "marketExternalId",
): Promise<ActiveMarketSet> {
  const sourceId = source.meta.id;
  const now = deps.now();

  const marketRows = await deps.db.query<MarketRow>(
    `SELECT ${MARKET_COLUMNS} FROM market WHERE source_id = $1`,
    [sourceId],
  );
  const markets: Market[] = marketRows.rows.map(mapMarketRow);
  // Internal ids of the markets that are currently active (classifyTier).
  const activeMarketIds = new Set<string>();
  for (const market of markets) {
    if (classifyTier(market, now, deps.tierOptions) === "active") {
      activeMarketIds.add(market.id);
    }
  }

  // One join to resolve every outcome of the source (market id + token id), so
  // the per-tick resolver and the active-id selection are pure in-memory work.
  const outcomeRows = await deps.db.query<{
    market_id: string;
    market_external_id: string;
    label: string;
    token_id: string | null;
    outcome_id: string;
  }>(
    `SELECT m.id AS market_id, m.external_id AS market_external_id, o.label AS label,
            o.token_id AS token_id, o.id AS outcome_id
       FROM outcome o
       JOIN market m ON m.id = o.market_id
      WHERE m.source_id = $1`,
    [sourceId],
  );

  const idMap = new Map<string, ResolvedIds>();
  const activeIds = new Set<string>();
  for (const row of outcomeRows.rows) {
    const ids: ResolvedIds = { marketId: row.market_id, outcomeId: row.outcome_id };
    // The price id this source echoes on a tick for THIS outcome.
    const priceId = priceIdStrategy === "yesTokenId" ? row.token_id : row.market_external_id;
    if (priceId === null) continue;

    idMap.set(idKey(priceId, row.label), ids);

    // Select the active price ids. For `yesTokenId` only the Yes token is
    // streamed (it carries the implied probability); for `marketExternalId`
    // the market id itself is streamed once.
    if (activeMarketIds.has(row.market_id)) {
      if (priceIdStrategy === "yesTokenId") {
        if (row.label === YES_LABEL) activeIds.add(priceId);
      } else {
        activeIds.add(priceId);
      }
    }
  }

  const resolveIds: IdResolver = (priceId, outcomeLabel) =>
    idMap.get(idKey(priceId, outcomeLabel)) ?? null;

  deps.logger?.("active market set loaded", {
    source: source.meta.key,
    total: markets.length,
    active: activeMarketIds.size,
    streamedIds: activeIds.size,
  });
  return { activeIds: [...activeIds], resolveIds };
}

/**
 * Start a resilient price stream for a source's active markets, wiring the
 * {@link onTick} side-effect pipeline. WebSocket-capable adapters reconnect with
 * backfill; others fall back to tiered polling (Req 7.4/7.6/4.4/10.4/9.2).
 * Returns `null` when the source has no active markets to stream.
 */
export function startSourcePriceStream(
  source: MarketSource,
  active: ActiveMarketSet,
  deps: IngestionRunnerDeps,
): ResilientPriceStreamHandle | null {
  if (active.activeIds.length === 0) return null;
  const handle = startResilientPriceStream(source, active.activeIds, {
    hotPriceCache: deps.hotPriceCache,
    pricePointRepo: deps.pricePointRepo,
    fanoutPublisher: deps.fanoutPublisher,
    resolveIds: active.resolveIds,
    schedulePolling: deps.schedulePolling,
    scheduleHealthCheck: deps.scheduleHealthCheck,
    sleep: deps.sleep,
    now: () => deps.now().toISOString(),
    reconnect: deps.reconnect,
    onError: (error) =>
      deps.logger?.("price tick error", { source: source.meta.key, error: String(error) }),
  });
  deps.logger?.("price stream started", {
    source: source.meta.key,
    mode: handle.mode,
    active: active.activeIds.length,
  });
  return handle;
}

/** Build the `(externalId, label)` map key (NUL-separated to avoid collisions). */
function idKey(marketExternalId: string, outcomeLabel: string): string {
  return `${marketExternalId}\u0000${outcomeLabel}`;
}

// ---------------------------------------------------------------------------
// Matching pass — wires the same-question matching engine into the runner
// ---------------------------------------------------------------------------

/** Injected collaborators for {@link runMatchingPass}. */
export interface MatchingPassDeps {
  /** Postgres handle for loading the markets to match. */
  db: Queryable;
  /** Candidate search + canonical linking (storage-backed `MatchingRepository`). */
  matchingRepo: MatchingRepository;
  /** Provider-agnostic embedding port (Layer 2). Swap in a real model in prod. */
  embeddings: EmbeddingProvider;
  /** Human calibration queue for ambiguous/high-value pairs (Layer 3). */
  calibrationQueue: CalibrationQueue;
  /** Optional labeled-data store (the calibration feedback loop). */
  matchLabels?: MatchLabelStore;
  /** Per-layer matching tuning. */
  matchOptions?: MatchMarketOptions;
  /** Optional structured logger. */
  logger?: RunnerLogger;
}

/** Tally returned by {@link runMatchingPass}. */
export interface MatchingPassResult {
  /** Markets evaluated this pass. */
  evaluated: number;
  /** Pairs auto-confirmed and linked to a canonical event. */
  matched: number;
  /** Of the matched, those flagged with a resolution mismatch. */
  mismatched: number;
  /** Pairs routed to the human calibration queue. */
  queued: number;
}

/**
 * Run one bounded same-question matching pass: take the highest-volume OPEN
 * markets that are **not yet linked** to a canonical event, and run each
 * through {@link matchMarket} (Layer 1–4). Auto-confirmed aligned pairs are
 * linked cross-platform (forming the `CanonicalEvent`s that power the
 * comparison view + spread signals); divergent pairs are linked but flagged;
 * ambiguous/high-value pairs go to the calibration queue.
 *
 * Bounded by `maxMarkets` so a pass stays tractable even with a catalog of tens
 * of thousands of markets (matching every market on every sync is not viable;
 * the highest-volume unlinked markets are the ones most likely to have a
 * cross-platform twin and are matched first).
 *
 * The candidate's `category` (denormalized on the market row) and `endDate`
 * (its owning event) are loaded here to build the Layer-1 `MatchCandidate`.
 */
export async function runMatchingPass(
  deps: MatchingPassDeps,
  maxMarkets: number,
): Promise<MatchingPassResult> {
  const rows = await deps.db.query<MarketRow & { end_date: string | Date | null }>(
    `SELECT m.id, m.source_id, m.event_id, m.canonical_event_id, m.external_id,
            m.question, m.category, m.status, m.volume_24h, m.liquidity, m.spread,
            m.resolution_criteria, m.resolution_mismatch, m.updated_at,
            e.end_date AS end_date
       FROM market m
       LEFT JOIN event e ON e.id = m.event_id
      WHERE m.status = 'open' AND m.canonical_event_id IS NULL
      ORDER BY m.volume_24h DESC NULLS LAST, m.id ASC
      LIMIT $1`,
    [maxMarkets],
  );

  const result: MatchingPassResult = { evaluated: 0, matched: 0, mismatched: 0, queued: 0 };

  for (const row of rows.rows) {
    const market: Market = mapMarketRow(row);
    const candidate = {
      market,
      category: row.category as Category,
      endDate: row.end_date !== null ? timestampToIso(row.end_date) : null,
    };
    result.evaluated += 1;
    try {
      const outcome = await matchMarket(
        candidate,
        {
          repo: deps.matchingRepo,
          embeddings: deps.embeddings,
          queue: deps.calibrationQueue,
          labels: deps.matchLabels,
        },
        deps.matchOptions,
      );
      if (outcome.kind === "Matched") {
        result.matched += 1;
        if (outcome.mismatch) result.mismatched += 1;
      } else if (outcome.kind === "PendingCalibration") {
        result.queued += 1;
      }
    } catch (error) {
      deps.logger?.("match error", { market: market.id, error: String(error) });
    }
  }

  deps.logger?.("matching pass complete", { ...result });
  return result;
}
