/**
 * Authentication for user-scoped gateway resources (Requirement 9.4: WHEN a
 * client accesses user-scoped resources (watchlist, alerts) THEN require
 * authentication). design.md "API gateway hardening": network-exposed REST/WS
 * require authentication for user-scoped resources; public read endpoints stay
 * open but rate-limited.
 *
 * The mechanism is injectable so it is NOT hardwired to a specific identity
 * provider: the gateway depends only on a narrow {@link Authenticator} port
 * (`(request) => Promise<AuthenticatedUser | null>`). A real deployment wires a
 * JWT/session verifier; tests inject a fake. The default
 * ({@link bearerAuthenticator}) extracts a `Bearer` token from the
 * `Authorization` header and resolves it via an injected
 * {@link BearerTokenVerifier}.
 *
 * SAFE-BY-DEFAULT POSTURE: when no {@link Authenticator} is configured on the
 * gateway, {@link requireAuth} rejects EVERY user-scoped request with 401. User
 * resources are closed unless an authenticated identity can be resolved — they
 * never open up because auth wiring was forgotten (see `server.ts`).
 */

import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { UnauthorizedError } from "./errors.js";

/**
 * The authenticated identity resolved from a request. Intentionally minimal in
 * v1 (`userId` only); a real verifier can attach more claims via intersection
 * without changing this contract.
 */
export interface AuthenticatedUser {
  userId: string;
}

/**
 * The injectable authentication port. Returns the {@link AuthenticatedUser} for
 * an authenticated request, or `null` when the request carries no/invalid
 * credentials. Implementations MUST NOT throw for the unauthenticated case —
 * returning `null` lets {@link requireAuth} map it to a uniform 401.
 *
 * Structurally satisfied by {@link bearerAuthenticator}; deployments may inject
 * any function (JWT, session cookie, API key, mTLS-derived identity, ...).
 */
export type Authenticator = (
  request: FastifyRequest,
) => Promise<AuthenticatedUser | null> | AuthenticatedUser | null;

/**
 * Verifies a raw bearer token and resolves it to a user id, or `null` when the
 * token is invalid/expired. This is the single seam a production deployment
 * implements (verify a JWT signature, look up a session, etc.); the gateway
 * never embeds IdP-specific logic.
 */
export type BearerTokenVerifier = (
  token: string,
) => Promise<AuthenticatedUser | null> | AuthenticatedUser | null;

/** Extract a `Bearer <token>` value from the `Authorization` header. */
export function extractBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Build an {@link Authenticator} that reads a `Bearer` token from the
 * `Authorization` header and resolves it via the injected {@link verify}
 * function. Returns `null` (→ 401 at the route) when the header is absent,
 * malformed, or the verifier rejects the token. No token verification is
 * hardcoded here — `verify` is the replaceable production seam.
 */
export function bearerAuthenticator(verify: BearerTokenVerifier): Authenticator {
  return async (request) => {
    const token = extractBearerToken(request);
    if (token === null) return null;
    return verify(token);
  };
}

/**
 * Augment {@link FastifyRequest} with the resolved identity so authenticated
 * route handlers can read `request.user` after {@link requireAuth} runs.
 */
declare module "fastify" {
  interface FastifyRequest {
    /** Set by {@link requireAuth} once an identity is resolved. */
    user?: AuthenticatedUser;
  }
}

/**
 * Build a Fastify `preHandler` that enforces authentication for user-scoped
 * routes (Requirement 9.4). Task 8's watchlist/alerts routes attach this as
 * their `preHandler`; it:
 *
 *   1. rejects with 401 ({@link UnauthorizedError}) when no {@link Authenticator}
 *      is configured (safe-by-default: user resources are CLOSED unless auth is
 *      wired);
 *   2. rejects with 401 when the authenticator resolves `null` (missing/invalid
 *      credentials);
 *   3. otherwise assigns `request.user` and lets the request through.
 *
 * The error is thrown (not sent directly) so it flows through the server's
 * unified error handler, yielding the same `{ error: { code, message } }` body
 * shape as every other gateway error.
 */
export function requireAuth(authenticate: Authenticator | undefined): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (authenticate === undefined) {
      throw new UnauthorizedError("Authentication is not configured for this resource");
    }
    const user = await authenticate(request);
    if (user === null || user === undefined) {
      throw new UnauthorizedError();
    }
    request.user = user;
  };
}
