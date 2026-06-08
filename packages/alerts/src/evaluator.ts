/**
 * The alert engine (design.md "Component 6: Alert / Watchlist Service" —
 * "Evaluate rules against incoming price updates" + "Dispatch notifications via
 * the API gateway"). Given an incoming price or spread update, it finds the
 * relevant **active** rules for the target, decides which ones fire, and
 * dispatches a user-addressed {@link AlertNotification} for each via the alerts
 * fan-out channel (Requirements 5.3, 9.2).
 *
 * ## Dispatch path
 *
 * ```text
 * ingestion onTick / spread-update
 *   → AlertEvaluator.evaluatePriceUpdate / evaluateSpreadUpdate
 *     → AlertRulesSource.findActiveRules(target)        (SQL: active rules for the target)
 *     → for each firing rule: AlertPublisher.publishAlert(notification)
 *       → Redis chan:alerts                              (@pma/storage FanoutPublisher)
 *         → API WS fan-out (task 7.4)                    (relays the alert envelope)
 *           → clients subscribed to the "alerts" channel (Req 9.2)
 * ```
 *
 * Because each notification carries `userId`, the shared alerts channel can be
 * routed per-user by the WS layer / clients.
 *
 * ## Integration point
 *
 * The engine is intentionally decoupled from ingestion: the orchestrator that
 * runs the design's `onTick` (hot-cache write + idempotent price write +
 * `publishPrice`) also knows the market's previous vs new Yes implied
 * probability, so it calls {@link AlertEvaluator.evaluatePriceUpdate} with
 * `(marketId, prev, next)`. The spread/signal recompute path (matching engine)
 * calls {@link AlertEvaluator.evaluateSpreadUpdate} with `(canonicalEventId,
 * prevGap, newGap)`. Neither path needs to change here; this module only
 * provides the clean API and the firing/crossing semantics.
 *
 * ## Crossing semantics
 *
 * - **thresholdCross** fires only on an *actual crossing* of the threshold,
 *   never on merely sitting above/below it. With a previous probability `prev`
 *   and a new probability `next` and a rule boundary `threshold`:
 *   - up-cross:   `prev < threshold && next >= threshold`
 *   - down-cross: `prev > threshold && next <= threshold`
 *   These are mutually exclusive. **No previous value (`prev === null`) → no
 *   alert**: a single first observation cannot "cross" anything (we do not
 *   fabricate a baseline). Likewise, when `prev === threshold` exactly, moving
 *   off the boundary is not treated as a crossing (it started *on* the
 *   boundary, not on one side of it).
 *
 * - **spreadWiden** fires when the gap *widens past* the user's `minGap`:
 *   `prevGap <= minGap && newGap > minGap`. Keying on "widened past" (rather
 *   than the level test `newGap > minGap`) means the rule fires once on the
 *   transition and does **not** re-fire on subsequent updates while the gap
 *   stays wide (`prevGap > minGap`), avoiding notification spam. A first
 *   observation with no prior gap uses `prevGap = 0` (see
 *   {@link AlertEvaluator.evaluateSpreadUpdate}).
 */

import { isSpreadWidenParams, isThresholdCrossParams, type AlertRule } from "@pma/core";
import type { AlertPublisher, AlertRulesSource } from "./ports.js";
import type {
  AlertNotification,
  SpreadWidenDetails,
  ThresholdCrossDetails,
} from "./notification.js";

/** Injected dependencies for {@link AlertEvaluator}. */
export interface AlertEvaluatorDeps {
  /** Finds the active alert rules registered against a target. */
  rulesSource: AlertRulesSource;
  /** Dispatches fired notifications to the alerts fan-out channel. */
  publisher: AlertPublisher;
}

/**
 * Decide whether a `thresholdCross` boundary was actually crossed between
 * `prev` and `next`, and in which direction. Returns `null` when there is no
 * crossing (including the no-prior-value case, handled by the caller passing
 * `prev === null`).
 */
export function detectThresholdCross(
  prev: number,
  next: number,
  threshold: number,
): "up" | "down" | null {
  if (prev < threshold && next >= threshold) return "up";
  if (prev > threshold && next <= threshold) return "down";
  return null;
}

/**
 * Decide whether a cross-platform gap *widened past* `minGap` between
 * `prevGap` and `newGap`. True only on the transition (`prevGap <= minGap <
 * newGap`), so a gap that stays wide does not re-fire.
 */
