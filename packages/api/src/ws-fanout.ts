/**
 * WebSocket fan-out relay logic (design.md "WebSocket fan-out"; Requirement
 * 9.2). This is the transport-agnostic core behind the `WS /ws` route: it
 * parses the client's subscribe/unsubscribe protocol, maps each (channel, id)
 * to the system's own Redis channel, and relays every decoded
 * {@link FanoutMessage} envelope back to the client as `{ channel, type,
 * payload }`.
 *
 * The fan-out is fed EXCLUSIVELY by Redis pub/sub from the ingestion `onTick`
 * path — the WS layer subscribes to the system's own channels and NEVER
 * connects to an upstream platform (Requirement 9.1 / architecture).
 *
 * ## Protocol (design.md)
 *
 * ```text
 * WS /ws
 *   → subscribe     { action: "subscribe",   channel: "market",    id }
 *   → subscribe     { action: "subscribe",   channel: "canonical", id }
 *   → subscribe     { action: "subscribe",   channel: "alerts" }
 *   → unsubscribe   { action: "unsubscribe", channel, id? }
 *   ← message       { channel, type: "price"|"spread"|"alert", payload }
 *   ← error         { type: "error", error }     # malformed/invalid frame (extension)
 * ```
 *
 * `channel` in the relayed message is the full Redis channel name (e.g.
 * `chan:market:{id}`), so it is self-describing and decodable via
 * `parseChannel` — matching the `@pma/storage` `FanoutMessage` envelope.
 *
 * ## Connection lifecycle (one subscriber per WS client)
 *
 * Each WS client gets ONE {@link FanoutRelay}, which owns ONE
 * {@link FanoutSubscriberPort} — i.e. one dedicated Redis connection in
 * subscriber mode (a subscriber-mode connection cannot issue ordinary
 * commands). That single subscriber multiplexes ALL of the client's channels.
 * The subscriber is created lazily on the client's first successful subscribe,
 * so a client that connects but never subscribes consumes no Redis connection.
 * On client disconnect (or server close) {@link FanoutRelay.close} unsubscribes
 * every channel and quits the dedicated connection.
 */

import {
  alertsChannel,
  canonicalChannel,
  marketChannel,
  type ChannelKind,
  type FanoutMessage,
} from "@pma/storage";
import type {
  FanoutChannelSubscription,
  FanoutSubscriberFactory,
  FanoutSubscriberPort,
} from "./dto.js";

/** A parsed, validated subscribe/unsubscribe request frame. */
export interface SubscribeRequest {
  action: "subscribe" | "unsubscribe";
  channel: ChannelKind;
  /** Target id; required for `market`/`canonical`, ignored for `alerts`. */
  id?: string;
}

/** A successful parse, or a human-readable validation error. */
export type ParseResult = { ok: true; request: SubscribeRequest } | { ok: false; error: string };

const CHANNEL_KINDS: ReadonlySet<string> = new Set<ChannelKind>(["market", "canonical", "alerts"]);

/** Type guard: is `value` one of the known {@link ChannelKind}s? */
function isChannelKind(value: unknown): value is ChannelKind {
  return typeof value === "string" && CHANNEL_KINDS.has(value);
}

/**
 * Parse and validate a raw client text frame into a {@link SubscribeRequest}.
 * Returns a structured error (never throws) so the caller can reject malformed
 * frames gracefully without tearing down the connection.
 */
export function parseSubscribeFrame(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON frame" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "frame must be a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  if (action !== "subscribe" && action !== "unsubscribe") {
    return { ok: false, error: 'action must be "subscribe" or "unsubscribe"' };
  }

  const channel = obj.channel;
  if (!isChannelKind(channel)) {
    return { ok: false, error: 'channel must be "market", "canonical", or "alerts"' };
  }

  if (channel === "market" || channel === "canonical") {
    const id = obj.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      return { ok: false, error: `channel "${channel}" requires a non-empty "id"` };
    }
    return { ok: true, request: { action, channel, id } };
  }

  // alerts: a single global channel; any provided id is ignored.
  return { ok: true, request: { action, channel } };
}

