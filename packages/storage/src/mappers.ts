/**
 * Conversions between Postgres rows and `@pma/core` domain types.
 *
 * Postgres returns `NUMERIC` columns as strings (to avoid float precision loss)
 * and `TIMESTAMPTZ` columns as JS `Date` objects, while the domain model uses
 * `number | null` and ISO 8601 strings. These helpers centralize the
 * conversions plus JSONB (resolution criteria) (de)serialization and explicit
 * null handling.
 */

import type {
  Market,
  Outcome,
  PricePoint,
  CanonicalEvent,
  Category,
  ResolutionCriteria,
  WatchlistItem,
  WatchlistTargetType,
  AlertRule,
  AlertRuleParams,
  AlertRuleType,
} from "@pma/core";

/** A `market` table row (as returned by `SELECT *` / `RETURNING *`). */
export interface MarketRow {
  id: string;
  source_id: string;
  event_id: string | null;
  canonical_event_id: string | null;
  external_id: string;
  question: string;
  category: string;
  status: string;
  volume_24h: string | null;
  liquidity: string | null;
  spread: string | null;
  resolution_criteria: unknown;
  resolution_mismatch: boolean;
  updated_at: Date | string;
}

/** An `outcome` table row. */
export interface OutcomeRow {
  id: string;
  market_id: string;
  label: string;
  token_id: string | null;
  implied_prob: string | null;
  last_price: string | null;
}

/** A `price_point` table row. */
export interface PricePointRow {
  market_id: string;
  outcome_id: string;
  ts: Date | string;
  price: string;
  volume: string | null;
}

/** A `canonical_event` table row. */
export interface CanonicalEventRow {
  id: string;
  title: string;
  category: string;
  subject_entity: string | null;
  threshold_value: string | null;
  target_date: Date | string | null;
}

/** A `watchlist_item` table row. */
export interface WatchlistItemRow {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string;
  created_at: Date | string;
}

/** An `alert_rule` table row. */
export interface AlertRuleRow {
  id: string;
  user_id: string;
  target_type: string;
  target_id: string;
  rule_type: string;
  params: unknown;
  active: boolean;
  created_at: Date | string;
}

/**
 * Convert a Postgres `NUMERIC` value (returned as a string) to a `number`,
 * preserving SQL `NULL` as `null`. Unparseable input maps to `null`.
 */
export function numericToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (value.length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Convert a required Postgres `NUMERIC` value to a `number`. Throws when the
 * value is null/unparseable (used for `NOT NULL` columns such as
 * `price_point.price`).
 */
export function requiredNumber(value: unknown, column: string): number {
  const parsed = numericToNumber(value);
  if (parsed === null) {
    throw new Error(`Expected a numeric value for column "${column}"`);
  }
  return parsed;
}

/**
 * Convert a Postgres `TIMESTAMPTZ` value (a JS `Date` or ISO string) to an ISO
 * 8601 string, preserving `NULL` as `null`.
 */
export function timestampToIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** Convert a required `TIMESTAMPTZ` value to an ISO 8601 string. */
export function requiredTimestampToIso(value: unknown, column: string): string {
  const iso = timestampToIso(value);
  if (iso === null) {
    throw new Error(`Expected a timestamp value for column "${column}"`);
  }
  return iso;
}

/**
 * Reconstruct a {@link ResolutionCriteria} from a JSONB value. `pg` parses
 * JSONB into a plain object on read; this normalizes the structured fields and
 * always preserves a `raw` record (Requirement 10.3).
 */
export function mapResolutionCriteria(value: unknown): ResolutionCriteria {
  const obj = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const asStringOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const raw =
    obj.raw !== null && typeof obj.raw === "object" ? (obj.raw as Record<string, unknown>) : {};
  return {
    dataSource: asStringOrNull(obj.dataSource),
    cutoffTime: asStringOrNull(obj.cutoffTime),
    rounding: asStringOrNull(obj.rounding),
    raw,
  };
}

/** Serialize a {@link ResolutionCriteria} to a JSON string for a `jsonb` param. */
export function serializeResolutionCriteria(criteria: ResolutionCriteria): string {
  return JSON.stringify(criteria);
}

/** Map a `market` row to a domain {@link Market} (drops denormalized columns). */
export function mapMarketRow(row: MarketRow): Market {
  return {
    id: row.id,
    sourceId: row.source_id,
    eventId: row.event_id,
    canonicalEventId: row.canonical_event_id,
    externalId: row.external_id,
    question: row.question,
    status: row.status as Market["status"],
    volume24h: numericToNumber(row.volume_24h),
    liquidity: numericToNumber(row.liquidity),
    spread: numericToNumber(row.spread),
    resolutionCriteria: mapResolutionCriteria(row.resolution_criteria),
  };
}

/** Map an `outcome` row to a domain {@link Outcome}. */
export function mapOutcomeRow(row: OutcomeRow): Outcome {
  return {
    id: row.id,
    marketId: row.market_id,
    label: row.label,
    tokenId: row.token_id,
    impliedProb: numericToNumber(row.implied_prob),
    lastPrice: numericToNumber(row.last_price),
  };
}

/** Map a `price_point` row to a domain {@link PricePoint}. */
export function mapPricePointRow(row: PricePointRow): PricePoint {
  return {
    marketId: row.market_id,
    outcomeId: row.outcome_id,
    ts: requiredTimestampToIso(row.ts, "ts"),
    price: requiredNumber(row.price, "price"),
    volume: numericToNumber(row.volume),
  };
}

/** Map a `canonical_event` row to a domain {@link CanonicalEvent}. */
export function mapCanonicalEventRow(row: CanonicalEventRow): CanonicalEvent {
  return {
    id: row.id,
    title: row.title,
    category: row.category as Category,
    subjectEntity: row.subject_entity,
    thresholdValue: numericToNumber(row.threshold_value),
    targetDate: timestampToIso(row.target_date),
  };
}

/** Map a `watchlist_item` row to a domain {@link WatchlistItem}. */
export function mapWatchlistItemRow(row: WatchlistItemRow): WatchlistItem {
  return {
    id: row.id,
    userId: row.user_id,
    targetType: row.target_type as WatchlistTargetType,
    targetId: row.target_id,
    createdAt: requiredTimestampToIso(row.created_at, "created_at"),
  };
}

/**
 * Reconstruct an {@link AlertRuleParams} from a JSONB value, keyed by the
 * row's `rule_type`. `pg` parses JSONB into a plain object on read; this keeps
 * only the field relevant to the rule type so the domain object is canonical.
 * Falls back to `0` for a missing/non-numeric stored value (rows are validated
 * before insert, so this is defensive).
 */
export function mapAlertRuleParams(ruleType: AlertRuleType, value: unknown): AlertRuleParams {
  const obj = value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const asNumber = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (ruleType === "thresholdCross") {
    return { threshold: asNumber(obj.threshold) };
  }
  return { minGap: asNumber(obj.minGap) };
}

/** Map an `alert_rule` row to a domain {@link AlertRule}. */
export function mapAlertRuleRow(row: AlertRuleRow): AlertRule {
  const ruleType = row.rule_type as AlertRuleType;
  return {
    id: row.id,
    userId: row.user_id,
    targetType: row.target_type as WatchlistTargetType,
    targetId: row.target_id,
    ruleType,
    params: mapAlertRuleParams(ruleType, row.params),
    active: row.active,
    createdAt: requiredTimestampToIso(row.created_at, "created_at"),
  };
}
