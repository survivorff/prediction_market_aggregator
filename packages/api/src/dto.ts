/**
 * Response DTO contracts for the outbound API gateway (design.md "Outbound API
 * Surface" — `MarketSummary` et al.) and the injectable dependency ports the
 * handlers read from.
 *
 * The gateway serves **exclusively** from the system's own storage/Redis
 * (Requirement 9.1): it never imports an adapter or calls an upstream platform
 * API. Dependencies are expressed as narrow reader interfaces (a subset of the
 * `@pma/storage` repositories + hot cache) so handlers can be unit-tested with
 * in-memory fakes — no Postgres/Redis required (see `createServer`).
 */

import type {
  Category,
  CanonicalEvent,
  LinkedMarket,
  MarketStatus,
  Outcome,
  PricePoint,
  ResolutionCriteria,
  SourceCapabilities,
  TimeRange,
  WatchlistItem,
  WatchlistItemInput,
  WatchlistTargetType,
  AlertRule,
  AlertRuleInput,
  AlertRuleParams,
  AlertRuleType,
} from "@pma/core";
import type {
  CanonicalComparisonMemberRow,
  CanonicalEventFilter,
  CanonicalEventSummaryRow,
  FanoutMessage,
  HotPrice,
  MarketDetailRow,
  MarketDiscoveryFilter,
  MarketSummaryRow,
  SourceRecord,
} from "@pma/storage";
import type { Authenticator } from "./auth.js";

// ---------------------------------------------------------------------------
// Response DTOs (the public REST contracts).
// ---------------------------------------------------------------------------

