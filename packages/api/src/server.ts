/**
 * Fastify server factory for the outbound API gateway (design.md "Component 5:
 * Outbound API Gateway"). `createServer(deps)` wires the read-only discovery /
 * detail / history / sources routes over the framework-agnostic handlers,
 * injecting the storage/Redis reader ports so the gateway never touches an
 * upstream platform (Requirement 9.1).
 *
 * Dependency injection keeps the server testable: tests construct it with
 * in-memory fakes and exercise routes via Fastify's `inject` (no port binding,
 * no real infra). A typed error handler maps {@link ValidationError} → 400
 * (Requirement 9.3), {@link NotFoundError} → 404, and {@link UnauthorizedError}
 * → 401 (Requirement 9.4).
 *
 * Gateway hardening (task 7.5 / Requirement 9.3, 9.4):
 *   - Unified rate limiting: `@fastify/rate-limit` is registered globally so a
 *     single per-client (IP) policy applies uniformly across every public read
 *     endpoint; exceeding it yields 429 with a stable error body + the standard
 *     `x-ratelimit-*` / `retry-after` headers. Tunable via
 *     {@link CreateServerOptions.rateLimit} (tests set a low `max` to assert 429).
 *   - Input validation: every public read endpoint validates its query/path
 *     params through the pure parsers in `validation.ts` (→ 400). The unified
 *     approach: parse-at-the-edge, one `ValidationError` → 400 mapping.
 *   - Authentication: user-scoped resources require auth via the {@link requireAuth}
 *     preHandler (exported for task 8's watchlist/alerts routes), backed by the
 *     injectable {@link GatewayDeps.authenticate} port. Safe-by-default: when no
 *     authenticator is configured, user-scoped routes are CLOSED (401).
 *
 * Routes (task 7.1):
 *   GET /api/markets                  discovery (category/q/status filter, sort)
 *   GET /api/markets/:id              detail (metadata + outcomes + latest price)
 *   GET /api/markets/:id/history      price-history time-series
 *   GET /api/markets/:id/trade-link   outbound source deep-link (navigation only)
 *   GET /api/sources                  registered platforms + capabilities
 *   GET /healthz                      liveness probe
 *
 * Routes (task 7.2):
 *   GET /api/canonical-events         cross-platform groupings (optional category)
 *   GET /api/canonical-events/:id     same-question comparison view (mismatch flags)
 *   GET /api/signals                  display-only spread signals (ranked by gap)
 *
 * Route (task 7.4):
 *   WS  /ws                           Redis-pub/sub-fed fan-out (market/canonical/alerts)
 *
 * Routes (task 8.1 — user-scoped, authenticated via `requireAuth`; mounted only
 * when a watchlist store is injected):
 *   GET    /api/watchlist             list the authenticated user's items
 *   POST   /api/watchlist             add { targetType, targetId } (idempotent → 200)
 *   DELETE /api/watchlist/:itemId     remove the user's item (404 if unknown/un-owned)
 *
 * Routes (task 8.2 — user-scoped, authenticated via `requireAuth`; mounted only
 * when an alert store is injected):
 *   GET    /api/alerts                list the authenticated user's alert rules
 *   POST   /api/alerts                create { targetType, targetId, ruleType, params } → 201
 *   DELETE /api/alerts/:alertId       remove the user's rule (404 if unknown/un-owned)
 */

import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCors from "@fastify/cors";
import type { GatewayDeps } from "./dto.js";
import { NotFoundError, UnauthorizedError, ValidationError, type ErrorResponse } from "./errors.js";
import {
  handleGetCanonicalEvent,
  handleGetMarket,
  handleGetMarketHistory,
  handleGetTradeLink,
  handleListCanonicalEvents,
  handleListMarkets,
  handleListSignals,
  handleListSources,
} from "./handlers.js";
import {
  handleAddWatchlist,
  handleDeleteWatchlist,
  handleListWatchlist,
} from "./watchlist.handlers.js";
import { handleCreateAlert, handleDeleteAlert, handleListAlerts } from "./alert.handlers.js";
import { requireAuth } from "./auth.js";
import {
  parseAddWatchlistBody,
  parseAlertId,
  parseCanonicalEventId,
  parseCanonicalEventsQuery,
  parseCreateAlertBody,
  parseDiscoveryQuery,
  parseHistoryQuery,
  parseMarketId,
  parseSignalsQuery,
  parseWatchlistItemId,
  type RawParams,
} from "./validation.js";
import { registerWebSocketFanout } from "./websocket.js";