export function detectSpreadWiden(prevGap: number, newGap: number, minGap: number): boolean {
  return prevGap <= minGap && newGap > minGap;
}

/**
 * Evaluates alert rules against incoming updates and dispatches notifications.
 * Constructed with a {@link AlertRulesSource} (active-rule lookup by target) and
 * an {@link AlertPublisher} (alerts-channel dispatch); both are narrow ports so
 * the engine is unit-testable with fakes.
 */
export class AlertEvaluator {
  private readonly rulesSource: AlertRulesSource;
  private readonly publisher: AlertPublisher;

  constructor(deps: AlertEvaluatorDeps) {
    this.rulesSource = deps.rulesSource;
    this.publisher = deps.publisher;
  }

  /**
   * Evaluate `thresholdCross` rules for a market whose Yes implied probability
   * moved from `prev` to `next`, dispatching a notification for each rule whose
   * threshold was actually crossed (Requirement 5.3).
   *
   * @param marketId The internal market id (the rules' `targetId`).
   * @param prev The previous Yes implied probability, or `null` if this is the
   *   first observation (no prior value → nothing can cross → no alert).
   * @param next The new Yes implied probability from this update.
   * @returns The notifications that were dispatched (empty when nothing fired).
   */
  async evaluatePriceUpdate(
    marketId: string,
    prev: number | null,
    next: number,
  ): Promise<AlertNotification[]> {
    // A single observation with no previous value cannot cross a threshold.
    if (prev === null) return [];

    const rules = await this.rulesSource.findActiveRules("market", marketId);
    const notifications: AlertNotification[] = [];

    for (const rule of rules) {
      // Only active thresholdCross rules participate in a price update.
      if (!rule.active) continue;
      if (rule.ruleType !== "thresholdCross") continue;
      if (!isThresholdCrossParams(rule.params)) continue;

      const { threshold } = rule.params;
      const direction = detectThresholdCross(prev, next, threshold);
      if (direction === null) continue;

      const details: ThresholdCrossDetails = {
        kind: "thresholdCross",
        threshold,
        previous: prev,
        current: next,
        direction,
      };
      notifications.push(this.toNotification(rule, details));
    }

    await this.dispatchAll(notifications);
    return notifications;
  }

  /**
   * Evaluate `spreadWiden` rules for a canonical event whose cross-platform gap
   * moved from `prevGap` to `newGap`, dispatching a notification for each rule
   * whose `minGap` the spread newly widened past (Requirement 5.3).
   *
   * @param canonicalEventId The internal canonical-event id (the rules' `targetId`).
   * @param prevGap The previous cross-platform gap. For a first observation with
   *   no prior gap, pass `0` (anything `<= minGap`), so a spread that opens
   *   already-wide fires once.
   * @param newGap The new cross-platform gap from this update.
   * @returns The notifications that were dispatched (empty when nothing fired).
   */
  async evaluateSpreadUpdate(
    canonicalEventId: string,
    prevGap: number,
    newGap: number,
  ): Promise<AlertNotification[]> {
    const rules = await this.rulesSource.findActiveRules("canonicalEvent", canonicalEventId);
    const notifications: AlertNotification[] = [];

    for (const rule of rules) {
      // Only active spreadWiden rules participate in a spread update.
      if (!rule.active) continue;
      if (rule.ruleType !== "spreadWiden") continue;
      if (!isSpreadWidenParams(rule.params)) continue;

      const { minGap } = rule.params;
      if (!detectSpreadWiden(prevGap, newGap, minGap)) continue;

      const details: SpreadWidenDetails = {
        kind: "spreadWiden",
        minGap,
        previousGap: prevGap,
        currentGap: newGap,
      };
      notifications.push(this.toNotification(rule, details));
    }

    await this.dispatchAll(notifications);
    return notifications;
  }

  /** Build a user-addressed notification from a firing rule + its details. */
  private toNotification(
    rule: AlertRule,
    details: AlertNotification["details"],
  ): AlertNotification {
    return {
      alertId: rule.id,
      userId: rule.userId,
      ruleType: rule.ruleType,
      targetType: rule.targetType,
      targetId: rule.targetId,
      details,
    };
  }

  /** Publish every fired notification to the alerts fan-out channel. */
  private async dispatchAll(notifications: AlertNotification[]): Promise<void> {
    for (const notification of notifications) {
      await this.publisher.publishAlert(notification);
    }
  }
}
