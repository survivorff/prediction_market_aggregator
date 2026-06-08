/**
 * Wire DTO contracts for the project's own API gateway (`@pma/api`).
 *
 * These interfaces deliberately MIRROR the gateway's response shapes
 * (`packages/api/src/dto.ts`) rather than importing them, so the frontend has
 * NO build/runtime dependency on any server package — the only coupling is the
 * HTTP contract. The frontend talks exclusively to this API (Requirement 9.1);
 * it never imports an adapter or reaches an upstream platform.
 *
 * Nullable fields stay `T | null` end-to-end so the UI can render missing
 * upstream values explicitly (Requirement 1.5: show "—" for nulls) instead of
 * fabricating defaults.
 */

/** Normalized market category (design.md `Category`). */
export type Category = "politics" | "crypto" | "sports" | "economics" | "tech" | "other";

/** All categories, for building filter controls. */
export const CATEGORIES: readonly Category[] = [
  "politics",
  "crypto",
  "sports",
  "economics",
  "tech",
  "other",
];

/** Lifecycle status of a market. */
export type MarketStatus = "open" | "closed" | "resolved";

/** All statuses, for building filter controls. */
export const MARKET_STATUSES: readonly MarketStatus[] = ["open", "closed", "resolved"];

/** Sortable discovery keys (Requirement 1.4: volume, liquidity, time remaining). */
export type MarketSortKey = "volume" | "liquidity" | "timeRemaining";

/** Sort direction. */
export type SortOrder = "asc" | "desc";

/** A source's public identity as embedded in market responses. */
export interface SourceRef {
  key: string;
  name: string;
}

/** Unified discovery row (gateway `MarketSummary`). */
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

/** Discovery list envelope (gateway `MarketListResponse`). */
export interface MarketListResponse {
  markets: MarketSummary[];
  paging: { limit: number; offset: number; count: number };
}

/** Preserved raw + structured resolution criteria (design.md `ResolutionCriteria`). */
export interface ResolutionCriteria {
  dataSource: string | null;
  cutoffTime: string | null;
  rounding: string | null;
  raw: Record<string, unknown>;
}

/** A market outcome with its latest price (gateway `OutcomeDetail`). */
export interface OutcomeDetail {
  id: string;
  label: string;
  tokenId: string | null;
  impliedProb: number | null;
  lastPrice: number | null;
  latestPriceTs: string | null;
  priceSource: "hotCache" | "stored" | "none";
}

/** Market detail (gateway `MarketDetail`). */
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
  /** Relative path to the source deep-link endpoint (`GET /api/markets/{id}/trade-link`). */
  tradeLinkPath: string;
}

/** A single point in a price-history series (gateway `PriceHistoryPoint`). */
export interface PriceHistoryPoint {
  outcomeId: string;
  ts: string;
  price: number;
  volume: number | null;
}

/** Price-history response (gateway `PriceHistoryResponse`). */
export interface PriceHistoryResponse {
  marketId: string;
  range: { from: string; to: string; interval: string | null };
  points: PriceHistoryPoint[];
}

/** Declared adapter capabilities for a source (design.md `SourceCapabilities`). */
export interface SourceCapabilities {
  websocketPrices: boolean;
  priceHistory: boolean;
  orderBookDepth: boolean;
  keysetPagination: boolean;
}

/** A registered platform + its declared capabilities (gateway `SourceInfo`). */
export interface SourceInfo {
  key: string;
  name: string;
  type: "onchain" | "cex" | "regulated";
  baseCurrency: string;
  capabilities: SourceCapabilities | null;
}

/** `GET /api/sources` envelope (gateway `SourceListResponse`). */
export interface SourceListResponse {
  sources: SourceInfo[];
}

/** Outbound trade deep-link (gateway `TradeLink`; navigation-only, `executable:false`). */
export interface TradeLink {
  marketId: string;
  source: SourceRef;
  url: string | null;
  executable: false;
}

// ---------------------------------------------------------------------------
// Comparison + signals DTOs (gateway `@pma/api` — task 7.2).
// ---------------------------------------------------------------------------

