/**
 * Fan-out subscriber (design.md "WebSocket fan-out"; Requirement 9.2). Lets a
 * consumer (the API gateway's WS layer) subscribe to a Redis channel with a
 * handler that receives the decoded {@link FanoutMessage} envelope.
 *
 * Redis requires a connection in *subscriber mode* to be dedicated (it cannot
 * issue ordinary commands), so this class owns its own {@link RedisClient}.
 * Construct it with a client created solely for subscribing — typically a fresh
 * {@link createRedisClient} call, separate from the one used for publishing and
 * the hot-price cache.
 */

import type { RedisClient } from "./client.js";
import { parseChannel, type FanoutMessage } from "./channels.js";

/** Handler invoked for each decoded message on a subscribed channel. */
export type MessageHandler = (message: FanoutMessage) => void;

/** Handle to one channel subscription; `close()` unsubscribes this handler. */
export interface ChannelSubscription {
  close(): Promise<void>;
  readonly channel: string;
}

/**
 * Subscribes to fan-out channels on a dedicated Redis connection and dispatches
 * decoded envelopes to per-channel handlers. A single underlying `message`
 * listener routes by channel name so many channels can share one connection.
 */
export class FanoutSubscriber {
  private readonly redis: RedisClient;
  private readonly handlers = new Map<string, Set<MessageHandler>>();
  private listenerAttached = false;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  /**
   * Subscribe `handler` to `channel`. Multiple handlers may share a channel;
   * the Redis `SUBSCRIBE` happens once per channel. Returns a
   * {@link ChannelSubscription} whose `close()` detaches just this handler (and
   * `UNSUBSCRIBE`s once the channel has no remaining handlers).
   */
  async subscribe(channel: string, handler: MessageHandler): Promise<ChannelSubscription> {
    this.attachListener();

    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
      await this.redis.subscribe(channel);
    }
    set.add(handler);

    return {
      channel,
      close: async () => {
        const current = this.handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) {
          this.handlers.delete(channel);
          await this.redis.unsubscribe(channel);
        }
      },
    };
  }

  /**
   * Tear down all subscriptions and close the underlying connection. The
   * subscriber is unusable afterwards; create a new one to resubscribe.
   */
  async close(): Promise<void> {
    this.handlers.clear();
    await this.redis.quit();
  }

  private attachListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    this.redis.on("message", (channel: string, raw: string) => {
      const set = this.handlers.get(channel);
      if (!set || set.size === 0) return;
      const message = this.decode(channel, raw);
      if (message === null) return;
      for (const handler of set) {
        handler(message);
      }
    });
  }

  private decode(channel: string, raw: string): FanoutMessage | null {
    // Ignore traffic on channels that do not match our naming scheme.
    if (parseChannel(channel) === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<FanoutMessage>;
      if (
        typeof parsed.type !== "string" ||
        typeof parsed.channel !== "string" ||
        !("payload" in parsed)
      ) {
        return null;
      }
      return parsed as FanoutMessage;
    } catch {
      return null;
    }
  }
}
