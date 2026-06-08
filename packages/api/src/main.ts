/**
 * Runnable entrypoint for the outbound API gateway.
 *
 * Wires a live Postgres pool + Redis hot cache into {@link buildGatewayDeps},
 * builds the Fastify app via {@link createServer}, and listens on `API_PORT`
 * (default 4000). This is the production/dev bootstrap; tests use `createServer`
 * with in-memory fakes instead.
 *
 * Env:
 *   API_PORT              listen port (default 4000)
 *   API_HOST              listen host (default 0.0.0.0)
 *   DATABASE_URL          Postgres (default postgres://pma:pma@localhost:5432/pma)
 *   REDIS_URL             Redis (default redis://localhost:6379)
 *   API_DEV_TOKEN         dev bearer token that authenticates user-scoped routes
 *                         (default "dev-token"); maps to a fixed demo user id.
 *   CORS_ORIGIN           allowed browser origin(s) for CORS, comma-separated;
 *                         "*" reflects any origin (default
 *                         "http://localhost:3000" for the local web frontend).
 *
 * The gateway serves EXCLUSIVELY from storage/Redis (Requirement 9.1).
 */

import { createPool, createRedisClient, type RedisClient } from "@pma/storage";
import { buildGatewayDeps } from "./deps.js";
import { bearerAuthenticator } from "./auth.js";
import { createServer } from "./server.js";

/** Per-source adapter capabilities (declared in code, not persisted). */
const CAPABILITIES = {
  polymarket: {
    websocketPrices: true,
    priceHistory: true,
    orderBookDepth: true,
    keysetPagination: true,
  },
  manifold: {
    websocketPrices: false,
    priceHistory: true,
    orderBookDepth: false,
    keysetPagination: true,
  },
  predictfun: {
    websocketPrices: false,
    priceHistory: true,
    orderBookDepth: true,
    keysetPagination: true,
  },
} as const;

/** Fixed demo user id the dev token resolves to. */
const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000aa";

async function main(): Promise<void> {
  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? "0.0.0.0";
  const devToken = process.env.API_DEV_TOKEN ?? "dev-token";

  // Allowed browser origin(s) for CORS. The web frontend runs on a different
  // origin than the gateway, so cross-origin fetches need this. "*" reflects
  // any origin; otherwise a comma-separated allow-list. Defaults to the local
  // Next.js dev origin.
  const corsEnv = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  const corsOrigin: string | string[] | boolean =
    corsEnv === "*"
      ? true
      : corsEnv.includes(",")
        ? corsEnv.split(",").map((o) => o.trim())
        : corsEnv;

  const pool = createPool();

  // Optional Redis hot cache. If Redis is unreachable, fall back to serving
  // latest prices from stored outcome data (the gateway tolerates no hot cache).
  let redis: RedisClient | undefined;
  try {
    redis = createRedisClient();
    await redis.ping();
  } catch {
    redis = undefined;
    // eslint-disable-next-line no-console
    console.warn("[api] Redis unavailable — serving latest prices from storage only");
  }

  // Dev authenticator: accept a single configured bearer token → demo user.
  // Production swaps this for a real JWT/session verifier.
  const authenticate = bearerAuthenticator((token) =>
    token === devToken ? { userId: DEMO_USER_ID } : null,
  );

  const deps = buildGatewayDeps({
    db: pool,
    redis,
    enableWebSocket: true,
    authenticate,
    capabilities: CAPABILITIES,
  });

  const app = createServer(deps, { logger: true, cors: { origin: corsOrigin } });

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`\n[api] ${signal} received — shutting down`);
    await app.close();
    await pool.end().catch(() => undefined);
    if (redis) redis.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`[api] gateway listening on http://${host}:${port}`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error("[api] failed to start:", err);
  process.exit(1);
});
