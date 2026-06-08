/**
 * Opaque keyset-cursor handling for Gamma pagination.
 *
 * The orchestrator treats `PageRequest.cursor` / `Page.nextCursor` as opaque
 * strings (design `MarketSource`). Gamma exposes two pagination styles over
 * time: a native keyset token (`next_cursor`) and offset/limit. This module
 * centralizes both behind one opaque cursor so the adapter — and the rest of
 * the system — never branches on the upstream style.
 *
 * Encoding: a cursor is JSON `{ kind, value }` then base64url-encoded. `kind`
 * is either a native keyset token or an offset. Decoding never throws: a
 * malformed/legacy cursor is treated as "start".
 *
 * Pure module — no I/O.
 */

import { asFiniteNumberOrNull, asStringOrNull, getFirstField } from "./safe.js";

/** Decoded cursor: either an upstream keyset token or a numeric offset. */
export type DecodedCursor = { kind: "keyset"; token: string } | { kind: "offset"; offset: number };

/** The cursor representing the start of a stream. */
export const START_CURSOR: DecodedCursor = { kind: "offset", offset: 0 };

/** Decode an opaque cursor string; `undefined`/malformed → start. */
export function decodeCursor(cursor: string | undefined): DecodedCursor {
  if (cursor === undefined || cursor === "") return START_CURSOR;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    const token = asStringOrNull(getFirstField(parsed, ["token"]));
    if (getFirstField(parsed, ["kind"]) === "keyset" && token !== null) {
      return { kind: "keyset", token };
    }
    const offset = asFiniteNumberOrNull(getFirstField(parsed, ["offset"]));
    if (offset !== null && offset >= 0) {
      return { kind: "offset", offset: Math.floor(offset) };
    }
  } catch {
    // fall through to start
  }
  return START_CURSOR;
}

/** Encode a decoded cursor into an opaque base64url string. */
export function encodeCursor(decoded: DecodedCursor): string {
  const payload =
    decoded.kind === "keyset"
      ? { kind: "keyset", token: decoded.token }
      : { kind: "offset", offset: decoded.offset };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/**
 * Translate a decoded cursor into the Gamma query parameters to send. For a
 * keyset token we pass `next_cursor`; for an offset we pass `offset` + `limit`.
 */
export function cursorToQuery(
  decoded: DecodedCursor,
  limit: number,
): Record<string, string | number> {
  if (decoded.kind === "keyset") {
    return { next_cursor: decoded.token, limit };
  }
  return { offset: decoded.offset, limit };
}

/**
 * Compute the next opaque cursor from an upstream response.
 *
 * - If the response carries a native keyset token, encode it (a sentinel such
 *   as `"LTE="`/`"end"` means no more pages → `null`).
 * - Otherwise use offset arithmetic: a full page implies another page may
 *   exist; a short page means the stream is exhausted (`null`).
 */
export function computeNextCursor(input: {
  current: DecodedCursor;
  nativeToken: string | null;
  pageSize: number;
  limit: number;
}): string | null {
  const { current, nativeToken, pageSize, limit } = input;

  if (nativeToken !== null) {
    // Common "end of stream" sentinels used by keyset APIs.
    if (nativeToken === "" || nativeToken === "LTE=" || nativeToken === "end") {
      return null;
    }
    return encodeCursor({ kind: "keyset", token: nativeToken });
  }

  // Offset style: short page → end of stream.
  if (pageSize < limit) return null;
  const baseOffset = current.kind === "offset" ? current.offset : 0;
  return encodeCursor({ kind: "offset", offset: baseOffset + pageSize });
}
