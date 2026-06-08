/**
 * @pma/storage — Postgres/TimescaleDB repositories, Redis hot cache, migrations.
 *
 * Holds relational metadata (Postgres), the price_point hypertable (TimescaleDB),
 * and the hot latest-price cache + pub/sub (Redis). Repositories implement the
 * port interfaces from @pma/core with idempotent ON CONFLICT upserts keyed on
 * `(source_id, external_id)` and `(market_id, outcome_id, ts)` (Requirements
 * 7.1, 7.2, 10.1, 10.2).
 */

export const STORAGE_PACKAGE = "@pma/storage" as const;

// Postgres connection pool wrapper + transaction helper.
export { DEFAULT_DATABASE_URL, resolveDatabaseUrl, createPool, withTransaction } from "./client.js";
export type { Queryable, CreatePoolOptions } from "./client.js";

// Row <-> domain mapping helpers (NUMERIC/TIMESTAMPTZ/JSONB conversions).
export {
  numericToNumber,
  requiredNumber,
  timestampToIso,
  requiredTimestampToIso,
  mapResolutionCriteria,
  serializeResolutionCriteria,
  mapMarketRow,
  mapOutcomeRow,
  mapPricePointRow,
  mapCanonicalEventRow,
  mapWatchlistItemRow,
  mapAlertRuleRow,
  mapAlertRuleParams,
} from "./mappers.js";
export type {
  MarketRow,
  OutcomeRow,
  PricePointRow,
  CanonicalEventRow,
  WatchlistItemRow,
  AlertRuleRow,
} from "./mappers.js";

// Concrete repository implementations of the @pma/core ports.
export {
  CursorRepository,
  loadCursorRow,
  saveCursorRow,
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  CanonicalEventRepository,
  MarketDiscoveryRepository,
  SourceRepository,
  WatchlistRepository,
  AlertRuleRepository,
  MatchingRepository,
} from "./repositories/index.js";
export type {
  MarketSortKey,
  SortOrder,
  MarketDiscoveryFilter,
  MarketSummaryRow,
  MarketDetailRow,
  SourceRecord,
  CanonicalEventFilter,
  CanonicalEventSummaryRow,
  CanonicalComparisonMemberRow,
} from "./repositories/index.js";

// Redis layer: hot latest-price cache (Req 10.4) + pub/sub fan-out (Req 9.2).
export {
  DEFAULT_REDIS_URL,
  resolveRedisUrl,
  createRedisClient,
  CHANNEL_PREFIX,
  ALERTS_CHANNEL,
  marketChannel,
  canonicalChannel,
  alertsChannel,
  parseChannel,
  HotPriceCache,
  hotPriceKey,
  DEFAULT_HOT_PRICE_TTL_MS,
  FanoutPublisher,
  FanoutSubscriber,
} from "./redis/index.js";
export type {
  RedisClient,
  CreateRedisClientOptions,
  ChannelKind,
  MessageType,
  ParsedChannel,
  FanoutMessage,
  PriceMessage,
  SpreadMessage,
  PricePayload,
  SpreadPayload,
  HotPrice,
  SetHotPriceOptions,
  HotPriceCacheOptions,
  MessageHandler,
  ChannelSubscription,
} from "./redis/index.js";