/** A source's public identity as embedded in market responses. */
export interface SourceRef {
  key: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Trade deep-link DTOs + the replaceable resolver seam (task 7.3).
// ---------------------------------------------------------------------------

/**
 * The narrow market projection a {@link TradeLinkResolver} consumes — only the
 * fields needed to build a navigation URL. It carries NOTHING execution-related
 * (no funds, wallet, or order data); v1 is navigation-only (Requirements 6.2,
 * 12.1).
 */
export interface TradeLinkMarket {
  id: string;
  sourceKey: string;
  sourceName: string;
  /** Platform-native market id (idempotency key component). */
  externalId: string;
  /** Platform slug when known (preferred over the id for a stable deep-link). */
  slug?: string | null;
}

/**
 * `GET /api/markets/{id}/trade-link` response (design glossary "Trade
 * Deep-Link"; Requirement 6.1): a navigation URL to the market on its source
 * platform. `executable` is the literal `false` — v1 performs NO order
 * placement, fund routing, or execution (Requirements 6.2, 12.1). This is the
 * reserved future "one-click participate" slot (Requirement 6.3).
 *
 * `url` is `null` only when no deep-link can be built for the source (e.g. a
 * newly added source without a registered URL builder); known sources always
 * yield at least the platform's base site.
 */
export interface TradeLink {
  marketId: string;
  source: SourceRef;
  url: string | null;
  executable: false;
}

/**
 * The replaceable "trade-link slot" (Requirement 6.3): a single injectable
 * strategy mapping a market → its outbound {@link TradeLink}. A future
 * "one-click participate" execution flow replaces THIS resolver without
 * touching the discovery / comparison / signals contracts. The default
 * implementation (`trade-link.ts`) is a pure URL registry with no execution
 * path (Requirements 6.2, 12.1).
 */
export type TradeLinkResolver = (market: TradeLinkMarket) => TradeLink;

/**
 * Unified discovery row (design.md `MarketSummary`). `impliedProb` is the
 * Yes-outcome probability, served from the Redis hot cache when available and
 * falling back to the stored outcome (Requirements 1.1, 10.4). Missing upstream
 * values are represented explicitly as `null` (Requirement 1.5).
 */
export interface MarketSummary {
  id: string;
  source: SourceRef;
  question: string;
  category: Category;
  status: MarketStatus;
  impliedProb: number | null;
  volume24h: number | null;
  liquidity: number | null;
  timeRemainingSec: number | null;
  canonicalEventId: string | null;
}

/** Discovery list envelope with the applied paging window. */
export interface MarketListResponse {
  markets: MarketSummary[];
  /** Echo of the effective paging window (after clamping/defaults). */
  paging: { limit: number; offset: number; count: number };
}

/**
 * A market outcome with its latest price (design.md `GET /api/markets/{id}`,
 * Requirement 4.1). `lastPrice`/`latestPriceTs` are overlaid from the hot cache
 * when present; otherwise the stored outcome's `lastPrice` is used and
 * `latestPriceTs` is `null`. `priceSource` records where the latest price came
 * from for transparency.
 */
export interface OutcomeDetail {
  id: string;
  label: string;
  tokenId: string | null;
  impliedProb: number | null;
  lastPrice: number | null;
  latestPriceTs: string | null;
  priceSource: "hotCache" | "stored" | "none";
}

/**
 * Market detail (Requirement 4.1: metadata + outcomes with latest prices + a
 * link to its source). `impliedProb` is the Yes-outcome probability.
 *
 * Order-book depth (Requirement 4.3): the gateway serves only from
 * storage/Redis (Requirement 9.1) and depth is not persisted in v1, so
 * `orderBookDepth` is always `null`. `orderBookDepthSupported` reflects whether
 * the source's adapter *declares* the `orderBookDepth` capability, so clients
 * can tell "unsupported" apart from "supported but not yet stored".
 */
export interface MarketDetail {
  id: string;
  source: SourceRef;
  externalId: string;
  question: string;
  category: Category;
  status: MarketStatus;
  impliedProb: number | null;
  volume24h: number | null;
  liquidity: number | null;
  spread: number | null;
  timeRemainingSec: number | null;
  canonicalEventId: string | null;
  resolutionCriteria: ResolutionCriteria;
  outcomes: OutcomeDetail[];
  orderBookDepth: null;
  orderBookDepthSupported: boolean;
  /**
   * Relative path to the source deep-link endpoint (implemented in task 7.3).
   * The detail references where the outbound "link to its source" lives without
   * the gateway hardcoding any platform URL scheme here.
   */
  tradeLinkPath: string;
}

/** A single point in a price-history series. */
export interface PriceHistoryPoint {
  outcomeId: string;
  ts: string;
  price: number;
  volume: number | null;
}

/** Price-history response (design.md `GET /api/markets/{id}/history`, Req 4.2). */
export interface PriceHistoryResponse {
  marketId: string;
  range: { from: string; to: string; interval: TimeRange["interval"] | null };
  points: PriceHistoryPoint[];
}

/** A registered platform + its declared capabilities (design.md `GET /api/sources`). */
export interface SourceInfo {
  key: string;
  name: string;
  type: SourceRecord["type"];
  baseCurrency: string;
  capabilities: SourceCapabilities | null;
}

/** `GET /api/sources` envelope. */
export interface SourceListResponse {
  sources: SourceInfo[];
}

// ---------------------------------------------------------------------------
// Comparison + signals DTOs (task 7.2).
// ---------------------------------------------------------------------------

/**
 * A cross-platform grouping summary for `GET /api/canonical-events` (design.md
 * "Outbound API Surface"; Requirement 2.1). Carries the canonical event's
 * identity plus a lightweight summary — how many platform markets are linked
 * and how many of those are flagged with a resolution mismatch (Req 2.3) — so
 * the list view can preview cross-platform coverage without fetching every row.
 */
export interface CanonicalEventSummary {
  id: string;
  title: string;
  category: Category;
  subjectEntity: string | null;
  thresholdValue: number | null;
  targetDate: string | null;
  /** Number of platform markets linked to this canonical event. */
  memberCount: number;
  /** Of those, how many are flagged `resolutionMismatch` (excluded from spread). */
  mismatchCount: number;
}

/** `GET /api/canonical-events` list envelope. */
export interface CanonicalEventListResponse {
  canonicalEvents: CanonicalEventSummary[];
  /** Echo of the applied category filter (null when unfiltered). */
  filter: { category: Category | null };
}

/**
 * One platform's row in the comparison view (design.md `ComparisonView.rows[]`;
 * Requirement 2.1). `impliedProb` is the Yes-outcome probability served from
 * the hot cache when available, else stored (Req 10.4). `resolutionMismatch`
 * surfaces why a row is excluded from the spread (Req 2.3); `tradeLink` is the
 * outbound deep-link path (the future execution slot, task 7.3).
 */
export interface ComparisonRow {
  source: SourceRef;
  marketId: string;
  impliedProb: number | null;
  volume24h: number | null;
  /** When true, this row is shown but excluded from `maxSpread` (Req 2.3). */
  resolutionMismatch: boolean;
  /** Relative path to the source deep-link endpoint (task 7.3). */
  tradeLink: string;
}

/**
 * The same-question comparison view (design.md `ComparisonView`; `GET
 * /api/canonical-events/{id}`). Presents each platform's market side by side
 * (Requirement 2.1). `maxSpread` is the max-minus-min implied probability
 * computed over ONLY open, non-mismatched rows (Req 2.3); it is `null` when
 * fewer than two such rows exist, so the available market(s) are still shown
 * without a spread value (Req 2.4).
 */
export interface ComparisonView {
  canonicalEvent: CanonicalEvent;
  rows: ComparisonRow[];
  maxSpread: number | null;
}

/**
 * A display-only spread signal as served by `GET /api/signals` (design.md
 * `SpreadSignal`). Ranked by largest cross-platform gap (Requirement 3.1),
 * computed over only open + aligned markets (Req 3.2), and always
 * non-executable (Req 3.3 — `executable` is the literal `false`).
 */
export interface SignalDto {
  canonicalEventId: string;
  title: string;
  perPlatform: Array<{ source: string; impliedProb: number }>;
  gap: number;
  executable: false;
}

/** `GET /api/signals` list envelope. */
export interface SignalListResponse {
  signals: SignalDto[];
  /** Echo of the effective limit applied to the ranked list. */
  limit: number;
}

// ---------------------------------------------------------------------------
// Watchlist DTOs (task 8.1 — user-scoped, authenticated; Requirements 5.1,
// 5.4, 9.4).
// ---------------------------------------------------------------------------

/**
 * A watchlist entry as served by the watchlist endpoints (design.md "Outbound
 * API Surface" — `GET/POST/DELETE /api/watchlist`). Mirrors the core
 * {@link WatchlistItem}; `userId` is intentionally omitted from the wire shape
 * because the routes are user-scoped (the authenticated identity owns every row
 * returned — Requirement 9.4), so echoing it back is redundant.
 */
export interface WatchlistItemDto {
  id: string;
  targetType: WatchlistTargetType;
  targetId: string;
  createdAt: string;
}

/** `GET /api/watchlist` list envelope. */
export interface WatchlistListResponse {
  items: WatchlistItemDto[];
}

/** Request body for `POST /api/watchlist` (validated at the edge → 400). */
export interface AddWatchlistItemBody {
  targetType: WatchlistTargetType;
  targetId: string;
}

// ---------------------------------------------------------------------------
// Alert-rule DTOs (task 8.2 — user-scoped, authenticated; Requirements 5.2,
// 5.4, 9.4).
// ---------------------------------------------------------------------------

/**
 * An alert rule as served by the alert endpoints (design.md "Outbound API
 * Surface" — `GET/POST/DELETE /api/alerts`). Mirrors the core {@link AlertRule};
 * `userId` is intentionally omitted from the wire shape because the routes are
 * user-scoped (the authenticated identity owns every row returned —
 * Requirement 9.4), so echoing it back is redundant. Carries the persisted
 * `params` + `active` flag (Requirement 5.2).
 */
export interface AlertRuleDto {
  id: string;
  targetType: WatchlistTargetType;
  targetId: string;
  ruleType: AlertRuleType;
  params: AlertRuleParams;
  active: boolean;
  createdAt: string;
}

/** `GET /api/alerts` list envelope. */
export interface AlertListResponse {
  alerts: AlertRuleDto[];
}

/** Request body for `POST /api/alerts` (validated at the edge → 400). */
export interface CreateAlertBody {
  targetType: WatchlistTargetType;
  targetId: string;
  ruleType: AlertRuleType;
  params: AlertRuleParams;
}

// ---------------------------------------------------------------------------
// Injectable dependency ports (narrow reader views of @pma/storage).
// ---------------------------------------------------------------------------

/** Discovery + detail reads (satisfied by `MarketDiscoveryRepository`). */
export interface MarketDiscoveryReader {
  listMarkets(filter?: MarketDiscoveryFilter): Promise<MarketSummaryRow[]>;
  getMarketDetail(id: string): Promise<MarketDetailRow | null>;
}

/** Outcome reads (satisfied by `OutcomeRepository`). */
export interface OutcomeReader {
  listByMarket(marketId: string): Promise<Outcome[]>;
}

/** Price-history reads (satisfied by `PricePointRepository`). */
export interface PriceHistoryReader {
  history(marketId: string, range: TimeRange): Promise<PricePoint[]>;
}

/** Source reads (satisfied by `SourceRepository`). */
export interface SourceReader {
  list(): Promise<SourceRecord[]>;
}

/** Hot latest-price reads (satisfied by `HotPriceCache`); optional in v1. */
export interface HotPriceReader {
  getMarketHotPrices(marketId: string): Promise<HotPrice[]>;
}

/**
 * Canonical-event reads backing the comparison + signals endpoints (satisfied
 * by `CanonicalEventRepository`). All canonical SQL lives in storage; this port
 * is the narrow read view the gateway depends on so handlers stay unit-testable
 * with in-memory fakes.
 */
export interface CanonicalEventReader {
  /** Cross-platform groupings + member-count summary (`GET /api/canonical-events`). */
  listSummaries(filter?: CanonicalEventFilter): Promise<CanonicalEventSummaryRow[]>;
  /** Fetch a canonical event by id; `null` when not present (→ 404). */
  getById(id: string): Promise<CanonicalEvent | null>;
  /** Per-platform comparison rows for a canonical event (`GET /api/canonical-events/{id}`). */
  comparisonMembers(canonicalEventId: string): Promise<CanonicalComparisonMemberRow[]>;
  /**
   * Markets linked to a canonical event as {@link LinkedMarket}s (carrying the
   * `resolutionMismatch` flag) — the `MatchingRepository`-shaped membership read
   * consumed by `computeSignals` (Requirements 3.2, 3.4).
   */
  marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]>;
}

