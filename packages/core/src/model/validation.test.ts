import { describe, it, expect } from "vitest";
import {
  PROBABILITY_MIN,
  PROBABILITY_MAX,
  BINARY_SUM_TOLERANCE,
  isValidProbability,
  clampProbability,
  normalizeProbability,
  binaryProbabilitiesSumToOne,
  normalizeBinaryProbabilities,
  isValidSpread,
  normalizeSpread,
  normalizeResolutionCriteria,
} from "./validation.js";

/**
 * Unit tests for the normalization/validation helpers enforcing the design's
 * "Validation Rules" (Requirements 1.3, 10.3).
 */

describe("isValidProbability", () => {
  it("accepts the inclusive bounds", () => {
    expect(isValidProbability(PROBABILITY_MIN)).toBe(true);
    expect(isValidProbability(PROBABILITY_MAX)).toBe(true);
    expect(isValidProbability(0.5)).toBe(true);
  });

  it("rejects out-of-range values", () => {
    expect(isValidProbability(-0.0001)).toBe(false);
    expect(isValidProbability(1.0001)).toBe(false);
  });

  it("rejects non-finite values", () => {
    expect(isValidProbability(Number.NaN)).toBe(false);
    expect(isValidProbability(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidProbability(Number.NEGATIVE_INFINITY)).toBe(false);
  });
});

describe("clampProbability", () => {
  it("clamps below the lower bound to 0", () => {
    expect(clampProbability(-5)).toBe(0);
    expect(clampProbability(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("clamps above the upper bound to 1", () => {
    expect(clampProbability(5)).toBe(1);
    expect(clampProbability(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("leaves in-range values unchanged", () => {
    expect(clampProbability(0.42)).toBe(0.42);
  });

  it("passes NaN through (cannot be clamped meaningfully)", () => {
    expect(Number.isNaN(clampProbability(Number.NaN))).toBe(true);
  });
});

describe("normalizeProbability", () => {
  it("maps missing data to null", () => {
    expect(normalizeProbability(null)).toBeNull();
    expect(normalizeProbability(undefined)).toBeNull();
    expect(normalizeProbability(Number.NaN)).toBeNull();
  });

  it("clamps finite numbers into [0, 1]", () => {
    expect(normalizeProbability(-0.3)).toBe(0);
    expect(normalizeProbability(1.7)).toBe(1);
    expect(normalizeProbability(0.25)).toBe(0.25);
  });
});

describe("binaryProbabilitiesSumToOne", () => {
  it("accepts an exact sum of 1", () => {
    expect(binaryProbabilitiesSumToOne([0.6, 0.4])).toBe(true);
  });

  it("accepts deviations within the default tolerance", () => {
    expect(binaryProbabilitiesSumToOne([0.6, 0.405])).toBe(true);
  });

  it("rejects deviations beyond tolerance", () => {
    expect(binaryProbabilitiesSumToOne([0.6, 0.5])).toBe(false);
  });

  it("honors a custom tolerance", () => {
    // Sum 1.05, deviation 0.05, comfortably inside the custom 0.1 tolerance.
    expect(binaryProbabilitiesSumToOne([0.6, 0.45], 0.1)).toBe(true);
  });
});

describe("normalizeBinaryProbabilities", () => {
  it("leaves within-tolerance sets unchanged", () => {
    const result = normalizeBinaryProbabilities([0.6, 0.4]);
    expect(result.adjusted).toBe(false);
    expect(result.withinTolerance).toBe(true);
    expect(result.normalized).toEqual([0.6, 0.4]);
    expect(result.deviation).toBeCloseTo(0, 10);
  });

  it("rescales out-of-tolerance sets to sum to 1", () => {
    const result = normalizeBinaryProbabilities([0.6, 0.6]);
    expect(result.adjusted).toBe(true);
    expect(result.withinTolerance).toBe(false);
    const sum = result.normalized.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    // Equal inputs rescale to equal halves.
    expect(result.normalized[0]).toBeCloseTo(0.5, 10);
    expect(result.normalized[1]).toBeCloseTo(0.5, 10);
  });

  it("clamps out-of-range inputs before summing", () => {
    const result = normalizeBinaryProbabilities([1.5, -0.2]);
    // 1.5 -> 1, -0.2 -> 0, sum 1 within tolerance, no rescale.
    expect(result.normalized).toEqual([1, 0]);
    expect(result.adjusted).toBe(false);
    result.normalized.forEach((p) => {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    });
  });

  it("treats non-finite inputs as 0", () => {
    const result = normalizeBinaryProbabilities([Number.NaN, 1]);
    expect(result.normalized).toEqual([0, 1]);
    expect(result.adjusted).toBe(false);
  });

  it("returns a degenerate all-zero set unchanged (cannot rescale)", () => {
    const result = normalizeBinaryProbabilities([0, 0]);
    expect(result.normalized).toEqual([0, 0]);
    expect(result.adjusted).toBe(false);
    expect(result.originalSum).toBe(0);
  });

  it("reports the deviation for logging at the boundary", () => {
    const result = normalizeBinaryProbabilities([0.7, 0.7]);
    expect(result.deviation).toBeCloseTo(0.4, 10);
  });
});

describe("isValidSpread", () => {
  it("treats null (missing data) as valid", () => {
    expect(isValidSpread(null)).toBe(true);
  });

  it("accepts non-negative finite spreads", () => {
    expect(isValidSpread(0)).toBe(true);
    expect(isValidSpread(0.05)).toBe(true);
  });

  it("rejects negative spreads", () => {
    expect(isValidSpread(-0.01)).toBe(false);
  });

  it("rejects non-finite spreads", () => {
    expect(isValidSpread(Number.NaN)).toBe(false);
    expect(isValidSpread(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe("normalizeSpread", () => {
  it("maps missing/invalid data to null", () => {
    expect(normalizeSpread(null)).toBeNull();
    expect(normalizeSpread(undefined)).toBeNull();
    expect(normalizeSpread(Number.NaN)).toBeNull();
    expect(normalizeSpread(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("floors negative spreads to 0", () => {
    expect(normalizeSpread(-3)).toBe(0);
  });

  it("leaves non-negative spreads unchanged", () => {
    expect(normalizeSpread(0)).toBe(0);
    expect(normalizeSpread(0.12)).toBe(0.12);
  });
});

describe("normalizeResolutionCriteria", () => {
  it("preserves raw even when structured fields are null", () => {
    const raw = { foo: "bar", nested: { x: 1 } };
    const result = normalizeResolutionCriteria({ raw });
    expect(result.dataSource).toBeNull();
    expect(result.cutoffTime).toBeNull();
    expect(result.rounding).toBeNull();
    expect(result.raw).toEqual(raw);
  });

  it("defaults raw to an empty object so the field is never lost", () => {
    const result = normalizeResolutionCriteria({ dataSource: "CoinGecko" });
    expect(result.raw).toEqual({});
    expect(result.dataSource).toBe("CoinGecko");
  });

  it("passes through provided structured fields", () => {
    const result = normalizeResolutionCriteria({
      dataSource: "AP race call",
      cutoffTime: "2025-11-05T00:00:00Z",
      rounding: "nearest cent",
      raw: { source: "AP" },
    });
    expect(result).toEqual({
      dataSource: "AP race call",
      cutoffTime: "2025-11-05T00:00:00Z",
      rounding: "nearest cent",
      raw: { source: "AP" },
    });
  });

  it("uses default binary sum tolerance constant", () => {
    expect(BINARY_SUM_TOLERANCE).toBeGreaterThan(0);
  });
});
