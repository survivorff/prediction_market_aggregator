/**
 * Redis connection wrapper for `@pma/storage`.
 *
 * Wraps the well-maintained `ioredis` client. The connection string is read
 * from the `REDIS_URL` environment variable, defaulting to the docker-compose
 * dev value (see docker-compose.yml / .env.example). Redis backs two concerns
 * for the system (see design.md "Component 4: Storage Layer"):
 *   - the hot latest-price cache for hot-path reads (Requirement 10.4), and
 *   - pub/sub for the WebSocket fan-out (Requirement 9.2).
 *
 * Pub/sub requires a *dedicated* connection for the subscriber (a connection in
 * subscriber mode cannot issue ordinary commands), so callers typically create
 * one client for publishing / cache and a separate one for subscribing.
 */

import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";

/** A connected ioredis client. Re-exported so consumers need not depend on ioredis directly. */
export type RedisClient = Redis;

/**
 * The docker-compose / `.env.example` development connection string. Used as
 * the default when `REDIS_URL` is not set in the environment.
 */
export const DEFAULT_REDIS_URL = "redis://localhost:6379";

/** Options for {@link createRedisClient}. */
export interface CreateRedisClientOptions {
  /** Override the connection string; defaults to {@link resolveRedisUrl}. */
  url?: string;
  /** Extra ioredis options merged over the defaults. */
  options?: RedisOptions;
}

/**
 * Resolve the Redis connection string from `REDIS_URL`, falling back to the
 * local docker-compose development value ({@link DEFAULT_REDIS_URL}).
 */
export function resolveRedisUrl(): string {
  const fromEnv = process.env.REDIS_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_REDIS_URL;
}

/**
 * Create a new ioredis {@link RedisClient}. The caller owns the connection's
 * lifecycle and SHOULD call `client.quit()` on shutdown. For pub/sub, create a
 * separate client for the subscriber (see module docs).
 */
export function createRedisClient(opts: CreateRedisClientOptions = {}): RedisClient {
  const url = opts.url ?? resolveRedisUrl();
  return new Redis(url, opts.options ?? {});
}
