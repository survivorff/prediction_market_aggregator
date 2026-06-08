/**
 * Redis layer for `@pma/storage`: the hot latest-price cache (Requirement 10.4)
 * and the pub/sub fan-out that feeds the WebSocket gateway (Requirement 9.2).
 *
 * See design.md "Component 4: Storage Layer", "Price Streaming Flow" (the
 * ingestion `onTick` path calls `setHotPrice` + `fanout.publish`), and
 * "WebSocket fan-out".
 */

// Connection wrapper.
export { DEFAULT_REDIS_URL, resolveRedisUrl, createRedisClient } from "./client.js";
export type { RedisClient, CreateRedisClientOptions } from "./client.js";

// Channel naming scheme + typed message envelope.
export {
  CHANNEL_PREFIX,
  ALERTS_CHANNEL,
  marketChannel,
  canonicalChannel,
  alertsChannel,
  parseChannel,
} from "./channels.js";
export type {
  ChannelKind,
  MessageType,
  ParsedChannel,
  FanoutMessage,
  PriceMessage,
  SpreadMessage,
  PricePayload,
  SpreadPayload,
} from "./channels.js";

// Hot latest-price cache.
export { HotPriceCache, hotPriceKey, DEFAULT_HOT_PRICE_TTL_MS } from "./hot-price-cache.js";
export type { HotPrice, SetHotPriceOptions, HotPriceCacheOptions } from "./hot-price-cache.js";

// Pub/sub fan-out.
export { FanoutPublisher } from "./publisher.js";
export { FanoutSubscriber } from "./subscriber.js";
export type { MessageHandler, ChannelSubscription } from "./subscriber.js";
