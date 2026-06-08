/**
 * @pma/api — Outbound API gateway (REST + GraphQL + WebSocket fan-out).
 *
 * The only surface clients use. Exposes read-only discovery, comparison,
 * detail, and display-only signal endpoints, plus a WebSocket fan-out fed by
 * Redis pub/sub. Unifies rate limiting and input validation; v1 exposes no
 * execution path.
 *
 * Task 7.1 implements the discovery + detail + history + sources endpoints.
 * Task 7.2 adds the comparison + signals endpoints (canonical-events list,
 * comparison view with mismatch flags, and display-only spread signals). Task
 * 7.3 adds the outbound trade deep-link (`GET /api/markets/{id}/trade-link`) — a
 * navigation-only link (`executable: false`, no execution path) backed by a
 * replaceable resolver slot (Requirements 6.1, 6.2, 6.3, 12.1). The gateway
 * serves EXCLUSIVELY from the system's own storage/Redis (Requirement 9.1): it
 * never imports an adapter or calls an upstream platform API.
 */

export const API_PACKAGE = "@pma/api" as const;

// Server factory + dependency wiring.
export { createServer, type CreateServerOptions, type RateLimitOptions } from "./server.js";
export { buildGatewayDeps, type BuildGatewayDepsOptions } from "./deps.js";

// Authentication for user-scoped resources (task 7.5 / Requirement 9.4): the
// injectable authenticator port + the `requireAuth` preHandler that task 8's
// watchlist/alerts routes attach to enforce authentication (safe-by-default:
// closed when no authenticator is configured).
export {
  requireAuth,
  bearerAuthenticator,
  extractBearerToken,
  type Authenticator,
  type AuthenticatedUser,
  type BearerTokenVerifier,
} from "./auth.js";

// WebSocket fan-out (task 7.4): the `WS /ws` route + the transport-agnostic
// relay logic (subscribe protocol → Redis pub/sub → relayed envelopes).
export { registerWebSocketFanout, WS_FANOUT_PATH } from "./websocket.js";
export {
  FanoutRelay,
  parseSubscribeFrame,
  resolveRedisChannel,
  type SubscribeRequest,
  type ParseResult,
  type FrameSink,
} from "./ws-fanout.js";

// Request handlers (framework-agnostic; useful for unit tests + reuse).
export {
  handleGetMarket,
  handleGetMarketHistory,
  handleGetTradeLink,
  handleListMarkets,
  handleListSources,
  handleListCanonicalEvents,
  handleGetCanonicalEvent,
  handleListSignals,
} from "./handlers.js";

// Watchlist handlers (task 8.1): user-scoped add/list/delete over the injected
// WatchlistStore port (Requirements 5.1, 5.4, 9.4).
export {
  handleAddWatchlist,
  handleDeleteWatchlist,
  handleListWatchlist,
} from "./watchlist.handlers.js";

// The replaceable trade-link slot (task 7.3): default registry-backed resolver
// + factory so a future "one-click participate" flow can swap it in.
export {
  createTradeLinkResolver,
  defaultTradeLinkResolver,
  DEFAULT_SOURCE_URL_BUILDERS,
  type SourceUrlBuilder,
  type TradeLinkRegistryOptions,
} from "./trade-link.js";

// Typed errors mapped to HTTP status codes.
export { ValidationError, NotFoundError, UnauthorizedError, type ErrorResponse } from "./errors.js";

// Input validation/coercion for the public read endpoints.
export {
  parseDiscoveryQuery,
  parseHistoryQuery,
  parseMarketId,
  parseCanonicalEventId,
  parseCanonicalEventsQuery,
  parseSignalsQuery,
  parseWatchlistItemId,
  parseAddWatchlistBody,
  type DiscoveryQuery,
  type HistoryQuery,
  type CanonicalEventsQuery,
  type SignalsQuery,
  type AddWatchlistBody,
  type RawParams,
} from "./validation.js";

// Response DTO contracts + injectable dependency ports.
export type {
  SourceRef,
  MarketSummary,
  MarketListResponse,
  OutcomeDetail,
  MarketDetail,
  PriceHistoryPoint,
  PriceHistoryResponse,
  SourceInfo,
  SourceListResponse,
  CanonicalEventSummary,
  CanonicalEventListResponse,
  ComparisonRow,
  ComparisonView,
  SignalDto,
  SignalListResponse,
  WatchlistItemDto,
  WatchlistListResponse,
  AddWatchlistItemBody,
  TradeLink,
  TradeLinkMarket,
  TradeLinkResolver,
  FanoutChannelSubscription,
  FanoutSubscriberPort,
  FanoutSubscriberFactory,
  MarketDiscoveryReader,
  OutcomeReader,
  PriceHistoryReader,
  SourceReader,
  HotPriceReader,
  CanonicalEventReader,
  WatchlistStore,
  GatewayDeps,
} from "./dto.js";
