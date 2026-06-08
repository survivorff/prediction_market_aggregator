/**
 * Shared integration-test support for `@pma/storage`.
 *
 * Integration tests run against the docker-compose TimescaleDB
 * (`postgres://pma:pma@localhost:5432/pma`). When the database is unreachable
 * (e.g. CI without Docker), {@link connectOrSkip} returns `null` so suites can
 * skip gracefully rather than hard-fail.
 *
 * Tests isolate themselves by creating a dedicated `source` row with a unique
 * key per test (via {@link uniqueKey}) and removing it (cascading to markets,
 * outcomes, price points) in teardown via {@link cleanupSource}.
 *
 * This module is test-only and excluded from the package build (see
 * tsconfig.json); it is not part of the published `@pma/storage` surface.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { Pool } from "pg";
import type { SourceType } from "@pma/core";
import { resolveDatabaseUrl } from "./client.js";
import { createRedisClient, type RedisClient } from "./redis/client.js";

const { Pool: PgPool } = pg;

/** A short, unique slug for per-test isolation (e.g. a `source.key`). */
export function uniqueKey(prefix = "test"): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Try to connect to the integration database. Returns a connected {@link Pool},
 * or `null` if the database is unreachable (tests should `skip` in that case).
 */
export async function connectOrSkip(): Promise<Pool | null> {
  const pool = new PgPool({
    connectionString: resolveDatabaseUrl(),
    // Fail fast instead of hanging the suite when nothing is listening.
    connectionTimeoutMillis: 2000,
    max: 4,
  });
  try {
    const client = await pool.connect();
    // Confirm the schema is present (migrations applied); otherwise skip too.
    await client.query("SELECT 1 FROM market LIMIT 0");
    client.release();
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

/** Insert a test `source` row and return its generated UUID. */
export async function createSource(
  pool: Pool,
  key: string,
  type: SourceType = "onchain",
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source (key, name, type, base_currency)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [key, `Test ${key}`, type, "USDC"],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createSource: insert returned no row");
  return row.id;
}

/**
 * Remove a test `source` and everything that references it. Markets cascade to
 * outcomes and price points; events/markets/cursors are deleted explicitly
 * since `source` is referenced without `ON DELETE CASCADE`.
 */
export async function cleanupSource(pool: Pool, sourceId: string): Promise<void> {
  await pool.query(`DELETE FROM market WHERE source_id = $1`, [sourceId]);
  await pool.query(`DELETE FROM event WHERE source_id = $1`, [sourceId]);
  await pool.query(`DELETE FROM sync_cursor WHERE source_id = $1`, [sourceId]);
  await pool.query(`DELETE FROM source WHERE id = $1`, [sourceId]);
}

/** Delete a canonical event row by id (no source linkage). */
export async function cleanupCanonicalEvent(pool: Pool, canonicalEventId: string): Promise<void> {
  await pool.query(`DELETE FROM canonical_event WHERE id = $1`, [canonicalEventId]);
}

/**
 * Remove all `watchlist_item` rows for a test user. Watchlist items are not
 * tied to a `source` (they reference a `user_id` + target), so they are cleaned
 * up by user id rather than via {@link cleanupSource}.
 */
export async function cleanupWatchlistUser(pool: Pool, userId: string): Promise<void> {
  await pool.query(`DELETE FROM watchlist_item WHERE user_id = $1`, [userId]);
}

/**
 * Remove all `alert_rule` rows for a test user. Alert rules are not tied to a
 * `source` (they reference a `user_id` + target), so they are cleaned up by
 * user id rather than via {@link cleanupSource}.
 */
export async function cleanupAlertUser(pool: Pool, userId: string): Promise<void> {
  await pool.query(`DELETE FROM alert_rule WHERE user_id = $1`, [userId]);
}

/** A random UUID, for per-test user ids / target ids. */
export function uniqueUuid(): string {
  return randomUUID();
}

/**
 * Try to connect to the integration Redis (docker-compose `redis:7-alpine` at
 * `redis://localhost:6379`). Returns a connected {@link RedisClient}, or `null`
 * if Redis is unreachable (tests should `skip` in that case), mirroring
 * {@link connectOrSkip} for Postgres.
 */
export async function connectRedisOrSkip(): Promise<RedisClient | null> {
  const client = createRedisClient({
    options: {
      // Fail fast instead of hanging the suite when nothing is listening.
      connectTimeout: 2000,
      // Do not endlessly retry / queue when Redis is down.
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    },
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}