/** Tunables for the gateway's unified rate limiter (Requirement 9.3). */
export interface RateLimitOptions {
  /**
   * Max requests a single client (keyed by IP) may make per {@link timeWindow}
   * across the public read endpoints. Default: 300.
   */
  max?: number;
  /**
   * The rolling window, in milliseconds or an `ms`-format string (e.g.
   * `"1 minute"`). Default: `"1 minute"`.
   */
  timeWindow?: number | string;
  /** IPs excluded from rate limiting (e.g. health checkers). Default: none. */
  allowList?: string[];
}

/** Options for {@link createServer}. */
export interface CreateServerOptions {
  /** Enable Fastify's built-in logger (default: false). */
  logger?: boolean;
  /**
   * Cross-Origin Resource Sharing (CORS) policy for browser clients. The
   * browser frontend (`apps/web`) is served from a different origin (e.g.
   * `http://localhost:3000`) than the gateway (`:4000`), so a cross-origin
   * `fetch` is blocked unless the gateway returns the matching
   * `Access-Control-Allow-Origin` header (and answers the preflight `OPTIONS`).
   *
   * Pass `{ origin }` to allow specific origin(s); `true` reflects the request
   * origin (convenient for local dev). Omit / `false` to disable CORS entirely
   * (the default — same-origin or server-to-server callers need no CORS).
   */
  cors?: { origin: string | string[] | boolean } | false;
  /**
   * Unified rate-limit policy applied across the public read endpoints
   * (Requirement 9.3). Pass a low `max` in tests to assert 429. Set `false` to
   * disable entirely (not recommended for a network-exposed deployment).
   */
  rateLimit?: RateLimitOptions | false;
  /**
   * Trust the `X-Forwarded-For` header when deriving the client IP for rate
   * limiting (set when running behind a reverse proxy / load balancer). Default:
   * false (use the socket address).
   */
  trustProxy?: boolean;
}

/** Default unified rate-limit policy (Requirement 9.3). */
const DEFAULT_RATE_LIMIT: Required<Pick<RateLimitOptions, "max" | "timeWindow">> = {
  max: 300,
  timeWindow: "1 minute",
};

/**
 * Build (but do not listen on) a configured Fastify instance. The caller owns
 * the lifecycle (`listen`/`close`); tests use `app.inject(...)`.
 */
