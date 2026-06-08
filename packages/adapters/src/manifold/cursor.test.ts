import { describe, it, expect } from "vitest";
import {
  computeNextCursor,
  cursorToQuery,
  decodeCursor,
  encodeCursor,
  START_CURSOR,
  type DecodedCursor,
} from "./cursor.js";

/**
 * Unit tests for Manifold's opaque keyset-cursor handling (the `before` id
 * scheme). They verify round-tripping (encode∘decode), graceful handling of
 * malformed cursors (→ start), the query mapping, and end-of-stream detection.
 */

describe("decodeCursor / encodeCursor", () => {
  it("treats undefined and empty as the start cursor (no before)", () => {
    expect(decodeCursor(undefined)).toEqual(START_CURSOR);
    expect(decodeCursor("")).toEqual(START_CURSOR);
  });

  it("round-trips a before cursor", () => {
    const cursor: DecodedCursor = { before: "contract-123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("falls back to start on a malformed cursor (never throws)", () => {
    expect(decodeCursor("!!!not-base64!!!")).toEqual(START_CURSOR);
    expect(decodeCursor(Buffer.from("not json", "utf8").toString("base64url"))).toEqual(
      START_CURSOR,
    );
  });
});

describe("cursorToQuery", () => {
  it("emits only limit at the start", () => {
    expect(cursorToQuery(START_CURSOR, 50)).toEqual({ limit: 50 });
  });

  it("emits before+limit once a keyset id is set", () => {
    expect(cursorToQuery({ before: "c-9" }, 25)).toEqual({
      before: "c-9",
      limit: 25,
    });
  });
});

describe("computeNextCursor", () => {
  it("advances to before=<lastId> on a full page", () => {
    const next = computeNextCursor({
      lastId: "c-last",
      pageSize: 50,
      limit: 50,
    });
    expect(decodeCursor(next ?? undefined)).toEqual({ before: "c-last" });
  });

  it("returns null on a short page (end of stream)", () => {
    expect(computeNextCursor({ lastId: "c-last", pageSize: 20, limit: 50 })).toBeNull();
  });

  it("returns null when the last item has no usable id", () => {
    expect(computeNextCursor({ lastId: null, pageSize: 50, limit: 50 })).toBeNull();
  });
});
