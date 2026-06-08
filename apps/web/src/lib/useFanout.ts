"use client";

import { useEffect, useRef } from "react";
import {
  createFanoutClient,
  type FanoutHandler,
  type FanoutSubscription,
  type WebSocketFactory,
} from "./fanout-client";

/** Options for {@link useFanout}. */
export interface UseFanoutOptions {
  /**
   * Channels to subscribe to. The hook re-connects when this list changes (by
   * value), so callers should memoize or keep it stable. An empty list opens no
   * connection.
   */
  subscriptions: FanoutSubscription[];
  /**
   * Handler for each relayed `{ channel, type, payload }` message. Stored in a
   * ref so an inline handler does NOT churn the connection — the latest handler
   * is always invoked without re-subscribing.
   */
  onMessage: FanoutHandler;
  /** When false, the hook opens no connection (e.g. feature disabled). Default true. */
  enabled?: boolean;
  /** Injectable WebSocket constructor for tests; defaults to the global. */
  socketFactory?: WebSocketFactory;
  /** Override the fan-out URL (defaults to the derived gateway ws URL). */
  url?: string;
}

/**
 * Subscribe to the project's WebSocket fan-out for the lifetime of a component
 * (Requirements 9.2, 5.3). Opens one connection, subscribes to the given
 * channels, forwards every relayed message to `onMessage`, and unsubscribes +
 * closes the socket on unmount (or when the subscription set changes).
 *
 * The `onMessage` callback is held in a ref so passing an inline function does
 * not tear the connection down on every render; only a change to the
 * subscription targets (or `enabled`/`url`/`socketFactory`) reconnects.
 */
export function useFanout(options: UseFanoutOptions): void {
  const { subscriptions, onMessage, enabled = true, socketFactory, url } = options;

  // Keep the latest handler without making it a reconnect dependency. The ref
  // is updated in an effect (not during render) so it complies with the
  // react-hooks rules; the connect effect below reads `handlerRef.current`.
  const handlerRef = useRef<FanoutHandler>(onMessage);
  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  // Serialize the subscription targets so the effect re-runs only on a real
  // change (not on a new array identity with the same contents).
  const subsKey = JSON.stringify(subscriptions);

  useEffect(() => {
    if (!enabled || subscriptions.length === 0) return;

    const client = createFanoutClient({
      subscriptions,
      onMessage: (message) => handlerRef.current(message),
      socketFactory,
      url,
    });

    return () => client.close();
    // `subsKey` captures the subscription contents; `subscriptions` itself is
    // intentionally excluded to avoid reconnecting on identity-only changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsKey, enabled, socketFactory, url]);
}
