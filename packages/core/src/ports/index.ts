/**
 * Port interfaces — the boundaries between the pure core domain and the
 * replaceable edges (adapters) and infrastructure (storage). All declarations
 * here are I/O-free contracts; implementations live in `adapters/*` and
 * `packages/storage` (see design.md "Layered Architecture").
 *
 * Requirements: 8.2 (MarketSource adapter contract + capabilities), 10.1
 * (normalized model persistence shapes).
 */

// The MarketSource adapter port and its supporting normalized payload types.
export type {
  SourceMeta,
  SourceCapabilities,
  PageRequest,
  Page,
  TimeRange,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedOutcome,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  PriceTickHandler,
  Subscription,
  MarketSource,
} from "./market-source.js";

// Repository (persistence) ports referenced by the ingestion/matching algorithms.
export type {
  CursorEntity,
  MarketUpsert,
  OutcomeUpsert,
  CanonicalEventInput,
  LinkedMarket,
  CursorRepository,
  MarketRepository,
  OutcomeRepository,
  PricePointRepository,
  CanonicalEventRepository,
  TimeWindow,
  CandidateQuery,
  CanonicalLinkOptions,
  MatchingRepository,
  WatchlistItemInput,
  WatchlistRepository,
  AlertRuleInput,
  AlertRuleRepository,
} from "./repositories.js";
