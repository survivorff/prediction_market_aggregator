import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyJwtHs256, jwtBearerVerifier } from "./jwt.js";

/**
 * Unit tests for the HS256 JWT verifier. They cover the happy path (valid token
 * → userId from `sub`) and the security-relevant rejections: wrong signature,
 * `alg: none` / algorithm confusion, expiry, not-before, audience/issuer
 * mismatch, missing `sub`, and malformed tokens.
 */

const SECRET = "test-secret-key";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mint an HS256 JWT for tests (optionally with a tampered/blank signature). */
function sign(
  claims: Record<string, unknown>,
  opts: { secret?: string; alg?: string; signature?: string } = {},
): string {
  const header = b64url(JSON.stringify({ alg: opts.alg ?? "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  if (opts.signature !== undefined) return `${header}.${payload}.${opts.signature}`;
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

const NOW = 1_900_000_000_000; // fixed clock (ms)
const nowSec = Math.floor(NOW / 1000);
const opts = { now: () => NOW };

describe("verifyJwtHs256", () => {
  it("accepts a valid token and resolves sub → userId", () => {
    const token = sign({ sub: "user-123", exp: nowSec + 3600 });
    expect(verifyJwtHs256(token, SECRET, opts)).toEqual({ userId: "user-123" });
  });

  it("rejects a token signed with a different secret", () => {
    const token = sign({ sub: "u" }, { secret: "wrong-secret" });
    expect(verifyJwtHs256(token, SECRET, opts)).toBeNull();
  });

  it("rejects alg:none (algorithm confusion)", () => {
    const token = sign({ sub: "u" }, { alg: "none", signature: "" });
    expect(verifyJwtHs256(token, SECRET, opts)).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = sign({ sub: "u" }, { signature: "deadbeef" });
    expect(verifyJwtHs256(token, SECRET, opts)).toBeNull();
  });

  it("rejects an expired token (beyond leeway)", () => {
    const token = sign({ sub: "u", exp: nowSec - 3600 });
    expect(verifyJwtHs256(token, SECRET, opts)).toBeNull();
  });

  it("accepts a just-expired token within the clock-tolerance leeway", () => {
    const token = sign({ sub: "u", exp: nowSec - 30 });
    expect(verifyJwtHs256(token, SECRET, { now: () => NOW, clockToleranceSec: 60 })).toEqual({
      userId: "u",
    });
  });

  it("rejects a not-yet-valid token (nbf in the future)", () => {
    const token = sign({ sub: "u", nbf: nowSec + 3600 });
    expect(verifyJwtHs256(token, SECRET, opts)).toBeNull();
  });

  it("enforces audience and issuer when configured", () => {
    const token = sign({ sub: "u", aud: "pma", iss: "idp" });
    expect(verifyJwtHs256(token, SECRET, { ...opts, audience: "pma", issuer: "idp" })).toEqual({
      userId: "u",
    });
    expect(verifyJwtHs256(token, SECRET, { ...opts, audience: "other" })).toBeNull();
    expect(verifyJwtHs256(token, SECRET, { ...opts, issuer: "other" })).toBeNull();
  });

  it("rejects a token with a missing/blank sub", () => {
    expect(verifyJwtHs256(sign({ exp: nowSec + 60 }), SECRET, opts)).toBeNull();
    expect(verifyJwtHs256(sign({ sub: "   " }), SECRET, opts)).toBeNull();
  });

  it("rejects malformed tokens and an empty secret", () => {
    expect(verifyJwtHs256("not-a-jwt", SECRET, opts)).toBeNull();
    expect(verifyJwtHs256("a.b", SECRET, opts)).toBeNull();
    expect(verifyJwtHs256(sign({ sub: "u" }), "", opts)).toBeNull();
  });
});

describe("jwtBearerVerifier", () => {
  it("produces a BearerTokenVerifier over verifyJwtHs256", () => {
    const verify = jwtBearerVerifier(SECRET, opts);
    expect(verify(sign({ sub: "user-9", exp: nowSec + 60 }))).toEqual({ userId: "user-9" });
    expect(verify("garbage")).toBeNull();
  });
});
