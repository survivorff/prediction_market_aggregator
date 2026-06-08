/**
 * Integration tests for the `@pma/storage` Redis layer, run against the
 * docker-compose `redis:7-alpine` instance (`redis://localhost:6379`).
 *
 * Covers:
 *   - hot-price set/get and reading all outcomes for a market (Requirement 10.4),
 *   - TTL expiry behaviour using a short TTL,
 *   - pub/sub round-trip across the price / spread / alerts channels (Requirement 9.2).
 *
 * When Redis is unreachable the whole suite skips gracefully (see
 * test-support.connectRedisOrSkip) rather than hard-failing. Each test uses a
 * unique market id so the suite is isolated and self-cleaning.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  HotPriceCache,
  FanoutPublisher,
  FanoutSubscriber,
  createRedisClient,
  marketChannel,
  canonicalChannel,
  alertsChannel,
  type RedisClient,
  type FanoutMessage,
  type PricePayload,
  type SpreadPayload,
} from "./index.js";
import { connectRedisOrSkip, uniqueKey } from "../test-support.js";

let redis: RedisClient | null = null;

beforeAll(async () => {
  redis = await connectRedisOrSkip();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

const marketsToClean: string[] = [];

afterEach(async () => {
  if (!redis) return;
  const cache = new HotPriceCache(redis);
  while (marketsToClean.length > 0) {
    const id = marketsToClean.pop();
    if (id) await cache.clearMarket(id);
  }
});

/** Allocate a unique market id tracked for cleanup. */
function freshMarketId(): string {
  const id = uniqueKey("hpmkt");
  marketsToClean.push(id);
  return id;
}

/** Resolve once `predicate` returns a value, polling Redis-driven async state. */
async function waitFor<T>(get: () => T | null, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Redis hot-price cache (integration)", () => {
  it("skips when Redis is unavailable", () => {
    if (!redis) {
      expect(redis).toBeNull();
    } else {
      expect(redis).not.toBeNull();
    }
  });

  it("sets and gets a single outcome's latest price", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();

    await cache.setHotPrice(marketId, "Yes", 0.62, {
      volume: 1234,
      ts: "2025-01-01T00:00:00.000Z",
    });

    const got = await cache.getHotPrice(marketId, "Yes");
    expect(got).toEqual({
      marketId,
      outcomeLabel: "Yes",
      price: 0.62,
      volume: 1234,
      ts: "2025-01-01T00:00:00.000Z",
    });
  });

  it("returns null for a missing outcome / market", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();
    expect(await cache.getHotPrice(marketId, "Yes")).toBeNull();
    await cache.setHotPrice(marketId, "Yes", 0.5);
    expect(await cache.getHotPrice(marketId, "No")).toBeNull();
  });

  it("reads all outcomes' latest prices for a market in one call", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();

    await cache.setHotPrice(marketId, "Yes", 0.6, { ts: "2025-01-01T00:00:00.000Z" });
    await cache.setHotPrice(marketId, "No", 0.4, { ts: "2025-01-01T00:00:00.000Z" });

    const all = await cache.getMarketHotPrices(marketId);
    const byLabel = Object.fromEntries(all.map((p) => [p.outcomeLabel, p.price]));
    expect(all).toHaveLength(2);
    expect(byLabel).toEqual({ Yes: 0.6, No: 0.4 });
  });

  it("overwrites the latest price for an outcome in place", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();
    await cache.setHotPrice(marketId, "Yes", 0.5);
    await cache.setHotPrice(marketId, "Yes", 0.7);
    const got = await cache.getHotPrice(marketId, "Yes");
    expect(got?.price).toBe(0.7);
    expect(await cache.getMarketHotPrices(marketId)).toHaveLength(1);
  });

  it("defaults volume to null and ts to a valid ISO timestamp", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();
    await cache.setHotPrice(marketId, "Yes", 0.5);
    const got = await cache.getHotPrice(marketId, "Yes");
    expect(got?.volume).toBeNull();
    expect(got?.ts).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(got?.ts ?? ""))).toBe(false);
  });

  it("applies a TTL and the key expires after it elapses", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();

    await cache.setHotPrice(marketId, "Yes", 0.55, { ttlMs: 200 });

    // Immediately present, with a positive remaining TTL.
    expect(await cache.getHotPrice(marketId, "Yes")).not.toBeNull();
    const ttl = await cache.getTtlMs(marketId);
    expect(ttl).not.toBeNull();
    expect(ttl ?? 0).toBeGreaterThan(0);
    expect(ttl ?? Infinity).toBeLessThanOrEqual(200);

    // After the TTL elapses the entry is gone.
    await new Promise((r) => setTimeout(r, 350));
    expect(await cache.getHotPrice(marketId, "Yes")).toBeNull();
    expect(await cache.getMarketHotPrices(marketId)).toEqual([]);
  });

  it("refreshes the TTL on each write so an active market stays warm", async () => {
    if (!redis) return;
    const cache = new HotPriceCache(redis);
    const marketId = freshMarketId();

    await cache.setHotPrice(marketId, "Yes", 0.5, { ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 150));
    // Second write refreshes TTL back to ~300ms.
    await cache.setHotPrice(marketId, "Yes", 0.6, { ttlMs: 300 });
    await new Promise((r) => setTimeout(r, 200));
    // Total elapsed > 300ms, but TTL was refreshed, so still present.
    expect(await cache.getHotPrice(marketId, "Yes")).not.toBeNull();
  });
});

