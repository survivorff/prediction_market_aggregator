/**
 * Input validation + coercion for the gateway's public read endpoints
 * (Requirement 9.3: validate input parameters; returns 400 on invalid input).
 *
 * These are pure functions over already-parsed query/path objects (Fastify
 * gives us `request.query` / `request.params` as `Record<string, unknown>`), so
 * they are unit-testable without HTTP and reused by the route handlers. Each
 * throws {@link ValidationError} on bad input, which the server maps to 400.
 */

import {
  CATEGORIES,
  MARKET_STATUSES,
  isCategory,
  isMarketStatus,
  isWatchlistTargetType,
  isAlertRuleType,
  isValidAlertRuleParams,
} from "@pma/core";
import type {
  Category,
  MarketStatus,
  TimeRange,
  WatchlistTargetType,
  AlertRuleType,
  AlertRuleParams,
} from "@pma/core";
import type { MarketSortKey, SortOrder } from "@pma/storage";
import { ValidationError } from "./errors.js";

/** Validated, coerced query for `GET /api/markets`. */
export interface DiscoveryQuery {
  category?: Category;
  status?: MarketStatus;
  q?: string;
  sort?: MarketSortKey;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

/** Validated query for `GET /api/markets/{id}/history`. */
export interface HistoryQuery {
  range: TimeRange;
}

/** Validated, coerced query for `GET /api/canonical-events`. */
export interface CanonicalEventsQuery {
  category?: Category;
}

/** Validated, coerced query for `GET /api/signals`. */
export interface SignalsQuery {
  limit?: number;
}

/** Validated body for `POST /api/watchlist`. */
export interface AddWatchlistBody {
  targetType: WatchlistTargetType;
  targetId: string;
}

/** Validated body for `POST /api/alerts`. */
export interface CreateAlertBody {
  targetType: WatchlistTargetType;
  targetId: string;
  ruleType: AlertRuleType;
  params: AlertRuleParams;
}

const SORT_KEYS: readonly MarketSortKey[] = ["volume", "liquidity", "timeRemaining"];
const SORT_ORDERS: readonly SortOrder[] = ["asc", "desc"];
const INTERVALS: readonly NonNullable<TimeRange["interval"]>[] = ["1m", "5m", "1h", "1d"];

const MAX_LIMIT = 200;
const MAX_Q_LENGTH = 256;

/** A loosely-typed bag of query/path params as Fastify hands them over. */
export type RawParams = Record<string, unknown>;

/** Read a single string value from a raw param (rejecting arrays/objects). */
function readString(params: RawParams, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    throw new ValidationError(`Query parameter "${key}" must be a single value`, key);
  }
  if (typeof value !== "string") {
    throw new ValidationError(`Query parameter "${key}" must be a string`, key);
  }
  return value;
}

/** Parse a bounded non-negative integer from a raw param. */
function readInt(params: RawParams, key: string, min: number, max: number): number | undefined {
  const raw = readString(params, key);
  if (raw === undefined || raw.trim().length === 0) return undefined;
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new ValidationError(`Query parameter "${key}" must be an integer`, key);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw new ValidationError(`Query parameter "${key}" must be between ${min} and ${max}`, key);
  }
  return parsed;
}

/** Validate + coerce the discovery query string. Throws 400 on invalid input. */
export function parseDiscoveryQuery(params: RawParams): DiscoveryQuery {
  const result: DiscoveryQuery = {};

  const category = readString(params, "category");
  if (category !== undefined) {
    if (!isCategory(category)) {
      throw new ValidationError(
        `Invalid category "${category}"; expected one of ${CATEGORIES.join(", ")}`,
        "category",
      );
    }
    result.category = category;
  }

  const status = readString(params, "status");
  if (status !== undefined) {
    if (!isMarketStatus(status)) {
      throw new ValidationError(
        `Invalid status "${status}"; expected one of ${MARKET_STATUSES.join(", ")}`,
        "status",
      );
    }
    result.status = status;
  }

  const q = readString(params, "q");
  if (q !== undefined) {
    if (q.length > MAX_Q_LENGTH) {
      throw new ValidationError(`Query parameter "q" must be at most ${MAX_Q_LENGTH} chars`, "q");
    }
    const trimmed = q.trim();
    if (trimmed.length > 0) result.q = trimmed;
  }

  const sort = readString(params, "sort");
  if (sort !== undefined) {
    if (!SORT_KEYS.includes(sort as MarketSortKey)) {
      throw new ValidationError(
        `Invalid sort "${sort}"; expected one of ${SORT_KEYS.join(", ")}`,
        "sort",
      );
    }
    result.sort = sort as MarketSortKey;
  }

  const order = readString(params, "order");
  if (order !== undefined) {
    if (!SORT_ORDERS.includes(order as SortOrder)) {
      throw new ValidationError(
        `Invalid order "${order}"; expected one of ${SORT_ORDERS.join(", ")}`,
        "order",
      );
    }
    result.order = order as SortOrder;
  }

  const limit = readInt(params, "limit", 1, MAX_LIMIT);
  if (limit !== undefined) result.limit = limit;

  const offset = readInt(params, "offset", 0, Number.MAX_SAFE_INTEGER);
  if (offset !== undefined) result.offset = offset;

  return result;
}

