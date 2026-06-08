/**
 * Postgres connection pool wrapper for `@pma/storage`.
 *
 * Wraps the `pg` library's connection pool. The connection string is read from
 * the `DATABASE_URL` environment variable, defaulting to the docker-compose dev
 * value (see docker-compose.yml / .env.example). All repositories in this
 * package run their queries through a {@link Queryable} — satisfied by both a
 * pooled {@link Pool} and a transaction-scoped {@link PoolClient} — so batch
 * writes can run atomically inside a transaction.
 */

import pg from "pg";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const { Pool: PgPool } = pg;

/**
 * The docker-compose / `.env.example` development connection string. Used as
 * the default when `DATABASE_URL` is not set in the environment.
 */
export const DEFAULT_DATABASE_URL = "postgres://pma:pma@localhost:5432/pma";

/**
 * The minimal query surface shared by a pooled {@link Pool} and a
 * transaction-scoped {@link PoolClient}. Repositories depend on this so the
 * same SQL helper can run either directly on the pool or inside a transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

/** Options for {@link createPool}. */
export interface CreatePoolOptions {
  /** Override the connection string; defaults to {@link resolveDatabaseUrl}. */
  connectionString?: string;
  /** Maximum number of clients in the pool. */
  max?: number;
}

/**
 * Resolve the Postgres connection string from `DATABASE_URL`, falling back to
 * the local docker-compose development value ({@link DEFAULT_DATABASE_URL}).
 */
export function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_DATABASE_URL;
}

/**
 * Create a new Postgres connection {@link Pool}. The caller owns the pool's
 * lifecycle and SHOULD call `pool.end()` on shutdown.
 */
export function createPool(options: CreatePoolOptions = {}): Pool {
  return new PgPool({
    connectionString: options.connectionString ?? resolveDatabaseUrl(),
    max: options.max,
  });
}

/**
 * Run `fn` inside a single database transaction. Acquires a client from the
 * pool, issues `BEGIN`, runs `fn`, then `COMMIT`s on success or `ROLLBACK`s on
 * any thrown error. The client is always released back to the pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
