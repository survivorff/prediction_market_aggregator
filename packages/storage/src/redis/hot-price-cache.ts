/**
 * Redis hot latest-price cache (design.md "Component 4: Storage Layer" and
 * "Hot Cache" glossary; Requirement 10.4 — latest prices on hot paths are
 * served from Redis).
 *
 * The ingestion `onTick` path writes the latest price for each market outcome
 * here so the API gateway can serve discovery/detail "latest price" reads
 * without touching the TimescaleDB hypertable.
 *
 * Key scheme: one Redis **hash** per market, `hotprice:{marketId}`, whose
 * fields are outcome labels and whose values are JSON `{ price, volume, ts }`.
 * Modeling a market as a single hash lets a single round-trip read *all* of a
 * market's outcome prices (`HGETALL`) and applies one short, refreshable TTL to
 * the market's latest-price set. Each write refreshes the TTL so an actively
 * updating market stays warm while a stale one expires out of the cache.
 */

import type { RedisClient } from "./client.js";

/** Default time-to-live for a market's hot-price hash (30s). */
export const DEFAULT_HOT_PRICE_TTL_MS = 30_000;

/** A latest-price entry reconstructed from the hot cache. */
export interface HotPrice {
  marketId: string;
  outcomeLabel: string;
  /** 0..1 for binary. */
  price: number;
  volume: number | null;
  /** ISO 8601 capture time. */
  ts: string;
}

/** Optional per-write overrides for {@link HotPriceCache.setHotPrice}. */
export interface SetHotPriceOptions {
  /** Trade/observation volume; defaults to `null`. */
  volume?: number | null;
  /** ISO 8601 capture time; defaults to `now`. */
  ts?: string;
  /** Override the cache's default TTL for this market (milliseconds). */
  ttlMs?: number;
}

/** The JSON value stored in each hash field. */
interface StoredValue {
  price: number;
  volume: number | null;
  ts: string;
}

/** Options for constructing a {@link HotPriceCache}. */
export interface HotPriceCacheOptions {
  /** Default TTL applied to each market hash, in milliseconds. */
  ttlMs?: number;
}

/** Build the Redis hash key for a market's hot-price set. */
export function hotPriceKey(marketId: string): string {
  return `hotprice:${marketId}`;
}

function parseStored(raw: string): StoredValue | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredValue>;
    if (typeof parsed.price !== "number" || typeof parsed.ts !== "string") return null;
    const volume = typeof parsed.volume === "number" ? parsed.volume : null;
    return { price: parsed.price, volume, ts: parsed.ts };
  } catch {
    return null;
  }
}

/**
 * Hot latest-price cache backed by Redis hashes. Construct with a connected
 * {@link RedisClient} (the same client used for ordinary commands — not a
 * subscriber-mode connection).
 */
export class HotPriceCache {
  private readonly redis: RedisClient;
  private readonly defaultTtlMs: number;

  constructor(redis: RedisClient, options: HotPriceCacheOptions = {}) {
    this.redis = redis;
    this.defaultTtlMs = options.ttlMs ?? DEFAULT_HOT_PRICE_TTL_MS;
  }

  /**
   * Write the latest price for a market outcome and (re)set the market hash's
   * TTL. Mirrors the design's `redis.setHotPrice(marketId, outcomeLabel, price)`
   * call while also persisting `volume`/`ts` so a full {@link HotPrice} can be
   * reconstructed on read.
   */
  async setHotPrice(
    marketId: string,
    outcomeLabel: string,
    price: number,
    options: SetHotPriceOptions = {},
  ): Promise<void> {
    const value: StoredValue = {
      price,
      volume: options.volume ?? null,
      ts: options.ts ?? new Date().toISOString(),
    };
    const key = hotPriceKey(marketId);
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    // HSET then PEXPIRE in a single round-trip; refreshing TTL on every write
    // keeps actively-updating markets warm and lets stale ones expire.
    await this.redis
      .multi()
      .hset(key, outcomeLabel, JSON.stringify(value))
      .pexpire(key, ttlMs)
      .exec();
  }

  /**
   * Read the latest price for a single market outcome, or `null` if absent or
   * expired.
   */
  async getHotPrice(marketId: string, outcomeLabel: string): Promise<HotPrice | null> {
    const raw = await this.redis.hget(hotPriceKey(marketId), outcomeLabel);
    if (raw === null) return null;
    const stored = parseStored(raw);
    if (stored === null) return null;
    return { marketId, outcomeLabel, ...stored };
  }

  /**
   * Read the latest prices for every outcome of a market in a single round-trip
   * (`HGETALL`). Returns `[]` when the market has no hot entries (absent or
   * expired). Malformed field values are skipped.
   */
  async getMarketHotPrices(marketId: string): Promise<HotPrice[]> {
    const all = await this.redis.hgetall(hotPriceKey(marketId));
    const result: HotPrice[] = [];
    for (const [outcomeLabel, raw] of Object.entries(all)) {
      const stored = parseStored(raw);
      if (stored !== null) {
        result.push({ marketId, outcomeLabel, ...stored });
      }
    }
    return result;
  }

  /** Remaining TTL for a market's hot-price hash in milliseconds, or `null` if the key has no TTL / does not exist. */
  async getTtlMs(marketId: string): Promise<number | null> {
    const pttl = await this.redis.pttl(hotPriceKey(marketId));
    // ioredis returns -2 (no key) or -1 (no expiry) as sentinels.
    return pttl >= 0 ? pttl : null;
  }

  /** Remove a market's entire hot-price hash. Primarily for test cleanup. */
  async clearMarket(marketId: string): Promise<void> {
    await this.redis.del(hotPriceKey(marketId));
  }
}
