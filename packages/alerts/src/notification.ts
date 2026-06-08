/**
 * The notification payload an {@link import("./evaluator.js").AlertEvaluator}
 * dispatches when a rule fires (design.md "Component 6: Alert / Watchlist
 * Service" — "Dispatch notifications via the API gateway"). It is the `payload`
 * of the `alert`-typed fan-out envelope published to `chan:alerts` and relayed
 * verbatim by the API WS fan-out (task 7.4) to clients subscribed to the
 * `alerts` channel (Requirement 9.2).
 *
 * The payload is **user-addressed** — it always carries `userId` — so the WS
 * layer / clients can route each notification to its owner (the alerts channel
 * is shared across users). It also carries enough detail (the triggering
 * rule's identity, the boundary, and the previous/new observation) for a client
 * to render the alert without a follow-up read.
 */

import type { AlertRuleType, WatchlistTargetType } from "@pma/core";

/**
 * Details specific to a fired `thresholdCross` rule: the market's implied
 * probability moved from `previous` to `current`, crossing `threshold`.
 * `direction` records which way it crossed (`up`: rose through the threshold;
 * `down`: fell through it).
 */
export interface ThresholdCrossDetails {
  kind: "thresholdCross";
  /** The probability boundary that was crossed (`[0, 1]`). */
  threshold: number;
  /** The implied probability before this update. */
  previous: number;
  /** The implied probability after this update (the value that crossed). */
  current: number;
  /** Which way the probability crossed the threshold. */
  direction: "up" | "down";
}

/**
 * Details specific to a fired `spreadWiden` rule: a canonical event's
 * cross-platform gap widened from `previousGap` to `currentGap`, crossing above
 * the user's `minGap`.
 */
export interface SpreadWidenDetails {
  kind: "spreadWiden";
  /** The user's minimum gap that was exceeded on this update (`>= 0`). */
  minGap: number;
  /** The cross-platform gap before this update. */
  previousGap: number;
  /** The cross-platform gap after this update (the value that widened past `minGap`). */
  currentGap: number;
}

/** The rule-type-specific detail block carried by an {@link AlertNotification}. */
export type AlertNotificationDetails = ThresholdCrossDetails | SpreadWidenDetails;

/**
 * A user-addressed alert notification published to the alerts fan-out channel.
 * `alertId`/`userId`/`ruleType`/`targetType`/`targetId` identify the firing
 * rule and its owner; `details` carries the rule-type-specific evidence
 * (threshold + previous/current, or minGap + previous/current gap).
 */
export interface AlertNotification {
  /** The id of the {@link import("@pma/core").AlertRule} that fired. */
  alertId: string;
  /** The owning user's id — makes the notification routable on the shared channel. */
  userId: string;
  /** Which kind of movement fired (mirrors the rule's `ruleType`). */
  ruleType: AlertRuleType;
  /** Whether the watched target is a `market` or a `canonicalEvent`. */
  targetType: WatchlistTargetType;
  /** The watched target's internal id. */
  targetId: string;
  /** Rule-type-specific firing evidence. */
  details: AlertNotificationDetails;
}