describe("Redis pub/sub fan-out (integration)", () => {
  let subscriber: FanoutSubscriber | null = null;

  afterEach(async () => {
    if (subscriber) {
      await subscriber.close();
      subscriber = null;
    }
  });

  it("delivers a published price message to a market-channel subscriber", async () => {
    if (!redis) return;
    const publisher = new FanoutPublisher(redis);
    subscriber = new FanoutSubscriber(createRedisClient());

    const marketId = uniqueKey("psmkt");
    let received: FanoutMessage<PricePayload> | null = null;
    await subscriber.subscribe(marketChannel(marketId), (msg) => {
      received = msg as FanoutMessage<PricePayload>;
    });

    const payload: PricePayload = {
      marketId,
      outcomeLabel: "Yes",
      price: 0.42,
      volume: null,
      ts: "2025-06-01T00:00:00.000Z",
    };
    await publisher.publishPrice(marketId, payload);

    const got = await waitFor(() => received);
    expect(got.type).toBe("price");
    expect(got.channel).toBe(marketChannel(marketId));
    expect(got.payload).toEqual(payload);
  });

  it("delivers a spread message to a canonical-channel subscriber", async () => {
    if (!redis) return;
    const publisher = new FanoutPublisher(redis);
    subscriber = new FanoutSubscriber(createRedisClient());

    const canonicalId = uniqueKey("pscanon");
    let received: FanoutMessage<SpreadPayload> | null = null;
    await subscriber.subscribe(canonicalChannel(canonicalId), (msg) => {
      received = msg as FanoutMessage<SpreadPayload>;
    });

    const payload: SpreadPayload = {
      canonicalEventId: canonicalId,
      gap: 0.08,
      probabilities: [
        { source: "polymarket", impliedProb: 0.6 },
        { source: "manifold", impliedProb: 0.52 },
      ],
    };
    await publisher.publishSpread(canonicalId, payload);

    const got = await waitFor(() => received);
    expect(got.type).toBe("spread");
    expect(got.payload).toEqual(payload);
  });

  it("delivers an alert message to an alerts-channel subscriber", async () => {
    if (!redis) return;
    const publisher = new FanoutPublisher(redis);
    subscriber = new FanoutSubscriber(createRedisClient());

    let received: FanoutMessage | null = null;
    await subscriber.subscribe(alertsChannel(), (msg) => {
      received = msg;
    });

    await publisher.publishAlert({ userId: "u1", message: "threshold crossed" });

    const got = await waitFor(() => received);
    expect(got.type).toBe("alert");
    expect(got.channel).toBe(alertsChannel());
    expect(got.payload).toEqual({ userId: "u1", message: "threshold crossed" });
  });

  it("does not deliver messages from other channels to a subscriber", async () => {
    if (!redis) return;
    const publisher = new FanoutPublisher(redis);
    subscriber = new FanoutSubscriber(createRedisClient());

    const subscribedMarket = uniqueKey("psmkt");
    const otherMarket = uniqueKey("psmkt");
    const received: FanoutMessage[] = [];
    await subscriber.subscribe(marketChannel(subscribedMarket), (msg) => {
      received.push(msg);
    });

    // Publish to a different market channel, then to the subscribed one.
    await publisher.publishPrice(otherMarket, {
      marketId: otherMarket,
      outcomeLabel: "Yes",
      price: 0.1,
      volume: null,
      ts: "2025-06-01T00:00:00.000Z",
    });
    await publisher.publishPrice(subscribedMarket, {
      marketId: subscribedMarket,
      outcomeLabel: "Yes",
      price: 0.9,
      volume: null,
      ts: "2025-06-01T00:00:00.000Z",
    });

    const got = await waitFor(() => (received.length > 0 ? received : null));
    // Only the subscribed market's message arrives.
    expect(got).toHaveLength(1);
    expect((got[0]?.payload as PricePayload).price).toBe(0.9);
  });

  it("stops delivering after a subscription is closed", async () => {
    if (!redis) return;
    const publisher = new FanoutPublisher(redis);
    subscriber = new FanoutSubscriber(createRedisClient());

    const marketId = uniqueKey("psmkt");
    let count = 0;
    const sub = await subscriber.subscribe(marketChannel(marketId), () => {
      count += 1;
    });

    await publisher.publishPrice(marketId, {
      marketId,
      outcomeLabel: "Yes",
      price: 0.5,
      volume: null,
      ts: "2025-06-01T00:00:00.000Z",
    });
    await waitFor(() => (count > 0 ? count : null));
    expect(count).toBe(1);

    await sub.close();
    await publisher.publishPrice(marketId, {
      marketId,
      outcomeLabel: "Yes",
      price: 0.6,
      volume: null,
      ts: "2025-06-01T00:00:00.000Z",
    });
    // Give any erroneous delivery a chance to land, then assert none did.
    await new Promise((r) => setTimeout(r, 150));
    expect(count).toBe(1);
  });
});
