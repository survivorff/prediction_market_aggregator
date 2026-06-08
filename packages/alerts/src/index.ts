/**
 * @pma/alerts — Watchlist + movement alert engine.
 *
 * Evaluates user alert rules against incoming price / spread updates and
 * dispatches user-addressed notifications via the alerts fan-out channel
 * (`chan:alerts`), which the API gateway's WebSocket fan-out relays to
 * subscribed clients (Requirements 5.3, 9.2). Watchlist + alert-rule
 * persistence lives in `@pma/storage` (tasks 8.1, 8.2); this package owns the
 * evaluation/dispatch engine (task 8.3).
 *
 * Dispatch path:
 *   AlertEvaluator → AlertPublisher.publishAlert → Redis chan:alerts
 *     → API WS fan-out (task 7.4) → clients subscribed to the "alerts" channel.
 */

export const ALERTS_PACKAGE = "@pma/alerts" as const;

// The alert engine: evaluates rules against price/spread updates and dispatches.
export { AlertEvaluator, detectThresholdCross, detectSpreadWiden } from "./evaluator.js";
export type { AlertEvaluatorDeps } from "./evaluator.js";

// Injectable ports (fakeable for tests; satisfied by @pma/storage in production).
export type { AlertRulesSource, AlertPublisher } from "./ports.js";

// The notification payload published to the alerts channel.
export type {
  AlertNotification,
  AlertNotificationDetails,
  ThresholdCrossDetails,
  SpreadWidenDetails,
} from "./notification.js";
