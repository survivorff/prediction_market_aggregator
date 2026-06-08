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
 * Unit tests for opaque keyset-cursor handling. They verify round-tripping
 * (encode∘decode), graceful handling of malformed cursors (→ start), the two
 * upstream pagination styles, and end-of-stream detection.
 */

describe("decodeCursor / encodeCursor", () => {
  it("treats undefined and empty as the start cursor", () => {
    expect(decodeCursor(undefined)).toEqual(START_CURSOR);
    expect(decodeCursor("")).toEqual(START_CURSOR);
  });

  it("round-trips a keyset cursor", () => {
    const cursor: DecodedCursor = { kind: "keyset", token: "abc123" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("round-trips an offset cursor", () => {
    const cursor: DecodedCursor = { kind: "offset", offset: 250 };
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
  it("emits next_cursor for a keyset cursor", () => {
    expect(cursorToQuery({ kind: "keyset", token: "tok" }, 50)).toEqual({
      next_cursor: "tok",
      limit: 50,
    });
  });

  it("emits offset+limit for an offset cursor", () => {
    expect(cursorToQuery({ kind: "offset", offset: 100 }, 50)).toEqual({
      offset: 100,
      limit: 50,
    });
  });
});

describe("computeNextCursor", () => {
  it("advances the offset by a full page", () => {
    const next = computeNextCursor({
      current: { kind: "offset", offset: 0 },
      nativeToken: null,
      pageSize: 50,
      limit: 50,
    });
    expect(decodeCursor(next ?? undefined)).toEqual({
      kind: "offset",
      offset: 50,
    });
  });

  it("returns null on a short page (end of stream)", () => {
    expect(
      computeNextCursor({
        current: { kind: "offset", offset: 50 },
        nativeToken: null,
        pageSize: 20,
        limit: 50,
      }),
    ).toBeNull();
  });

  it("encodes a native keyset token when present", () => {
    const next = computeNextCursor({
      current: START_CURSOR,
      nativeToken: "server-token",
      pageSize: 50,
      limit: 50,
    });
    expect(decodeCursor(next ?? undefined)).toEqual({
      kind: "keyset",
      token: "server-token",
    });
  });

  it("treats sentinel tokens as end of stream", () => {
    for (const sentinel of ["", "LTE=", "end"]) {
      expect(
        computeNextCursor({
          current: START_CURSOR,
          nativeToken: sentinel,
          pageSize: 50,
          limit: 50,
        }),
      ).toBeNull();
    }
  });
});
