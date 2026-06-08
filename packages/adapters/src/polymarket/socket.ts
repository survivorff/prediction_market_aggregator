/**
 * Injectable WebSocket transport for the Polymarket adapter's `subscribePrices`.
 *
 * The adapter depends only on the tiny {@link WebSocketLike} surface and a
 * {@link WebSocketFactory} that produces one. This keeps the package free of a
 * hard runtime dependency on the `ws` library: production passes a factory that
 * constructs a real client, while tests inject a {@link FakeWebSocket} to drive
 * the subscription lifecycle deterministically — no real sockets are opened.
 */

/** Event payload delivered to a `message` listener. */
export interface WebSocketMessageEvent {
  /** Raw frame data (string for JSON text frames). */
  data: unknown;
}

/**
 * The minimal WebSocket surface the adapter uses. Compatible with both the
 * browser `WebSocket` and the Node `ws` library: each exposes
 * `addEventListener`/`on`-style listeners and `send`/`close`. We standardize on
 * the listener-registration shape below; an adapter shim can wrap `ws` if
 * needed.
 */
export interface WebSocketLike {
  /** Register a listener for a connection/message/close/error event. */
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void;
  /** Send a frame (used to deliver the subscription message). */
  send(data: string): void;
  /** Close the socket. */
  close(code?: number, reason?: string): void;
}

/**
 * Produces a {@link WebSocketLike} for a given URL. Inject a fake in tests;
 * production wires this to a real client (e.g. `new WebSocket(url)` or the `ws`
 * library).
 */
export type WebSocketFactory = (url: string) => WebSocketLike;

/**
 * A controllable in-memory {@link WebSocketLike} for unit tests. Tests drive it
 * via {@link FakeWebSocket.emitOpen}, {@link FakeWebSocket.emitMessage}, and
 * {@link FakeWebSocket.emitClose}; the adapter sees a normal socket.
 */
export class FakeWebSocket implements WebSocketLike {
  /** Frames the adapter sent (e.g. the subscription request). */
  readonly sent: string[] = [];
  /** Whether `close()` has been called. */
  closed = false;

  private readonly listeners: {
    open: Array<(event: unknown) => void>;
    message: Array<(event: unknown) => void>;
    close: Array<(event: unknown) => void>;
    error: Array<(event: unknown) => void>;
  } = { open: [], message: [], close: [], error: [] };

  constructor(public readonly url: string) {}

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: unknown) => void,
  ): void {
    this.listeners[type].push(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  /** Simulate the socket opening. */
  emitOpen(): void {
    for (const listener of this.listeners.open) listener({});
  }

  /** Simulate an inbound message frame (data is delivered verbatim). */
  emitMessage(data: unknown): void {
    const event: WebSocketMessageEvent = { data };
    for (const listener of this.listeners.message) listener(event);
  }

  /** Simulate the socket closing (idempotent for listeners). */
  emitClose(): void {
    for (const listener of this.listeners.close) listener({});
  }

  /** Simulate a transport error. */
  emitError(error: unknown): void {
    for (const listener of this.listeners.error) listener(error);
  }
}