/** Validate a path id is a non-empty UUID-shaped string. Throws 400 otherwise. */
export function parseMarketId(params: RawParams): string {
  const id = readString(params, "id");
  if (id === undefined || id.trim().length === 0) {
    throw new ValidationError(`Path parameter "id" is required`, "id");
  }
  const trimmed = id.trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(trimmed)) {
    throw new ValidationError(`Path parameter "id" must be a UUID`, "id");
  }
  return trimmed;
}

/**
 * Validate the canonical-event path id (UUID). Shares the same UUID shape as
 * {@link parseMarketId}; kept as a named parser so the comparison route reads
 * clearly and its error field is unambiguous.
 */
export function parseCanonicalEventId(params: RawParams): string {
  return parseMarketId(params);
}

/**
 * Validate + coerce the `GET /api/canonical-events` query: an optional
 * `category` filter validated against the normalized {@link Category} set.
 * Throws 400 on an invalid category.
 */
export function parseCanonicalEventsQuery(params: RawParams): CanonicalEventsQuery {
  const result: CanonicalEventsQuery = {};
  const category = readString(params, "category");
  if (category !== undefined) {
    if (!isCategory(category)) {
      throw new ValidationError(
        `Invalid category "${category}"; expected one of ${CATEGORIES.join(", ")}`,
        "category",
      );
    }
    result.category = category;
  }
  return result;
}

/** Max signals returned by `GET /api/signals` in a single response. */
const MAX_SIGNALS_LIMIT = 200;

/**
 * Validate + coerce the `GET /api/signals` query: an optional `limit`
 * (1..{@link MAX_SIGNALS_LIMIT}) bounding the ranked list. Throws 400 on a
 * non-integer / out-of-range limit.
 */
export function parseSignalsQuery(params: RawParams): SignalsQuery {
  const result: SignalsQuery = {};
  const limit = readInt(params, "limit", 1, MAX_SIGNALS_LIMIT);
  if (limit !== undefined) result.limit = limit;
  return result;
}

