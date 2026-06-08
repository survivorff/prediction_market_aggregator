/**
 * Unit tests for the pure channel naming scheme + envelope helpers (no Redis
 * connection required). Covers the design's `chan:market:{id}` /
 * `chan:canonical:{id}` / `chan:alerts` scheme and round-tripping via
 * {@link parseChannel} (Requirement 9.2).
 */

import { describe, it, expect } from "vitest";
import {
  marketChannel,
  canonicalChannel,
  alertsChannel,
  parseChannel,
  ALERTS_CHANNEL,
  CHANNEL_PREFIX,
} from "./channels.js";
import { hotPriceKey } from "./hot-price-cache.js";

describe("channel naming", () => {
  it("builds market/canonical/alerts channel names per the design scheme", () => {
    expect(marketChannel("m1")).toBe("chan:market:m1");
    expect(canonicalChannel("c1")).toBe("chan:canonical:c1");
    expect(alertsChannel()).toBe("chan:alerts");
    expect(ALERTS_CHANNEL).toBe(`${CHANNEL_PREFIX}:alerts`);
  });

  it("round-trips a market channel through parseChannel", () => {
    const id = "00000000-0000-0000-0000-000000000001";
    expect(parseChannel(marketChannel(id))).toEqual({ kind: "market", id });
  });

  it("round-trips a canonical channel through parseChannel", () => {
    const id = "canon-42";
    expect(parseChannel(canonicalChannel(id))).toEqual({ kind: "canonical", id });
  });

  it("decodes the alerts channel with a null id", () => {
    expect(parseChannel(alertsChannel())).toEqual({ kind: "alerts", id: null });
  });

  it("returns null for unknown or malformed channel names", () => {
    expect(parseChannel("not-a-channel")).toBeNull();
    expect(parseChannel("chan:unknown:1")).toBeNull();
    expect(parseChannel("chan:market:")).toBeNull();
    expect(parseChannel("chan:canonical:")).toBeNull();
  });

  it("preserves ids that themselves contain delimiters", () => {
    // Market ids are opaque; everything after the prefix is the id.
    const id = "a:b:c";
    const parsed = parseChannel(marketChannel(id));
    expect(parsed).toEqual({ kind: "market", id });
  });
});

describe("hot-price key", () => {
  it("builds a per-market hash key", () => {
    expect(hotPriceKey("m1")).toBe("hotprice:m1");
  });
});
