/**
 * Helper to assemble {@link GatewayDeps} from a live Postgres pool + Redis hot
 * cache, for the runnable server entrypoint. Tests inject their own fakes and
 * do NOT use this; it exists so a real deployment can wire concrete
 * `@pma/storage` repositories without the gateway importing infra ad hoc.
 *
 * All dependencies are storage/Redis-backed — the gateway never imports an
 * adapter or reaches an upstream platform (Requirement 9.1). The watchlist
 * store is the one read/write port (user-scoped persistence, task 8.1); all
 * others are read-only.
 */

import type { SourceCapabilities } from "@pma/core";
import {
  CanonicalEventRepository,
  createRedisClient,
  FanoutSubscriber,
  HotPriceCache,
  MarketDiscoveryRepository,
  OutcomeRepository,
  PricePointRepository,
  SourceRepository,
  WatchlistRepository,
  AlertRuleRepository,
  type Queryable,
  type RedisClient,
} from "@pma/storage";
import type { Authenticator } from "./auth.js";
import type { FanoutSubscriberFactory, GatewayDeps } from "./dto.js";

/** Inputs for {@link buildGatewayDeps}. */
export interface BuildGatewayDepsOptions {
  /** A Postgres {@link Queryable} (pool or client). */
  db: Queryable;
  /** A connected Redis client for the hot-price cache (Requirement 10.4). */
  redis?: RedisClient;
  /**
   * Enable the `WS /ws` fan-out (task 7.4 / Requirement 9.2) by supplying a
   * factory that produces a dedicated Redis subscriber connection per WS client.
   * Defaults to wiring `FanoutSubscriber` over a fresh `createRedisClient()`
   * when `enableWebSocket` is true. Subscribing requires a connection in
   * subscriber mode SEPARATE from the hot-cache `redis` connection above, hence
   * a factory (one new connection per WS client) rather than reusing `redis`.
   */
  enableWebSocket?: boolean;
  /**
   * Override the WS subscriber factory (e.g. to point at a different Redis URL
   * or inject instrumentation). Implies the `WS /ws` route is mounted.
   */
  fanoutSubscriberFactory?: FanoutSubscriberFactory;
  /** Per-source-key adapter capabilities (declared in code, not persisted). */
  capabilities?: Record<string, SourceCapabilities>;
  /**
   * Authenticator for user-scoped resources (Requirement 9.4). Required for the
   * watchlist routes to be usable: `requireAuth` is safe-by-default closed, so
   * without an authenticator every watchlist request gets 401. A deployment
   * wires a JWT/session verifier here (e.g. via `bearerAuthenticator`).
   */
  authenticate?: Authenticator;
  /**
   * Enable the user-scoped watchlist routes (task 8.1) by wiring a
   * `WatchlistRepository` over `db`. Defaults to `true` so a full deployment
   * exposes the watchlist; set `false` for a read-only gateway.
   */
  enableWatchlist?: boolean;
  /**
   * Enable the user-scoped alert routes (task 8.2) by wiring an
   * `AlertRuleRepository` over `db`. Defaults to `true` so a full deployment
   * exposes alerts; set `false` for a read-only gateway. Like the watchlist,
   * the routes still require an authenticator to be usable (requireAuth is
   * closed by default).
   */
  enableAlerts?: boolean;
  /** Clock override (testing). */
  now?: () => number;
}

/**
 * Construct the gateway's dependency bundle from concrete `@pma/storage`
 * repositories. The hot-price cache is included only when a Redis client is
 * provided; otherwise latest prices fall back to stored outcome data.
 *
 * The WS fan-out (task 7.4) is wired when `fanoutSubscriberFactory` is given, or
 * when `enableWebSocket` is true (default factory: a `FanoutSubscriber` over a
 * fresh dedicated `createRedisClient()` per WS client connection).
 */
export function buildGatewayDeps(options: BuildGatewayDepsOptions): GatewayDeps {
  const deps: GatewayDeps = {
    discovery: new MarketDiscoveryRepository(options.db),
    outcomes: new OutcomeRepository(options.db),
    prices: new PricePointRepository(options.db),
    sources: new SourceRepository(options.db),
    canonicalEvents: new CanonicalEventRepository(options.db),
  };
  if (options.redis) deps.hotPrices = new HotPriceCache(options.redis);
  if (options.capabilities) deps.capabilities = options.capabilities;
  if (options.authenticate) deps.authenticate = options.authenticate;
  // Watchlist persistence (task 8.1). Enabled by default; the routes still
  // require an authenticator to be usable (requireAuth is closed by default).
  if (options.enableWatchlist !== false) {
    deps.watchlist = new WatchlistRepository(options.db);
  }
  // Alert-rule persistence (task 8.2). Enabled by default; the routes still
  // require an authenticator to be usable (requireAuth is closed by default).
  if (options.enableAlerts !== false) {
    deps.alerts = new AlertRuleRepository(options.db);
  }
  if (options.fanoutSubscriberFactory) {
    deps.fanoutSubscriberFactory = options.fanoutSubscriberFactory;
  } else if (options.enableWebSocket) {
    // One dedicated subscriber-mode Redis connection per WS client connection.
    deps.fanoutSubscriberFactory = () => new FanoutSubscriber(createRedisClient());
  }
  if (options.now) deps.now = options.now;
  return deps;
}