/** Validate an ISO-8601 timestamp param, returning its canonical ISO form. */
function readIso(params: RawParams, key: string): string | undefined {
  const raw = readString(params, key);
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Query parameter "${key}" must be an ISO 8601 timestamp`, key);
  }
  return date.toISOString();
}

/**
 * Validate + coerce the price-history query. `from`/`to` default to the last
 * 24h when omitted; `from` must be <= `to`; `interval` (if present) must be one
 * of the supported downsampling buckets. Throws 400 on invalid input.
 */
export function parseHistoryQuery(params: RawParams, now: () => number = Date.now): HistoryQuery {
  const nowMs = now();
  const to = readIso(params, "to") ?? new Date(nowMs).toISOString();
  const from = readIso(params, "from") ?? new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();

  if (new Date(from).getTime() > new Date(to).getTime()) {
    throw new ValidationError(`"from" must be less than or equal to "to"`, "from");
  }

  const interval = readString(params, "interval");
  const range: TimeRange = { from, to };
  if (interval !== undefined && interval.trim().length > 0) {
    if (!INTERVALS.includes(interval as NonNullable<TimeRange["interval"]>)) {
      throw new ValidationError(
        `Invalid interval "${interval}"; expected one of ${INTERVALS.join(", ")}`,
        "interval",
      );
    }
    range.interval = interval as TimeRange["interval"];
  }

  return { range };
}

/** Shared UUID shape check (matches {@link parseMarketId}). */
function isUuidShaped(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
}

/**
 * Validate the watchlist item path id (`DELETE /api/watchlist/{itemId}`): a
 * non-empty UUID-shaped string. Throws 400 otherwise (error field `itemId`).
 */
export function parseWatchlistItemId(params: RawParams): string {
  const id = readString(params, "itemId");
  if (id === undefined || id.trim().length === 0) {
    throw new ValidationError(`Path parameter "itemId" is required`, "itemId");
  }
  const trimmed = id.trim();
  if (!isUuidShaped(trimmed)) {
    throw new ValidationError(`Path parameter "itemId" must be a UUID`, "itemId");
  }
  return trimmed;
}

/**
 * Validate + coerce the `POST /api/watchlist` body (Requirement 5.1): a
 * `targetType` in `('market','canonicalEvent')` and a UUID-shaped `targetId`.
 * The body is the loosely-typed parsed JSON; throws {@link ValidationError}
 * (→ 400) on any bad/missing field so malformed input never reaches storage.
 */
export function parseAddWatchlistBody(body: unknown): AddWatchlistBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError(`Request body must be a JSON object`, "body");
  }
  const obj = body as RawParams;

  const targetType = obj.targetType;
  if (targetType === undefined || targetType === null) {
    throw new ValidationError(`Field "targetType" is required`, "targetType");
  }
  if (typeof targetType !== "string" || !isWatchlistTargetType(targetType)) {
    throw new ValidationError(
      `Invalid targetType "${String(targetType)}"; expected one of market, canonicalEvent`,
      "targetType",
    );
  }

  const targetId = obj.targetId;
  if (targetId === undefined || targetId === null) {
    throw new ValidationError(`Field "targetId" is required`, "targetId");
  }
  if (typeof targetId !== "string") {
    throw new ValidationError(`Field "targetId" must be a string`, "targetId");
  }
  const trimmed = targetId.trim();
  if (!isUuidShaped(trimmed)) {
    throw new ValidationError(`Field "targetId" must be a UUID`, "targetId");
  }

  return { targetType, targetId: trimmed };
}

/** All valid alert rule types, for the validation error message. */
const ALERT_RULE_TYPE_NAMES = ["thresholdCross", "spreadWiden"] as const;

/**
 * Validate the alert path id (`DELETE /api/alerts/{alertId}`): a non-empty
 * UUID-shaped string. Throws 400 otherwise (error field `alertId`).
 */
export function parseAlertId(params: RawParams): string {
  const id = readString(params, "alertId");
  if (id === undefined || id.trim().length === 0) {
    throw new ValidationError(`Path parameter "alertId" is required`, "alertId");
  }
  const trimmed = id.trim();
  if (!isUuidShaped(trimmed)) {
    throw new ValidationError(`Path parameter "alertId" must be a UUID`, "alertId");
  }
  return trimmed;
}

/**
 * Validate + coerce the `POST /api/alerts` body (Requirement 5.2): a
 * `targetType` in `('market','canonicalEvent')`, a UUID-shaped `targetId`, a
 * `ruleType` in `('thresholdCross','spreadWiden')`, and a `params` object whose
 * shape matches `ruleType` (`thresholdCross` → `{ threshold: number in [0,1] }`,
 * `spreadWiden` → `{ minGap: number >= 0 }`). The body is the loosely-typed
 * parsed JSON; throws {@link ValidationError} (→ 400) on any bad/missing field
 * so malformed input never reaches storage.
 */
export function parseCreateAlertBody(body: unknown): CreateAlertBody {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError(`Request body must be a JSON object`, "body");
  }
  const obj = body as RawParams;

  const targetType = obj.targetType;
  if (targetType === undefined || targetType === null) {
    throw new ValidationError(`Field "targetType" is required`, "targetType");
  }
  if (typeof targetType !== "string" || !isWatchlistTargetType(targetType)) {
    throw new ValidationError(
      `Invalid targetType "${String(targetType)}"; expected one of market, canonicalEvent`,
      "targetType",
    );
  }

  const targetId = obj.targetId;
  if (targetId === undefined || targetId === null) {
    throw new ValidationError(`Field "targetId" is required`, "targetId");
  }
  if (typeof targetId !== "string") {
    throw new ValidationError(`Field "targetId" must be a string`, "targetId");
  }
  const trimmedTargetId = targetId.trim();
  if (!isUuidShaped(trimmedTargetId)) {
    throw new ValidationError(`Field "targetId" must be a UUID`, "targetId");
  }

  const ruleType = obj.ruleType;
  if (ruleType === undefined || ruleType === null) {
    throw new ValidationError(`Field "ruleType" is required`, "ruleType");
  }
  if (typeof ruleType !== "string" || !isAlertRuleType(ruleType)) {
    throw new ValidationError(
      `Invalid ruleType "${String(ruleType)}"; expected one of ${ALERT_RULE_TYPE_NAMES.join(", ")}`,
      "ruleType",
    );
  }

  const params = obj.params;
  if (params === undefined || params === null) {
    throw new ValidationError(`Field "params" is required`, "params");
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new ValidationError(`Field "params" must be an object`, "params");
  }
  if (!isValidAlertRuleParams(ruleType, params)) {
    const expectation =
      ruleType === "thresholdCross" ? `{ threshold: number in [0, 1] }` : `{ minGap: number >= 0 }`;
    throw new ValidationError(
      `Invalid params for ruleType "${ruleType}"; expected ${expectation}`,
      "params",
    );
  }

  return { targetType, targetId: trimmedTargetId, ruleType, params };
}