/**
 * A cross-platform grouping (design.md `CanonicalEvent`). Basis for the
 * comparison view and spread signals; `subjectEntity`/`thresholdValue`/
 * `targetDate` are nullable when the matching engine could not extract them.
 */
export interface CanonicalEvent {
  id: string;
  title: string;
  category: Category;
  subjectEntity: string | null;
  thresholdValue: number | null;
  targetDate: string | null;
}

/**
 * A cross-platform grouping summary row for the comparison list
 * (gateway `CanonicalEventSummary`; `GET /api/canonical-events`). Carries a
 * lightweight preview of cross-platform coverage: how many platform markets are
 * linked (`memberCount`) and how many of those are flagged with a resolution
 * mismatch and thus excluded from the spread (`mismatchCount`, Requirement 2.3).
 */
export interface CanonicalEventSummary {
  id: string;
  title: string;
  category: Category;
  subjectEntity: string | null;
  thresholdValue: number | null;
  targetDate: string | null;
  memberCount: number;
  mismatchCount: number;
}

/** `GET /api/canonical-events` list envelope (gateway `CanonicalEventListResponse`). */
export interface CanonicalEventListResponse {
  canonicalEvents: CanonicalEventSummary[];
  /** Echo of the applied category filter (null when unfiltered). */
  filter: { category: Category | null };
}

/**
 * One platform's row in the side-by-side comparison view (gateway
 * `ComparisonRow`; design.md `ComparisonView.rows[]`, Requirement 2.1).
 * `impliedProb`/`volume24h` are nullable (render as "—"); `resolutionMismatch`
 * surfaces why a row is excluded from the spread (Req 2.3); `tradeLink` is the
 * relative path to the outbound deep-link endpoint (the future execution slot).
 */
export interface ComparisonRow {
  source: SourceRef;
  marketId: string;
  impliedProb: number | null;
  volume24h: number | null;
  /** When true, the row is shown but excluded from `maxSpread` (Req 2.3). */
  resolutionMismatch: boolean;
  /** Relative path to the source deep-link endpoint (`/api/markets/{id}/trade-link`). */
  tradeLink: string;
}

/**
 * The same-question comparison view (gateway `ComparisonView`; design.md
 * `ComparisonView`, `GET /api/canonical-events/{id}`). Presents each platform's
 * market side by side (Requirement 2.1). `maxSpread` is the max-minus-min
 * implied probability over ONLY open, non-mismatched rows; it is `null` when
 * fewer than two such rows exist, so available market(s) still show without a
 * spread value (Req 2.4).
 */
export interface ComparisonView {
  canonicalEvent: CanonicalEvent;
  rows: ComparisonRow[];
  maxSpread: number | null;
}

/**
 * A display-only spread signal (gateway `SignalDto`; design.md `SpreadSignal`;
 * `GET /api/signals`). Ranked by largest cross-platform gap (Requirement 3.1),
 * computed over only open + aligned markets (Req 3.2), and ALWAYS
 * non-executable: `executable` is the literal `false` (Req 3.3 — v1 is
 * display-only, there is no execution/order-placement path).
 */
export interface SignalDto {
  canonicalEventId: string;
  title: string;
  perPlatform: Array<{ source: string; impliedProb: number }>;
  gap: number;
  executable: false;
}

/** `GET /api/signals` list envelope (gateway `SignalListResponse`). */
export interface SignalListResponse {
  signals: SignalDto[];
  /** Echo of the effective limit applied to the ranked list. */
  limit: number;
}

/** Supported price-history range presets surfaced in the detail UI. */
export type HistoryRangePreset = "24h" | "7d" | "30d";

// ---------------------------------------------------------------------------
// Watchlist DTOs (gateway `@pma/api` - task 8.1; design.md "Outbound API
// Surface" -> `GET/POST/DELETE /api/watchlist`). User-scoped, authenticated
// (Requirements 5.1, 5.4, 9.4): these mirror the gateway's wire shapes. The
// owner `userId` is intentionally NOT echoed back - every response is already
// scoped to the authenticated caller.
// ---------------------------------------------------------------------------

