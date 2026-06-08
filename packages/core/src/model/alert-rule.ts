/**
 * Alert-rule domain types (design.md "Component 6: Alert / Watchlist Service" +
 * the `alert_rule` table). An {@link AlertRule} is a user-scoped rule that fires
 * a notification when a tracked target's probability crosses a threshold
 * (`thresholdCross`) or a canonical event's cross-platform spread widens beyond
 * a minimum gap (`spreadWiden`). The rule is persisted with its parameters and
 * an `active` flag (Requirement 5.2); evaluation/dispatch is a separate concern
 * (task 8.3).
 *
 * Unlike a watchlist entry, an alert rule is NOT deduplicated — a user may
 * create multiple rules for the same target with different parameters.
 *
 * Pure types only (no I/O), consistent with the rest of `@pma/core`. The target
 * type mirrors the watchlist's (`market` | `canonicalEvent`), so we reuse
 * {@link WatchlistTargetType} rather than redeclaring the closed set.
 */

import type { WatchlistTargetType } from "./watchlist.js";

/**
 * What kind of movement an alert watches (mirrors the `alert_rule.rule_type`
 * CHECK constraint, design.md "Storage Schemas"):
 *
 * - `thresholdCross`: a market's implied probability crosses a `threshold`.
 * - `spreadWiden`: a canonical event's cross-platform spread widens beyond a
 *   `minGap`.
 */
export type AlertRuleType = "thresholdCross" | "spreadWiden";

/** All valid {@link AlertRuleType} values (for validation/iteration). */
export const ALERT_RULE_TYPES: readonly AlertRuleType[] = ["thresholdCross", "spreadWiden"];

/** Type guard: is `value` a valid {@link AlertRuleType}? */
export function isAlertRuleType(value: unknown): value is AlertRuleType {
  return value === "thresholdCross" || value === "spreadWiden";
}

/**
 * Parameters for a `thresholdCross` rule: fire when a market's implied
 * probability crosses `threshold`. As a probability, `threshold` is bounded to
 * `[0, 1]` (consistent with the normalized-model probability bounds).
 */
export interface ThresholdCrossParams {
  /** Probability boundary in `[0, 1]`. */
  threshold: number;
}

/**
 * Parameters for a `spreadWiden` rule: fire when a canonical event's
 * cross-platform implied-probability gap widens to at least `minGap`. A gap is
 * a non-negative magnitude, so `minGap >= 0`.
 */
export interface SpreadWidenParams {
  /** Minimum cross-platform probability gap (`>= 0`) that triggers the alert. */
  minGap: number;
}

/** The parameter object for an alert rule, discriminated by its rule type. */
export type AlertRuleParams = ThresholdCrossParams | SpreadWidenParams;

/**
 * A user-scoped alert rule. `userId` identifies the owner (an authenticated
 * user — Requirement 9.4); `targetType` + `targetId` identify the watched
 * market or canonical event; `ruleType` + `params` define the trigger; `active`
 * gates evaluation (Requirement 5.2). Persisted in the `alert_rule` table.
 */
export interface AlertRule {
  /** Internal UUID assigned by the persistence layer. */
  id: string;
  /** Owning user's id (the authenticated identity). */
  userId: string;
  /** Whether the target is a `market` or a `canonicalEvent`. */
  targetType: WatchlistTargetType;
  /** The watched target's internal UUID. */
  targetId: string;
  /** Which kind of movement fires this rule. */
  ruleType: AlertRuleType;
  /** The rule's parameters (shape determined by {@link ruleType}). */
  params: AlertRuleParams;
  /** Whether the rule is currently evaluated (Requirement 5.2). */
  active: boolean;
  /** When the rule was created (ISO 8601). */
  createdAt: string;
}

/** Lower probability bound for a `thresholdCross` threshold. */
export const ALERT_THRESHOLD_MIN = 0;
/** Upper probability bound for a `thresholdCross` threshold. */
export const ALERT_THRESHOLD_MAX = 1;

/** Is `value` a finite JS number (not NaN/Infinity)? */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Type guard for {@link ThresholdCrossParams}: a `threshold` that is a finite
 * number within `[0, 1]`.
 */
export function isThresholdCrossParams(value: unknown): value is ThresholdCrossParams {
  if (value === null || typeof value !== "object") return false;
  const threshold = (value as Record<string, unknown>).threshold;
  return (
    isFiniteNumber(threshold) &&
    threshold >= ALERT_THRESHOLD_MIN &&
    threshold <= ALERT_THRESHOLD_MAX
  );
}

/**
 * Type guard for {@link SpreadWidenParams}: a `minGap` that is a finite,
 * non-negative number.
 */
export function isSpreadWidenParams(value: unknown): value is SpreadWidenParams {
  if (value === null || typeof value !== "object") return false;
  const minGap = (value as Record<string, unknown>).minGap;
  return isFiniteNumber(minGap) && minGap >= 0;
}

/**
 * Validate that `params` matches the shape required by `ruleType`
 * (Requirement 5.2). Returns `true` for valid `thresholdCross`/`spreadWiden`
 * params; `false` otherwise. Used by the storage layer and API validators to
 * reject bad input before persistence.
 */
export function isValidAlertRuleParams(
  ruleType: AlertRuleType,
  params: unknown,
): params is AlertRuleParams {
  return ruleType === "thresholdCross"
    ? isThresholdCrossParams(params)
    : isSpreadWidenParams(params);
}

/**
 * Validate and normalize `params` for a given `ruleType`, returning a clean
 * params object containing ONLY the relevant field (`threshold` or `minGap`) so
 * the persisted JSONB is canonical and free of extraneous keys. Throws an
 * `Error` when `ruleType` is unknown or `params` does not match the required
 * shape — callers that need an HTTP 400 should validate first (see the API
 * validators) so they can attach a field name.
 */
export function normalizeAlertRuleParams(
  ruleType: AlertRuleType,
  params: unknown,
): AlertRuleParams {
  if (ruleType === "thresholdCross") {
    if (!isThresholdCrossParams(params)) {
      throw new Error(`Invalid thresholdCross params; expected { threshold: number in [0, 1] }`);
    }
    return { threshold: params.threshold };
  }
  if (ruleType === "spreadWiden") {
    if (!isSpreadWidenParams(params)) {
      throw new Error(`Invalid spreadWiden params; expected { minGap: number >= 0 }`);
    }
    return { minGap: params.minGap };
  }
  throw new Error(`Unknown alert rule type "${String(ruleType)}"`);
}
