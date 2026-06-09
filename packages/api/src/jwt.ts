/**
 * HS256 JWT verification for the gateway's bearer authentication (Requirement
 * 9.4). A dependency-free, production-usable {@link BearerTokenVerifier} that
 * verifies a JSON Web Token signed with HMAC-SHA256 and resolves it to an
 * {@link AuthenticatedUser} from the `sub` claim.
 *
 * Security posture:
 *   - Only the `HS256` algorithm is accepted; `alg: none` and any other
 *     algorithm are rejected (defends against algorithm-confusion attacks).
 *   - The signature is compared in constant time ({@link timingSafeEqual}).
 *   - `exp` (expiry) and `nbf` (not-before) are enforced when present, with a
 *     small clock-skew leeway.
 *   - A missing/blank `sub` claim is rejected.
 *
 * This is the standard symmetric-key path (shared secret). A deployment using
 * an asymmetric IdP (RS256/ES256) would add a public-key verifier behind the
 * same {@link BearerTokenVerifier} seam; the gateway wiring does not change.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthenticatedUser, BearerTokenVerifier } from "./auth.js";

/** Options for {@link verifyJwtHs256} / {@link jwtBearerVerifier}. */
export interface JwtVerifyOptions {
  /** Allowed clock skew (seconds) for `exp`/`nbf` checks. Default 60. */
  clockToleranceSec?: number;
  /** Required `aud` (audience) claim, when set. */
  audience?: string;
  /** Required `iss` (issuer) claim, when set. */
  issuer?: string;
  /** Clock (ms since epoch) — injectable for deterministic tests. */
  now?: () => number;
}

/** Decoded JWT claims relevant to verification (others are ignored). */
interface JwtClaims {
  sub?: unknown;
  exp?: unknown;
  nbf?: unknown;
  aud?: unknown;
  iss?: unknown;
}

/** base64url-decode to a Buffer (tolerant of missing padding). */
function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/**
 * Verify an HS256 JWT against `secret`. Returns the {@link AuthenticatedUser}
 * (`userId` = `sub`) when the token is valid and unexpired, or `null` for any
 * verification failure (bad shape, wrong alg, bad signature, expired, missing
 * sub, audience/issuer mismatch). Never throws for an invalid token.
 */
export function verifyJwtHs256(
  token: string,
  secret: string,
  options: JwtVerifyOptions = {},
): AuthenticatedUser | null {
  if (typeof token !== "string" || secret === "") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  // Header: must declare HS256 (reject alg:none / algorithm confusion).
  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as typeof header;
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;

  // Signature: HMAC-SHA256 over "header.payload", constant-time compared.
  const expected = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest();
  let provided: Buffer;
  try {
    provided = base64UrlDecode(signatureB64);
  } catch {
    return null;
  }
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return null;
  }

  // Claims.
  let claims: JwtClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf8")) as JwtClaims;
  } catch {
    return null;
  }

  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);
  const leeway = options.clockToleranceSec ?? 60;
  if (typeof claims.exp === "number" && nowSec > claims.exp + leeway) return null;
  if (typeof claims.nbf === "number" && nowSec + leeway < claims.nbf) return null;
  if (options.audience !== undefined && claims.aud !== options.audience) return null;
  if (options.issuer !== undefined && claims.iss !== options.issuer) return null;

  const sub = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (sub === "") return null;
  return { userId: sub };
}

/**
 * Build a {@link BearerTokenVerifier} that verifies HS256 JWTs with `secret`.
 * Drops directly into {@link bearerAuthenticator} for the gateway's
 * `authenticate` port.
 */
export function jwtBearerVerifier(secret: string, options: JwtVerifyOptions = {}): BearerTokenVerifier {
  return (token: string) => verifyJwtHs256(token, secret, options);
}
