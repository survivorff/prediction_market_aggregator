/**
 * @pma/ingestion — Orchestrator, schedulers, pollers, WS managers, upsert writers.
 *
 * Drives metadata sync (keyset pagination + idempotent upsert) and price
 * streaming (WebSocket for active markets, tiered polling for long-tail), with
 * rate limiting, exponential backoff, and reconnect-with-backfill.
 *
 * syncMarkets, withRetry, and price stream management are implemented in task 5.
 */

export const INGESTION_PACKAGE = "@pma/ingestion" as const;

// Adapter registry: the pipeline's registered-source registry (Requirement 8.4).
export { InMemoryAdapterRegistry, DuplicateSourceError } from "./registry.js";
export type { AdapterRegistry, SourceIdResolver } from "./registry.js";

// Capability gating: the price-stream WebSocket-vs-polling decision seam
// (design P7 / Requirements 7.4, 8.1, 8.3). Task 5.3 builds the fuller stream
// management on top of this.
export { managePriceStream, canStreamPrices } from "./capability-gating.js";
export type { PriceStreamMode, PriceStreamDeps, PriceStreamDecision } from "./capability-gating.js";

// Price tiering + stream management: `classifyTier` (active vs long-tail), the
// `onTick` side-effect pipeline (hot cache + idempotent price write + fan-out),
// and `startPriceStream` (WebSocket-vs-polling routing via the capability gate).
// Reuses `canStreamPrices` above; reconnect-with-backfill lands in task 5.4
// (design "Price tiering + WebSocket reconnect with backfill" / Requirements
// 7.4, 10.4, 9.2).
export {
  classifyTier,
  onTick,
  startPriceStream,
  DEFAULT_ACTIVE_WINDOW_MS,
  DEFAULT_VOLUME_THRESHOLD,
} from "./price-stream.js";
export type {
  MarketTier,
  TierOptions,
  ResolvedIds,
  IdResolver,
  HotPriceWriter,
  PricePointWriter,
  PricePublisher,
  OnTickDeps,
  OnTickResult,
  StopPolling,
  SchedulePolling,
  StartPriceStreamDeps,
  PriceStreamHandle,
} from "./price-stream.js";

// WebSocket reconnect-with-backfill: layers resilience onto `startPriceStream`
// — on a WS drop (observed via `subscription.isOpen`) it reconnects with
// jittered exponential backoff and backfills the missed interval via
// `fetchPriceHistory`, writing each gap point through the idempotent `onTick`
// path so curves have no holes (design `managePriceStream` `ON disconnect` /
// Requirements 7.6, 4.4). The polling path delegates to `startPriceStream`.
export {
  startResilientPriceStream,
  MaxReconnectsExceeded,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_BASE_DELAY_MS,
  DEFAULT_RECONNECT_MAX_DELAY_MS,
} from "./resilient-price-stream.js";
export type {
  ReconnectOptions,
  ScheduleHealthCheck,
  ResilientStreamDeps,
  ResilientPriceStreamHandle,
} from "./resilient-price-stream.js";

// Metadata incremental sync: keyset pagination + idempotent upsert with the
// cursor-after-durable-write invariant (design "Metadata incremental sync" /
// Requirements 7.1, 7.3, 11.1). The per-page fetch goes through an injectable
// seam so task 5.2's `withRetry` plugs in unchanged.
export { syncMarkets, normalizeAndValidate, DEFAULT_PAGE_SIZE } from "./sync-markets.js";
export type {
  SyncResult,
  SyncMarketsOptions,
  FetchWrapper,
  EnqueueForMatching,
  NormalizedMarketEntity,
} from "./sync-markets.js";

// Resilient fetch wrapper: per-source token-bucket rate limiting + jittered
// exponential backoff (design "Resilient fetch wrapper" / Requirement 7.5).
// `createFetchWrapper` produces a `FetchWrapper` that drops straight into
// `syncMarkets({ fetchWrapper })`.
export {
  withRetry,
  createFetchWrapper,
  TokenBucketRateLimiter,
  HttpError,
  MaxRetriesExceeded,
  defaultIsRetryable,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
} from "./with-retry.js";
export type {
  RetryOptions,
  RateLimiter,
  TokenBucketOptions,
  StatusCarryingError,
  CreateFetchWrapperOptions,
} from "./with-retry.js";

// Ingestion runner: the orchestration that turns the library functions above
// into a running service — resolve source ids, sync metadata through a
// resilient fetch wrapper, select active markets, and start resilient price
// streams. The executable wiring (real infra + periodic loop) lives in main.ts.
export {
  resolveSourceId,
  syncSourceMetadata,
  loadActiveMarketSet,
  startSourcePriceStream,
  runMatchingPass,
} from "./runner.js";
export type {
  IngestionRunnerDeps,
  ActiveMarketSet,
  PriceIdStrategy,
  RunnerLogger,
  MatchingPassDeps,
  MatchingPassResult,
} from "./runner.js";