/**
 * What a watchlist entry points at: a single normalized `market`, or a
 * cross-platform `canonicalEvent` grouping (gateway `WatchlistTargetType`).
 */
export type WatchlistTargetType = "market" | "canonicalEvent";

/** All valid {@link WatchlistTargetType} values, for building add controls. */
export const WATCHLIST_TARGET_TYPES: readonly WatchlistTargetType[] = ["market", "canonicalEvent"];

/**
 * A watchlist entry as served by the watchlist endpoints (gateway
 * `WatchlistItemDto`; `GET/POST /api/watchlist`). `(targetType, targetId)`
 * identifies the tracked market or canonical event; duplicates for the same
 * target are prevented by the idempotent gateway (Requirement 5.1). `createdAt`
 * is ISO 8601; the owner `userId` is omitted (the list is already user-scoped).
 */
export interface WatchlistItem {
  id: string;
  targetType: WatchlistTargetType;
  targetId: string;
  createdAt: string;
}

/** `GET /api/watchlist` list envelope (gateway `WatchlistListResponse`). */
export interface WatchlistListResponse {
  items: WatchlistItem[];
}

/**
 * Request body for `POST /api/watchlist` (gateway `AddWatchlistItemBody`). Adds
 * a market/canonical event to the authenticated user's watchlist; the gateway
 * is idempotent, so re-adding the same target returns the existing item with no
 * duplicate row (Requirement 5.1).
 */
export interface AddWatchlistBody {
  targetType: WatchlistTargetType;
  targetId: string;
}

// ---------------------------------------------------------------------------
// WebSocket fan-out envelope (gateway `WS /ws` - task 7.4; Requirements 9.2,
// 5.3). The server relays `{ channel, type, payload }` where `channel` is the
// full Redis channel name (e.g. `chan:market:{id}`). These mirror the
// `@pma/storage` `FanoutMessage` + payload shapes WITHOUT importing them, so
// the frontend keeps NO build/runtime dependency on a server package.
// ---------------------------------------------------------------------------

/** The kinds of fan-out channel a client can subscribe to. */
export type FanoutChannelKind = "market" | "canonical" | "alerts";

/** The kind of update carried in a relayed {@link FanoutMessage}. */
export type FanoutMessageType = "price" | "spread" | "alert";

/**
 * Payload of a `price` message: the latest normalized price observation for a
 * market outcome (gateway `PricePayload`; mirrors `NormalizedPriceSnapshot`).
 */
export interface FanoutPricePayload {
  marketId: string;
  outcomeLabel: string;
  /** 0..1 for binary. */
  price: number;
  volume: number | null;
  /** ISO 8601 capture time. */
  ts: string;
}

/**
 * Payload of a `spread` message: a canonical event's latest cross-platform
 * implied-probability gap (gateway `SpreadPayload`; display-only).
 */
export interface FanoutSpreadPayload {
  canonicalEventId: string;
  gap: number;
  probabilities: Array<{ source: string; impliedProb: number }>;
}

/**
 * Payload of an `alert` message: a user-addressed alert notification
 * (gateway/`@pma/alerts` `AlertNotification`; task 8.3). `userId` makes the
 * notification routable on the shared alerts channel; `details` carries the
 * rule-type-specific firing evidence (Requirement 5.3).
 */
export interface FanoutAlertPayload {
  alertId: string;
  userId: string;
  ruleType: "thresholdCross" | "spreadWiden";
  targetType: WatchlistTargetType;
  targetId: string;
  details: Record<string, unknown>;
}

/**
 * The uniform fan-out envelope relayed to WS clients (gateway `FanoutMessage`).
 * `channel` is the full Redis channel name; decode the target kind/id from it
 * if needed. `type` discriminates the `payload` shape.
 */
export interface FanoutMessage<T = unknown> {
  channel: string;
  type: FanoutMessageType;
  payload: T;
}
