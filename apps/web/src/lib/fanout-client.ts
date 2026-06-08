/**
 * Client for the project's OWN WebSocket fan-out (`WS /ws`; Requirements 9.2,
 * 5.3). The gateway relays live `{ channel, type: "price"|"spread"|"alert",
 * payload }` envelopes fed by Redis pub/sub from the ingestion `onTick` path —
 * the frontend subscribes to the SYSTEM'S OWN socket and never connects to an
 * upstream platform (Requirement 9.1 chokepoint, mirrored from the REST
 * client).
 *
 * ## Protocol (design.md "WebSocket fan-out")
 *
 * ```text
 * WS /ws
 *   → subscribe     { action: "subscribe",   channel: "market",    id }
 *   → subscribe     { action: "subscribe",   channel: "canonical", id }
 *   → subscribe     { action: "subscribe",   channel: "alerts" }
 *   → unsubscribe   { action: "unsubscribe", channel, id? }
 *   ← message       { channel, type: "price"|"spread"|"alert", payload }
 * ```
 *
 * ## Testability
 *
 * The `WebSocket` constructor is INJECTABLE (a factory option) so unit tests
 * pass a fake socket — there is no hardcoded global `WebSocket` dependency. The
 * URL is derived from the configured API base (http→ws, https→wss, + `/ws`) via
 * {@link deriveFanoutUrl}, so the live channel targets the same gateway as REST.
 */

import { resolveApiBaseUrl } from "./api-client";
import type { FanoutChannelKind, FanoutMessage } from "./dto";

/**
 * Minimal structural shape of a browser `WebSocket` the client depends on. The
 * global `WebSocket` satisfies it; tests inject a fake implementing just these
 * members.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((this: unknown, ev: unknown) => void) | null;
  onclose: ((this: unknown, ev: unknown) => void) | null;
  onerror: ((this: unknown, ev: unknown) => void) | null;
  onmessage: ((this: unknown, ev: { data: unknown }) => void) | null;
  readonly readyState: number;
}

/** Factory that constructs a {@link WebSocketLike} for a URL (injectable). */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** `WebSocket.OPEN` ready-state constant (avoids depending on the global). */
const WS_OPEN = 1;

/** A channel subscription target: a kind plus an id for market/canonical. */
export interface FanoutSubscription {
  channel: FanoutChannelKind;
  /** Required for `market`/`canonical`; omitted/ignored for `alerts`. */
  id?: string;
}

/** Handler invoked for each relayed `{ channel, type, payload }` envelope. */
export type FanoutHandler = (message: FanoutMessage) => void;

/** Configuration for {@link createFanoutClient}. */
export interface FanoutClientConfig {
  /** The channels to subscribe to once the socket opens. */
  subscriptions: FanoutSubscription[];
  /** Invoked for every relayed fan-out message. */
  onMessage: FanoutHandler;
  /**
   * Injectable WebSocket constructor (defaults to the global `WebSocket`). Tests
   * pass a fake; there is no hardcoded global dependency.
   */
  socketFactory?: WebSocketFactory;
  /** Override the fan-out URL (defaults to {@link deriveFanoutUrl}). */
  url?: string;
}

/** A live fan-out connection handle; `close()` unsubscribes + closes the socket. */
export interface FanoutClient {
  /** The resolved ws/wss URL the client connected to. */
  readonly url: string;
  /** Tear down: send unsubscribe frames (if open) and close the socket. */
  close(): void;
}

/**
 * Derive the ws/wss fan-out URL from an http(s) API base URL: the scheme is
 * swapped (`http`→`ws`, `https`→`wss`) and the `/ws` path is appended. Any
 * trailing slash on the base is normalized so the result is exactly
 * `<scheme>://<host>[:port]/ws`.
 */
export function deriveFanoutUrl(apiBaseUrl: string): string {
  const trimmed = apiBaseUrl.replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}/ws`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}/ws`;
  }
  // Already a ws/wss base, or scheme-relative — just append the path.
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return `${trimmed}/ws`;
  }
  return `${trimmed}/ws`;
}

/** Build the subscribe/unsubscribe frame for a subscription target. */
function buildFrame(action: "subscribe" | "unsubscribe", sub: FanoutSubscription): string {
  if (sub.channel === "alerts") {
    return JSON.stringify({ action, channel: "alerts" });
  }
  return JSON.stringify({ action, channel: sub.channel, id: sub.id });
}

/**
 * Open a fan-out connection: connect to the derived ws URL, send a subscribe
 * frame for each configured channel once the socket opens, dispatch every
 * relayed `{ channel, type, payload }` envelope to `onMessage`, and on
 * {@link FanoutClient.close} send unsubscribe frames (when still open) and close
 * the socket.
 *
 * Robust to ordering: if the socket is already open when created (e.g. a
 * synchronous fake in tests), subscribe frames are sent immediately.
 */
export function createFanoutClient(config: FanoutClientConfig): FanoutClient {
  const url = config.url ?? deriveFanoutUrl(resolveApiBaseUrl());
  const factory: WebSocketFactory =
    config.socketFactory ??
    ((u) =>
      new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u));

  const socket = factory(url);
  let closed = false;

  const sendSubscriptions = () => {
    for (const sub of config.subscriptions) {
      socket.send(buildFrame("subscribe", sub));
    }
  };

  socket.onopen = () => {
    if (closed) return;
    sendSubscriptions();
  };

  socket.onmessage = (ev: { data: unknown }) => {
    if (closed) return;
    const raw = ev.data;
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isFanoutMessage(parsed)) return;
    config.onMessage(parsed);
  };

  // If the injected socket is already OPEN (synchronous fakes in tests, or a
  // reused connection), subscribe right away — `onopen` may never fire.
  if (socket.readyState === WS_OPEN) {
    sendSubscriptions();
  }

  return {
    url,
    close() {
      if (closed) return;
      closed = true;
      // Best-effort unsubscribe while the socket is open, then close.
      if (socket.readyState === WS_OPEN) {
        for (const sub of config.subscriptions) {
          try {
            socket.send(buildFrame("unsubscribe", sub));
          } catch {
            // Socket may have raced to closed; ignore.
          }
        }
      }
      try {
        socket.close();
      } catch {
        // Ignore double-close.
      }
    },
  };
}

/** Type guard: is `value` a relayed `{ channel, type, payload }` envelope? */
function isFanoutMessage(value: unknown): value is FanoutMessage {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.channel === "string" &&
    (obj.type === "price" || obj.type === "spread" || obj.type === "alert") &&
    "payload" in obj
  );
}
