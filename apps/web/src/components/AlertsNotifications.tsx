"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { FanoutAlertPayload, FanoutMessage } from "../lib/dto";
import { titleCase } from "../lib/format";
import { useFanout } from "../lib/useFanout";
import type { WebSocketFactory } from "../lib/fanout-client";

export interface AlertsNotificationsProps {
  /** Enable the alerts fan-out subscription. Default true. */
  enabled?: boolean;
  /** Injectable WebSocket factory for tests; defaults to the global. */
  socketFactory?: WebSocketFactory;
  /** Cap on the number of recent notifications kept in view. Default 20. */
  max?: number;
}

/** A received alert notification plus a stable client-side key. */
interface ReceivedAlert {
  key: string;
  payload: FanoutAlertPayload;
}

/**
 * Live alert-notification surface (Requirements 5.3, 9.2): subscribes to the
 * project's `alerts` fan-out channel (`WS /ws`, channel `alerts`) and renders
 * incoming user-addressed alert notifications as they arrive (threshold
 * crossings / spread widening). The subscription is torn down on unmount.
 *
 * This is a DISPLAY surface only — it shows notifications dispatched by the
 * backend alert engine (task 8.3); it never evaluates rules or places trades.
 */
export function AlertsNotifications({
  enabled = true,
  socketFactory,
  max = 20,
}: AlertsNotificationsProps) {
  const [alerts, setAlerts] = useState<ReceivedAlert[]>([]);
  const seqRef = useRef(0);

  const handleFanout = useCallback(
    (message: FanoutMessage) => {
      if (message.type !== "alert") return;
      const payload = message.payload as FanoutAlertPayload;
      if (typeof payload?.alertId !== "string") return;
      seqRef.current += 1;
      const received: ReceivedAlert = { key: `${payload.alertId}:${seqRef.current}`, payload };
      setAlerts((prev) => [received, ...prev].slice(0, max));
    },
    [max],
  );

  const subscriptions = useMemo(() => [{ channel: "alerts" as const }], []);

  useFanout({ subscriptions, onMessage: handleFanout, enabled, socketFactory });

  return (
    <section aria-labelledby="alerts-heading" className="alerts-surface">
      <h3 id="alerts-heading">Live alerts</h3>
      {alerts.length === 0 ? (
        <p className="subtle" role="status">
          No alerts yet. Threshold crossings and spread-widening notifications will appear here in
          real time.
        </p>
      ) : (
        <ul className="alerts-list" aria-label="Recent alert notifications">
          {alerts.map((a) => (
            <li key={a.key} className="alert-item" data-rule-type={a.payload.ruleType}>
              <span className="badge">{titleCase(a.payload.targetType)}</span>{" "}
              <strong>
                {a.payload.ruleType === "thresholdCross" ? "Threshold crossed" : "Spread widened"}
              </strong>{" "}
              <span className="subtle">on {a.payload.targetId}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