export function createServer(
  deps: GatewayDeps,
  options: CreateServerOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Honor X-Forwarded-For for the rate-limit client key when behind a proxy.
    trustProxy: options.trustProxy ?? false,
  });
  const now = deps.now ?? Date.now;

  // Map typed handler errors to HTTP status codes + a stable JSON body shape.
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ValidationError) {
      const body: ErrorResponse = {
        error: { code: "VALIDATION_ERROR", message: error.message, field: error.field },
      };
      return reply.status(400).send(body);
    }
    if (error instanceof NotFoundError) {
      const body: ErrorResponse = { error: { code: "NOT_FOUND", message: error.message } };
      return reply.status(404).send(body);
    }
    // Authn failure on a user-scoped resource (Requirement 9.4).
    if (error instanceof UnauthorizedError) {
      const body: ErrorResponse = { error: { code: "UNAUTHORIZED", message: error.message } };
      return reply.status(401).send(body);
    }
    // Rate-limit rejection from @fastify/rate-limit (Requirement 9.3): the
    // plugin throws an Error with statusCode 429 (and has already set the
    // x-ratelimit-* / retry-after headers on the reply).
    if (error.statusCode === 429) {
      const body: ErrorResponse = { error: { code: "RATE_LIMITED", message: error.message } };
      return reply.status(429).send(body);
    }
    // Fastify's own validation/parse errors carry a statusCode; honor 4xx.
    if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      const body: ErrorResponse = {
        error: { code: "BAD_REQUEST", message: error.message },
      };
      return reply.status(error.statusCode).send(body);
    }
    const body: ErrorResponse = {
      error: { code: "INTERNAL_ERROR", message: "Internal Server Error" },
    };
    return reply.status(500).send(body);
  });

  // Cross-origin support (browser frontend on a different origin). Registered
  // first so its preflight/OPTIONS handling and `Access-Control-Allow-Origin`
  // headers apply across every route, including the rate-limited ones. The
  // `fastify-plugin`-wrapped CORS plugin attaches to this shared instance and is
  // inherited by the encapsulated route plugin below. Disabled by default.
  if (options.cors) {
    app.register(fastifyCors, {
      origin: options.cors.origin,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["authorization", "content-type"],
    });
  }

  // Unified rate limiting (Requirement 9.3): one global per-client (IP) policy
  // applied across every public read endpoint. Registered BEFORE the routes so
  // its `onRoute` hook is installed by the time the route plugin below loads
  // (avvio loads plugins in registration order); `@fastify/rate-limit` is
  // `fastify-plugin`-wrapped, so the hook attaches to this shared instance and
  // is inherited by the encapsulated route plugin. Disable with `rateLimit:false`.
  if (options.rateLimit !== false) {
    const rl = options.rateLimit ?? {};
    app.register(fastifyRateLimit, {
      global: true,
      max: rl.max ?? DEFAULT_RATE_LIMIT.max,
      timeWindow: rl.timeWindow ?? DEFAULT_RATE_LIMIT.timeWindow,
      ...(rl.allowList ? { allowList: rl.allowList } : {}),
    });
  }

  // All REST routes live in a child plugin registered AFTER the rate limiter so
  // the global limit applies uniformly. The liveness probe opts out (rate
  // limiting a health check can cause false-positive liveness failures).
  app.register(async (instance) => {
    instance.get("/healthz", { config: { rateLimit: false } }, async () => ({ status: "ok" }));

    // GET /api/markets — discovery.
    instance.get("/api/markets", async (request) => {
      const query = parseDiscoveryQuery((request.query ?? {}) as RawParams);
      return handleListMarkets(deps, query);
    });

    // GET /api/markets/:id — detail. Registered before :id/history so Fastify's
    // radix router disambiguates cleanly (both are valid distinct routes).
    instance.get("/api/markets/:id", async (request) => {
      const id = parseMarketId((request.params ?? {}) as RawParams);
      return handleGetMarket(deps, id);
    });

    // GET /api/markets/:id/history — price-history time-series.
    instance.get("/api/markets/:id/history", async (request) => {
      const id = parseMarketId((request.params ?? {}) as RawParams);
      const query = parseHistoryQuery((request.query ?? {}) as RawParams, now);
      return handleGetMarketHistory(deps, id, query);
    });

    // GET /api/markets/:id/trade-link — outbound source deep-link (navigation
    // only; executable:false). The future "one-click participate" slot.
    instance.get("/api/markets/:id/trade-link", async (request) => {
      const id = parseMarketId((request.params ?? {}) as RawParams);
      return handleGetTradeLink(deps, id);
    });

    // GET /api/sources — registered platforms + capabilities.
    instance.get("/api/sources", async () => handleListSources(deps));

    // GET /api/canonical-events — cross-platform groupings (optional category).
    instance.get("/api/canonical-events", async (request) => {
      const query = parseCanonicalEventsQuery((request.query ?? {}) as RawParams);
      return handleListCanonicalEvents(deps, query);
    });

    // GET /api/canonical-events/:id — same-question comparison view.
    instance.get("/api/canonical-events/:id", async (request) => {
      const id = parseCanonicalEventId((request.params ?? {}) as RawParams);
      return handleGetCanonicalEvent(deps, id);
    });

    // GET /api/signals — display-only spread signals ranked by largest gap.
    instance.get("/api/signals", async (request) => {
      const query = parseSignalsQuery((request.query ?? {}) as RawParams);
      return handleListSignals(deps, query);
    });

    // -----------------------------------------------------------------------
    // Watchlist (task 8.1) — user-scoped, authenticated routes (Requirements
    // 5.1, 5.4, 9.4). Each is guarded by `requireAuth(deps.authenticate)`:
    // unauthenticated requests get 401 (safe-by-default closed when no
    // authenticator is wired). The authenticated `request.user.userId` scopes
    // every operation so a user only ever touches their own items.
    //
    // Mounted only when a watchlist store is injected; otherwise the routes are
    // absent (a deployment without watchlist persistence simply omits them).
    // -----------------------------------------------------------------------
    if (deps.watchlist !== undefined) {
      const auth = requireAuth(deps.authenticate);

      // GET /api/watchlist — list the authenticated user's items.
      instance.get("/api/watchlist", { preHandler: auth }, async (request) => {
        return handleListWatchlist(deps, request.user!.userId);
      });

      // POST /api/watchlist — add { targetType, targetId }. Idempotent: a
      // duplicate add returns the existing item (no duplicate row). Returns 200
      // consistently for both created and existing entries.
      instance.post("/api/watchlist", { preHandler: auth }, async (request) => {
        const body = parseAddWatchlistBody(request.body);
        return handleAddWatchlist(deps, request.user!.userId, body);
      });

      // DELETE /api/watchlist/:itemId — remove the user's item (404 when
      // unknown or owned by another user). 204 No Content on success.
      instance.delete("/api/watchlist/:itemId", { preHandler: auth }, async (request, reply) => {
        const itemId = parseWatchlistItemId((request.params ?? {}) as RawParams);
        await handleDeleteWatchlist(deps, request.user!.userId, itemId);
        return reply.status(204).send();
      });
    }

    // -----------------------------------------------------------------------
    // Alerts (task 8.2) — user-scoped, authenticated routes (Requirements
    // 5.2, 5.4, 9.4). Each is guarded by `requireAuth(deps.authenticate)`:
    // unauthenticated requests get 401 (safe-by-default closed when no
    // authenticator is wired). The authenticated `request.user.userId` scopes
    // every operation so a user only ever touches their own rules.
    //
    // Mounted only when an alert store is injected; otherwise the routes are
    // absent (a deployment without alert persistence simply omits them).
    // -----------------------------------------------------------------------
    if (deps.alerts !== undefined) {
      const auth = requireAuth(deps.authenticate);

      // GET /api/alerts — list the authenticated user's alert rules.
      instance.get("/api/alerts", { preHandler: auth }, async (request) => {
        return handleListAlerts(deps, request.user!.userId);
      });

      // POST /api/alerts — create { targetType, targetId, ruleType, params }.
      // Persists the rule with its params + active flag (Req 5.2). NOT
      // deduplicated — multiple rules per target are allowed. Returns 201.
      instance.post("/api/alerts", { preHandler: auth }, async (request, reply) => {
        const body = parseCreateAlertBody(request.body);
        const created = await handleCreateAlert(deps, request.user!.userId, body);
        return reply.status(201).send(created);
      });

      // DELETE /api/alerts/:alertId — remove the user's rule (404 when unknown
      // or owned by another user). 204 No Content on success.
      instance.delete("/api/alerts/:alertId", { preHandler: auth }, async (request, reply) => {
        const alertId = parseAlertId((request.params ?? {}) as RawParams);
        await handleDeleteAlert(deps, request.user!.userId, alertId);
        return reply.status(204).send();
      });
    }
  });

  // WS /ws — Redis-pub/sub-fed fan-out (task 7.4). Mounted only when a
  // subscriber factory is injected; the REST-only server omits it entirely.
  registerWebSocketFanout(app, deps);

  return app;
}
