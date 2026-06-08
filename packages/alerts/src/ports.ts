/**
 * Injectable ports for the alert engine (design.md "Component 6: Alert /
 * Watchlist Service"). The {@link AlertEvaluator} depends only on these narrow
 * interfaces — never on `@pma/storage` concretes — so it is unit-testable with
 * in-memory fakes (a fake rules source + a fake publisher) and the real wiring
 * (SQL-backed rules lookup + Redis {@link import("@pma/storage").FanoutPublisher})
 * is supplied by the orchestrator.
 */

import type { AlertRule, WatchlistTargetType } from "@pma/core";

/**
 * Looks up the alert rules registered against a single target (a `market` or a
 * `canonicalEvent`). Implementations SHOULD return only the **active** rules for
 * the target (Requirement 5.2 — an `active` flag gates evaluation; 5.4 — deleted
 * rules are gone), but the {@link AlertEvaluator} also defensively filters by
 * `active`, so a source that over-returns will not cause an inactive rule to
 * fire.
 *
 * May be synchronous or async: a SQL-backed implementation queries
 * `alert_rule WHERE target_type = $1 AND target_id = $2 AND active`, while a
 * fake simply returns an array. This is the seam the design's "evaluate rules
 * against incoming price updates" responsibility plugs into.
 */
export interface AlertRulesSource {
  /**
   * Return the alert rules for `(targetType, targetId)`. SHOULD be limited to
   * active rules; the evaluator re-checks `active` regardless.
   */
  findActiveRules(
    targetType: WatchlistTargetType,
    targetId: string,
  ): AlertRule[] | Promise<AlertRule[]>;
}

/**
 * Dispatches a fired alert as a notification on the shared alerts fan-out
 * channel (`chan:alerts`). Structurally satisfied by `@pma/storage`'s
 * `FanoutPublisher` (its `publishAlert(payload)` method), so the orchestrator
 * can pass the same publisher the ingestion `onTick` path uses.
 *
 * The published `payload` is relayed verbatim by the API gateway's WS fan-out
 * (task 7.4) to clients subscribed to the `alerts` channel (Requirement 9.2);
 * because the payload carries `userId`, the WS layer / clients can route each
 * notification to its owner.
 */
export interface AlertPublisher {
  /** Publish a notification payload to the alerts channel; resolves to the subscriber count. */
  publishAlert<T>(payload: T): Promise<number>;
}