/**
 * The narrow watchlist persistence port the user-scoped watchlist routes depend
 * on (task 8.1). Satisfied structurally by `@pma/storage`'s
 * `WatchlistRepository`; tests inject an in-memory fake. Every method is scoped
 * to a `userId` so a request can only ever touch the authenticated user's own
 * rows (Requirements 5.4, 9.4); `add` is idempotent/duplicate-preventing per
 * `(userId, targetType, targetId)` (Requirement 5.1).
 */
export interface WatchlistStore {
  /** Add (or return the existing) entry — no duplicate per target (Req 5.1). */
  add(input: WatchlistItemInput): Promise<WatchlistItem>;
  /** List the user's entries (newest first). */
  listByUser(userId: string): Promise<WatchlistItem[]>;
  /**
   * Delete the user's entry by id; `false` when no matching `(userId, itemId)`
   * row exists (unknown OR another user's item → 404 at the route). Req 5.4.
   */
  delete(userId: string, itemId: string): Promise<boolean>;
}

/**
 * The narrow alert-rule persistence port the user-scoped alert routes depend on
 * (task 8.2). Satisfied structurally by `@pma/storage`'s `AlertRuleRepository`;
 * tests inject an in-memory fake. Every method is scoped to a `userId` so a
 * request can only ever touch the authenticated user's own rules
 * (Requirements 5.4, 9.4). Unlike the watchlist, `create` is NOT deduplicated —
 * a user may create multiple rules for the same target (Requirement 5.2).
 */
