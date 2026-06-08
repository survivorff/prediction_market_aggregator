/**
 * Fan-out publisher (design.md "WebSocket fan-out"; Requirement 9.2 — live
 * price/spread/alert updates are pushed to subscribed clients over the system's
 * own channel, fed by Redis pub/sub from the ingestion `onTick` path).
 *
 * Publishes a uniform {@link FanoutMessage} envelope (JSON-encoded) onto the
 * per-target Redis channels defined in {@link ./channels}. The API gateway's WS
 * fan-out subscribes (via {@link FanoutSubscriber}) and relays envelopes to
 * connected clients.
 */

import type { RedisClient } from "./client.js";
import {
  marketChannel,
  canonicalChannel,
  alertsChannel,
  type FanoutMessage,
  type MessageType,
  type PricePayload,
  type SpreadPayload,
} from "./channels.js";

/**
 * Publishes fan-out messages to Redis channels. Construct with a connected
 * {@link RedisClient} (an ordinary client — publishing does not require a
 * dedicated connection like subscribing does).
 */
export class FanoutPublisher {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Publish a fully-formed envelope to its own `channel`. Returns the number of
   * Redis subscribers that received it. The envelope's `channel` field is used
   * as the publish target so it is always self-describing.
   */
  async publish<T>(message: FanoutMessage<T>): Promise<number> {
    return this.redis.publish(message.channel, JSON.stringify(message));
  }

  /**
   * Publish a `price` update for a single market (channel `chan:market:{id}`).
   * Called from the ingestion `onTick` path.
   */
  async publishPrice(marketId: string, payload: PricePayload): Promise<number> {
    return this.publishTyped(marketChannel(marketId), "price", payload);
  }

  /**
   * Publish a `spread` update for a canonical grouping
   * (channel `chan:canonical:{id}`).
   */
  async publishSpread(canonicalEventId: string, payload: SpreadPayload): Promise<number> {
    return this.publishTyped(canonicalChannel(canonicalEventId), "spread", payload);
  }

  /** Publish an `alert` notification to the shared alerts channel (`chan:alerts`). */
  async publishAlert<T>(payload: T): Promise<number> {
    return this.publishTyped(alertsChannel(), "alert", payload);
  }

  private async publishTyped<T>(channel: string, type: MessageType, payload: T): Promise<number> {
    const message: FanoutMessage<T> = { channel, type, payload };
    return this.redis.publish(channel, JSON.stringify(message));
  }
}
