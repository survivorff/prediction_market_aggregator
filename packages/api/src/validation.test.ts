/**
 * Unit tests for input validation/coercion (Requirement 9.3). Valid input is
 * coerced; invalid input throws {@link ValidationError} (→ 400 at the HTTP edge).
 */

import { describe, it, expect } from "vitest";
import { ValidationError } from "./errors.js";
import {
  parseDiscoveryQuery,
  parseHistoryQuery,
  parseMarketId,
  parseCanonicalEventId,
  parseCanonicalEventsQuery,
  parseSignalsQuery,
} from "./validation.js";

describe("parseDiscoveryQuery", () => {
  it("accepts and coerces valid filters/sort/paging", () => {
    const q = parseDiscoveryQuery({
      category: "crypto",
      status: "open",
      q: "  btc  ",
      sort: "liquidity",
      order: "asc",
      limit: "25",
      offset: "10",
    });
    expect(q).toEqual({
      category: "crypto",
      status: "open",
      q: "btc",
      sort: "liquidity",
      order: "asc",
      limit: 25,
      offset: 10,
    });
  });

  it("returns an empty object for no params", () => {
    expect(parseDiscoveryQuery({})).toEqual({});
  });

  it("drops a whitespace-only q", () => {
    expect(parseDiscoveryQuery({ q: "   " }).q).toBeUndefined();
  });

  it.each(["weather", "Crypto", ""])("rejects invalid category %j", (category) => {
    expect(() => parseDiscoveryQuery({ category })).toThrow(ValidationError);
  });

  it("rejects invalid status, sort, order", () => {
    expect(() => parseDiscoveryQuery({ status: "pending" })).toThrow(ValidationError);
    expect(() => parseDiscoveryQuery({ sort: "price" })).toThrow(ValidationError);
    expect(() => parseDiscoveryQuery({ order: "sideways" })).toThrow(ValidationError);
  });

  it("rejects non-integer / out-of-range limit and offset", () => {
    expect(() => parseDiscoveryQuery({ limit: "abc" })).toThrow(ValidationError);
    expect(() => parseDiscoveryQuery({ limit: "0" })).toThrow(ValidationError);
    expect(() => parseDiscoveryQuery({ limit: "201" })).toThrow(ValidationError);
    expect(() => parseDiscoveryQuery({ offset: "-1" })).toThrow(ValidationError);
  });

  it("rejects array-valued params", () => {
    expect(() => parseDiscoveryQuery({ category: ["crypto", "politics"] })).toThrow(
      ValidationError,
    );
  });
});

describe("parseMarketId", () => {
  it("accepts a UUID-shaped id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(parseMarketId({ id })).toBe(id);
  });

  it("rejects a missing or non-UUID id", () => {
    expect(() => parseMarketId({})).toThrow(ValidationError);
    expect(() => parseMarketId({ id: "not-a-uuid" })).toThrow(ValidationError);
  });
});

describe("parseCanonicalEventId", () => {
  it("accepts a UUID-shaped id", () => {
    const id = "aaaaaaaa-1111-1111-1111-111111111111";
    expect(parseCanonicalEventId({ id })).toBe(id);
  });

  it("rejects a missing or non-UUID id", () => {
    expect(() => parseCanonicalEventId({})).toThrow(ValidationError);
    expect(() => parseCanonicalEventId({ id: "nope" })).toThrow(ValidationError);
  });
});

describe("parseCanonicalEventsQuery", () => {
  it("returns an empty object for no params", () => {
    expect(parseCanonicalEventsQuery({})).toEqual({});
  });

  it("accepts a valid category", () => {
    expect(parseCanonicalEventsQuery({ category: "crypto" })).toEqual({ category: "crypto" });
  });

  it("rejects an invalid category", () => {
    expect(() => parseCanonicalEventsQuery({ category: "weather" })).toThrow(ValidationError);
  });
});

describe("parseSignalsQuery", () => {
  it("returns an empty object for no params", () => {
    expect(parseSignalsQuery({})).toEqual({});
  });

  it("coerces a valid limit", () => {
    expect(parseSignalsQuery({ limit: "10" })).toEqual({ limit: 10 });
  });

  it("rejects a non-integer / out-of-range limit", () => {
    expect(() => parseSignalsQuery({ limit: "abc" })).toThrow(ValidationError);
    expect(() => parseSignalsQuery({ limit: "0" })).toThrow(ValidationError);
    expect(() => parseSignalsQuery({ limit: "201" })).toThrow(ValidationError);
  });
});

describe("parseHistoryQuery", () => {
  const NOW = Date.UTC(2025, 0, 10, 0, 0, 0);
  const now = () => NOW;

  it("defaults to the last 24h when from/to omitted", () => {
    const { range } = parseHistoryQuery({}, now);
    expect(range.to).toBe(new Date(NOW).toISOString());
    expect(range.from).toBe(new Date(NOW - 24 * 60 * 60 * 1000).toISOString());
    expect(range.interval).toBeUndefined();
  });

  it("accepts an explicit range and interval", () => {
    const { range } = parseHistoryQuery(
      { from: "2025-01-01T00:00:00.000Z", to: "2025-01-02T00:00:00.000Z", interval: "1h" },
      now,
    );
    expect(range.from).toBe("2025-01-01T00:00:00.000Z");
    expect(range.to).toBe("2025-01-02T00:00:00.000Z");
    expect(range.interval).toBe("1h");
  });

  it("rejects from > to", () => {
    expect(() =>
      parseHistoryQuery({ from: "2025-02-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" }, now),
    ).toThrow(ValidationError);
  });

  it("rejects an invalid timestamp and an invalid interval", () => {
    expect(() => parseHistoryQuery({ from: "not-a-date" }, now)).toThrow(ValidationError);
    expect(() => parseHistoryQuery({ interval: "2h" }, now)).toThrow(ValidationError);
  });
});
