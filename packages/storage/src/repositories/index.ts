/**
 * Concrete Postgres/TimescaleDB repository implementations of the `@pma/core`
 * persistence ports. Each is constructed with a {@link Queryable} (a pooled
 * client or a transaction-scoped client) and performs idempotent
 * `ON CONFLICT ... DO UPDATE` upserts (Requirements 7.1, 7.2, 10.1, 10.2).
 */

export { CursorRepository, loadCursorRow, saveCursorRow } from "./cursor-repository.js";
export { MarketRepository } from "./market-repository.js";
export { OutcomeRepository } from "./outcome-repository.js";
export { PricePointRepository } from "./price-point-repository.js";
export { CanonicalEventRepository } from "./canonical-event-repository.js";
export type {
  CanonicalEventFilter,
  CanonicalEventSummaryRow,
  CanonicalComparisonMemberRow,
} from "./canonical-event-repository.js";

// Read-only discovery/detail queries that back the outbound API gateway
// (Requirements 1.1, 1.2, 1.4, 1.5, 4.1). All discovery SQL lives here.
export { MarketDiscoveryRepository } from "./market-discovery-repository.js";
export type {
  MarketSortKey,
  SortOrder,
  MarketDiscoveryFilter,
  MarketSummaryRow,
  MarketDetailRow,
} from "./market-discovery-repository.js";
export { SourceRepository } from "./source-repository.js";
export type { SourceRecord } from "./source-repository.js";

export { WatchlistRepository } from "./watchlist-repository.js";
export { AlertRuleRepository } from "./alert-rule-repository.js";

// Candidate search + canonical linking for the same-question matching engine
// (implements the @pma/core MatchingRepository port; design.md matchMarket).
export { MatchingRepository, DEFAULT_CANDIDATE_LIMIT } from "./matching-repository.js";