/**
 * Map a validated {@link SubscribeRequest} to the system's own Redis channel
 * name via the `@pma/storage` channel helpers.
 */
export function resolveRedisChannel(request: SubscribeRequest): string {
  switch (request.channel) {
    case "market":
      return marketChannel(request.id as string);
    case "canonical":
      return canonicalChannel(request.id as string);
    case "alerts":
      return alertsChannel();
  }
}

/** A minimal text-frame sink — satisfied by a `ws` socket's `send`. */
export type FrameSink = (data: string) => void;

/**
 * Per-WS-client relay. Owns one lazily-created {@link FanoutSubscriberPort}
 * (one dedicated Redis subscriber connection) that multiplexes all of this
 * client's channel subscriptions. Drives entirely off text frames + a
 * {@link FrameSink}, so it is unit-testable with an injected fake subscriber and
 * no Fastify/Redis.
 */
export class FanoutRelay {
  private subscriber: FanoutSubscriberPort | null = null;
  /** Redis channel name → its active subscription (one handler per channel). */
  private readonly subscriptions = new Map<string, FanoutChannelSubscription>();
  private closed = false;

  constructor(
    private readonly createSubscriber: FanoutSubscriberFactory,
    private readonly send: FrameSink,
  ) {}

  /** Number of distinct Redis channels this client is currently subscribed to. */
  get channelCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Handle one inbound client text frame. Malformed/invalid frames are rejected
   * with an `error` frame and otherwise ignored (the connection stays open).
   */
  async handleFrame(raw: string): Promise<void> {
    if (this.closed) return;

    const result = parseSubscribeFrame(raw);
    if (!result.ok) {
      this.sendError(result.error);
      return;
    }

    const redisChannel = resolveRedisChannel(result.request);
    if (result.request.action === "subscribe") {
      await this.subscribe(redisChannel);
    } else {
      await this.unsubscribe(redisChannel);
    }
  }

  /**
   * Tear down all channel subscriptions and close the dedicated Redis
   * connection. Idempotent; safe to call on client disconnect and server close.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(subs.map((s) => s.close().catch(() => undefined)));

    if (this.subscriber) {
      const subscriber = this.subscriber;
      this.subscriber = null;
      await subscriber.close().catch(() => undefined);
    }
  }

  /** Subscribe to a Redis channel (idempotent per channel for this client). */
  private async subscribe(redisChannel: string): Promise<void> {
    if (this.subscriptions.has(redisChannel)) return; // already subscribed

    const subscriber = this.ensureSubscriber();
    const subscription = await subscriber.subscribe(redisChannel, (message) => {
      this.relay(message);
    });

    // A concurrent close() (or duplicate subscribe) may have intervened while
    // awaiting; reconcile so we never leak a dangling subscription.
    if (this.closed || this.subscriptions.has(redisChannel)) {
      await subscription.close().catch(() => undefined);
      return;
    }
    this.subscriptions.set(redisChannel, subscription);
  }

  /** Unsubscribe from a Redis channel; a no-op when not subscribed. */
  private async unsubscribe(redisChannel: string): Promise<void> {
    const subscription = this.subscriptions.get(redisChannel);
    if (!subscription) return;
    this.subscriptions.delete(redisChannel);
    await subscription.close().catch(() => undefined);
  }

  /** Relay a decoded fan-out envelope to the client as `{ channel, type, payload }`. */
  private relay(message: FanoutMessage): void {
    if (this.closed) return;
    const frame = {
      channel: message.channel,
      type: message.type,
      payload: message.payload,
    };
    this.send(JSON.stringify(frame));
  }

  private sendError(error: string): void {
    this.send(JSON.stringify({ type: "error", error }));
  }

  /** Lazily create the per-connection subscriber on first subscribe. */
  private ensureSubscriber(): FanoutSubscriberPort {
    if (this.subscriber === null) {
      this.subscriber = this.createSubscriber();
    }
    return this.subscriber;
  }
}
