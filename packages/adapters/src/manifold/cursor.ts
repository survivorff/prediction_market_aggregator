/**
 * Opaque keyset-cursor handling for Manifold pagination.
 *
 * The orchestrator treats `PageRequest.cursor` / `Page.nextCursor` as opaque
 * strings (design `MarketSource`). Manifold's `/v0/markets` endpoint paginates
 * by **keyset**: you pass `before=<contractId>` to receive the page of markets
 * immediately older than that contract (results are newest-first). This module
 * centralizes that scheme behind one opaque cursor so the adapter — and the
 * rest of the system — never branches on the upstream style (`keysetPagination`
 * capability is therefore `true`).
 *
 * Encoding: a cursor is JSON `{ before }` then base64url-encoded. Decoding never
 * throws: a malformed/legacy cursor is treated as "start" (no `before`).
 *
 * Pure module — no I/O.
 */

import { asStringOrNull, getField } from "./safe.js";

/** Decoded cursor: the contract id to pass as `before`, or null at the start. */
export interface DecodedCursor {
  /** Contract id to fetch markets *before*; `null` = start of stream. */
  before: string | null;
}

/** The cursor representing the start of a stream (no `before`). */
export const START_CURSOR: DecodedCursor = { before: null };

/** Decode an opaque cursor string; `undefined`/malformed → start. */
export function decodeCursor(cursor: string | undefined): DecodedCursor {
  if (cursor === undefined || cursor === "") return START_CURSOR;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    const before = asStringOrNull(getField(parsed, "before"));
    if (before !== null) return { before };
  } catch {
    // fall through to start
  }
  return START_CURSOR;
}

/** Encode a decoded cursor into an opaque base64url string. */
export function encodeCursor(decoded: DecodedCursor): string {
  return Buffer.from(JSON.stringify({ before: decoded.before }), "utf8").toString("base64url");
}

/**
 * Translate a decoded cursor into the Manifold query parameters to send. At the
 * start there is no `before`; subsequent pages pass the keyset id.
 */
export function cursorToQuery(
  decoded: DecodedCursor,
  limit: number,
): Record<string, string | number> {
  if (decoded.before !== null) {
    return { before: decoded.before, limit };
  }
  return { limit };
}

/**
 * Compute the next opaque cursor from an upstream page.
 *
 * Manifold returns a short page (fewer items than `limit`) at the end of the
 * stream → `null`. Otherwise the next page is everything *before* the last
 * contract id on this page, so we encode that id as the new cursor. If the last
 * item lacks a usable id we cannot safely advance → `null` (end).
 */
export function computeNextCursor(input: {
  lastId: string | null;
  pageSize: number;
  limit: number;
}): string | null {
  const { lastId, pageSize, limit } = input;
  if (pageSize < limit) return null;
  if (lastId === null) return null;
  return encodeCursor({ before: lastId });
}
