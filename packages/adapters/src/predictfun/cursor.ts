/**
 * Opaque cursor handling for Predict.fun pagination.
 *
 * The orchestrator treats `PageRequest.cursor` / `Page.nextCursor` as opaque
 * strings (design `MarketSource`). Predict.fun's `GET /v1/markets` returns a
 * cursor-paginated envelope `{ data: [...], cursor: "<base64>" }`; you pass that
 * `cursor` value back as `?cursor=` to fetch the next page, and keep going until
 * the response is empty / carries no further cursor (`keysetPagination` is
 * therefore `true`).
 *
 * Predict.fun's `cursor` is itself an opaque base64 token, so we pass it through
 * verbatim as our opaque cursor — no extra wrapping is needed. Decoding never
 * throws: a missing/empty cursor is treated as "start".
 *
 * Pure module — no I/O.
 */

import { asStringOrNull, getFirstField } from "./safe.js";

/** Decoded cursor: the upstream token to pass as `cursor`, or null at the start. */
export interface DecodedCursor {
  /** Predict.fun cursor token; `null` = start of stream. */
  token: string | null;
}

/** The cursor representing the start of a stream (no token). */
export const START_CURSOR: DecodedCursor = { token: null };

/** Decode an opaque cursor string; `undefined`/empty → start. */
export function decodeCursor(cursor: string | undefined): DecodedCursor {
  const token = asStringOrNull(cursor);
  return token === null ? START_CURSOR : { token };
}

/**
 * Translate a decoded cursor into the Predict.fun query parameters to send. At
 * the start there is no `cursor`; subsequent pages pass the upstream token.
 */
export function cursorToQuery(
  decoded: DecodedCursor,
  limit: number,
): Record<string, string | number> {
  if (decoded.token !== null) {
    return { cursor: decoded.token, limit };
  }
  return { limit };
}

/**
 * Read the upstream `cursor` token from a `/v1/markets` envelope (or `null`
 * when absent — e.g. a bare array response or end of stream).
 */
export function readResponseCursor(body: unknown): string | null {
  return asStringOrNull(getFirstField(body, ["cursor", "nextCursor", "next_cursor"]));
}

/**
 * Compute the next opaque cursor from an upstream page.
 *
 * Predict.fun signals end-of-stream by returning an empty page and/or omitting
 * the cursor. We advance only when the server returned a non-empty token AND the
 * page carried at least one item; otherwise the stream is exhausted (`null`).
 */
export function computeNextCursor(input: {
  serverCursor: string | null;
  pageSize: number;
}): string | null {
  const { serverCursor, pageSize } = input;
  if (serverCursor === null || pageSize === 0) return null;
  return serverCursor;
}
