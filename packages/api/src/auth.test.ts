/**
 * Unit tests for the gateway authentication primitives (task 7.5 / Requirement
 * 9.4): the `requireAuth` preHandler, the `bearerAuthenticator` adapter, and the
 * `extractBearerToken` helper. These exercise the auth logic directly (with a
 * minimal fake Fastify request) so they don't depend on task 8's not-yet-built
 * watchlist/alerts routes — `requireAuth` is the seam those routes will attach.
 */

import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  bearerAuthenticator,
  extractBearerToken,
  requireAuth,
  type Authenticator,
} from "./auth.js";
import { UnauthorizedError } from "./errors.js";

/** Build a minimal FastifyRequest stand-in carrying just the headers we read. */
function fakeRequest(headers: Record<string, string> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

const NOOP_REPLY = {} as FastifyReply;

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed Authorization header", () => {
    expect(extractBearerToken(fakeRequest({ authorization: "Bearer abc.def.ghi" }))).toBe(
      "abc.def.ghi",
    );
  });

  it("is case-insensitive on the scheme and tolerates extra whitespace", () => {
    expect(extractBearerToken(fakeRequest({ authorization: "bearer   token123" }))).toBe(
      "token123",
    );
  });

  it("returns null when the header is absent", () => {
    expect(extractBearerToken(fakeRequest())).toBeNull();
  });

  it("returns null for a non-bearer scheme", () => {
    expect(extractBearerToken(fakeRequest({ authorization: "Basic dXNlcjpwYXNz" }))).toBeNull();
  });

  it("returns null when the bearer token is empty", () => {
    expect(extractBearerToken(fakeRequest({ authorization: "Bearer    " }))).toBeNull();
  });
});

describe("bearerAuthenticator", () => {
  it("resolves the identity returned by the injected verifier", async () => {
    const auth = bearerAuthenticator((token) => (token === "good" ? { userId: "u-1" } : null));
    await expect(auth(fakeRequest({ authorization: "Bearer good" }))).resolves.toEqual({
      userId: "u-1",
    });
  });

  it("returns null (and does not call verify) when no bearer token is present", async () => {
    let called = false;
    const auth = bearerAuthenticator(() => {
      called = true;
      return { userId: "u-1" };
    });
    await expect(auth(fakeRequest())).resolves.toBeNull();
    expect(called).toBe(false);
  });

  it("returns null when the verifier rejects the token", async () => {
    const auth = bearerAuthenticator(() => null);
    await expect(auth(fakeRequest({ authorization: "Bearer nope" }))).resolves.toBeNull();
  });
});

describe("requireAuth preHandler", () => {
  it("throws 401 when no authenticator is configured (safe-by-default closed)", async () => {
    const preHandler = requireAuth(undefined);
    await expect(preHandler(fakeRequest(), NOOP_REPLY)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws 401 when the authenticator resolves null (missing/invalid token)", async () => {
    const preHandler = requireAuth(async () => null);
    const req = fakeRequest({ authorization: "Bearer invalid" });
    await expect(preHandler(req, NOOP_REPLY)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(req.user).toBeUndefined();
  });

  it("passes and assigns request.user for a valid identity", async () => {
    const authenticate: Authenticator = async () => ({ userId: "u-42" });
    const preHandler = requireAuth(authenticate);
    const req = fakeRequest({ authorization: "Bearer ok" });
    await expect(preHandler(req, NOOP_REPLY)).resolves.toBeUndefined();
    expect(req.user).toEqual({ userId: "u-42" });
  });

  it("supports a synchronous authenticator returning an identity", async () => {
    const preHandler = requireAuth(() => ({ userId: "sync-user" }));
    const req = fakeRequest({ authorization: "Bearer ok" });
    await preHandler(req, NOOP_REPLY);
    expect(req.user).toEqual({ userId: "sync-user" });
  });

  it("the carried UnauthorizedError reports statusCode 401", async () => {
    const preHandler = requireAuth(undefined);
    await preHandler(fakeRequest(), NOOP_REPLY).catch((err: unknown) => {
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as UnauthorizedError).statusCode).toBe(401);
    });
  });
});