export interface AlertStore {
  /** Persist a new rule with its params + active flag (Req 5.2). No dedup. */
  create(input: AlertRuleInput): Promise<AlertRule>;
  /** List the user's rules (newest first). */
  listByUser(userId: string): Promise<AlertRule[]>;
  /**
   * Delete the user's rule by id; `false` when no matching `(userId, id)` row
   * exists (unknown OR another user's rule → 404 at the route). Req 5.4.
   */
  delete(userId: string, id: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// WebSocket fan-out ports (task 7.4).
// ---------------------------------------------------------------------------

/**
 * One channel subscription held by a connected WS client. `close()`
 * unsubscribes just this handler (and releases the underlying Redis
 * `UNSUBSCRIBE` once a channel has no remaining handlers). Structurally
 * satisfied by `@pma/storage`'s `ChannelSubscription`.
 */
export interface FanoutChannelSubscription {
  close(): Promise<void>;
  readonly channel: string;
}

/**
 * The narrow subscriber port the WS fan-out depends on. Subscribes a handler to
 * a Redis channel and relays each decoded {@link FanoutMessage} envelope; the
 * subscriber owns a DEDICATED Redis connection in subscriber mode (a
 * subscriber-mode connection cannot issue ordinary commands), so one instance
 * multiplexes all of a single WS client's channels over that one connection.
 *
 * Structurally satisfied by `@pma/storage`'s `FanoutSubscriber`; tests inject a
 * fake (no real Redis) to assert relay/isolation/cleanup behavior.
 */
export interface FanoutSubscriberPort {
  subscribe(
    channel: string,
    handler: (message: FanoutMessage) => void,
  ): Promise<FanoutChannelSubscription>;
  /** Tear down all subscriptions and close the dedicated connection. */
  close(): Promise<void>;
}

/**
 * Factory producing a fresh {@link FanoutSubscriberPort} (each backed by its
 * own dedicated Redis subscriber connection). The WS fan-out creates ONE
 * subscriber per WS client connection (see `websocket.ts`); the default wires
 * `FanoutSubscriber` over a dedicated `createRedisClient()`. Injecting a fake
 * here lets tests drive the relay deterministically with no Redis.
 */
export type FanoutSubscriberFactory = () => FanoutSubscriberPort;

/**
 * The gateway's injected dependencies. All reads go through these ports; the
 * gateway never reaches upstream platforms (Requirement 9.1). `hotPrices` is
 * optional — when omitted, latest prices fall back to stored outcome data.
 */
export interface GatewayDeps {
  discovery: MarketDiscoveryReader;
  outcomes: OutcomeReader;
  prices: PriceHistoryReader;
  sources: SourceReader;
  /**
   * Canonical-event reads backing the comparison + signals endpoints (task
   * 7.2). Optional so the task-7.1 discovery/detail server can be built without
   * it; the comparison/signals routes require it (a 500 surfaces if missing).
   */
  canonicalEvents?: CanonicalEventReader;
  /**
   * User-scoped watchlist persistence backing `GET/POST/DELETE /api/watchlist`
   * (task 8.1; Requirements 5.1, 5.4, 9.4). Optional so the read-only server
   * can be built without it; the watchlist routes are mounted only when this is
   * provided AND an {@link authenticate} port is configured (the routes are
   * guarded by `requireAuth`). Satisfied by `@pma/storage`'s
   * `WatchlistRepository`.
   */
  watchlist?: WatchlistStore;
  /**
   * User-scoped alert-rule persistence backing `GET/POST/DELETE /api/alerts`
   * (task 8.2; Requirements 5.2, 5.4, 9.4). Optional so the read-only server
   * can be built without it; the alert routes are mounted only when this is
   * provided AND an {@link authenticate} port is configured (the routes are
   * guarded by `requireAuth`). Satisfied by `@pma/storage`'s
   * `AlertRuleRepository`.
   */
  alerts?: AlertStore;
  /** Redis hot latest-price cache (Requirement 10.4). Optional. */
  hotPrices?: HotPriceReader;
  /**
   * The replaceable trade-link slot (Requirement 6.3). Optional: when omitted,
   * the gateway uses the default registry-backed resolver (`defaultTradeLinkResolver`),
   * which builds a source-platform deep-link with NO execution path
   * (Requirements 6.2, 12.1). A future "one-click participate" flow injects its
   * own resolver here WITHOUT changing any other contract.
   */
  tradeLink?: TradeLinkResolver;
  /**
   * Per-source-key adapter capabilities (declared in code, not persisted), used
   * to populate `GET /api/sources` and `MarketDetail.orderBookDepthSupported`.
   */
  capabilities?: Record<string, SourceCapabilities>;
  /**
   * Factory for the WebSocket fan-out's pub/sub subscriber (task 7.4). The WS
   * route creates ONE {@link FanoutSubscriberPort} per WS client connection,
   * each backed by its own dedicated Redis subscriber connection, and closes it
   * on disconnect. Optional so the REST-only server can be built without it; the
   * `WS /ws` route is registered only when this is provided. When omitted, no WS
   * endpoint is mounted. The default deployment wiring supplies a factory over
   * `@pma/storage`'s `FanoutSubscriber` (`buildGatewayDeps`).
   */
  fanoutSubscriberFactory?: FanoutSubscriberFactory;
  /**
   * Authentication port for user-scoped resources (Requirement 9.4). When
   * provided, the `requireAuth` preHandler resolves the request's identity via
   * this function (returning `null` → 401). When OMITTED, user-scoped routes are
   * CLOSED: `requireAuth` rejects every request with 401 (safe-by-default — see
   * `auth.ts`). Public read endpoints never consult this; they stay open but
   * rate-limited (Requirement 9.3). A production deployment injects a JWT/session
   * verifier here (e.g. via `bearerAuthenticator`); tests inject a fake.
   */
  authenticate?: Authenticator;
  /** Clock override for `timeRemainingSec` (defaults to `Date.now`). */
  now?: () => number;
}
