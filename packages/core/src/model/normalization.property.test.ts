import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  PROBABILITY_MIN,
  PROBABILITY_MAX,
  BINARY_SUM_TOLERANCE,
  normalizeProbability,
  normalizeBinaryProbabilities,
} from "./validation.js";

/**
 * Property-based tests for the normalization invariants (design "Correctness
 * Properties" → Property 3: Probability bounds; task 2.3 references this as the
 * normalization-invariants property P1).
 *
 * These encode the universal rules from the design's "Validation Rules":
 *   - `impliedProb` and binary `lastPrice` MUST be within [0, 1].
 *   - For a binary market, outcome implied probabilities should sum to ≈ 1
 *     within a defined tolerance; deviations are normalized.
 *
 * **Validates: Requirements 1.3**
 */

/** Number of fast-check runs per property — enough to exercise edge cases. */
const NUM_RUNS = 1000;

/**
 * A raw probability-like value as an adapter might emit it: well-formed
 * fractions, but also out-of-range, extreme, and degenerate values. This
 * intentionally spans far outside [0, 1] (negatives, > 1, huge magnitudes) and
 * fractional doubles so the clamping/normalization invariants are stressed.
 */
const rawProbabilityValue = (): fc.Arbitrary<number> =>
  fc.oneof(
    // In-range fractions (the common case).
    fc.double({ min: 0, max: 1, noNaN: true }),
    // Out-of-range but finite (negatives and values > 1).
    fc.double({ min: -10, max: 10, noNaN: true }),
    // Very large / extreme magnitudes.
    fc.double({ min: -1e12, max: 1e12, noNaN: true }),
    // Explicit edge cases including the exact bounds and infinities.
    fc.constantFrom(
      0,
      1,
      -0,
      PROBABILITY_MIN,
      PROBABILITY_MAX,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ),
  );

/** Raw value that may also be missing (null/undefined) like sparse upstream data. */
const nullableRawProbabilityValue = (): fc.Arbitrary<number | null | undefined> =>
  fc.oneof(
    rawProbabilityValue(),
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(Number.NaN),
  );

describe("Property 3 (P1): normalization invariants — probability bounds", () => {
  it("normalizeProbability: every non-null result is within [0, 1]", () => {
    fc.assert(
      fc.property(nullableRawProbabilityValue(), (raw) => {
        const result = normalizeProbability(raw);

        // Missing/unparseable data normalizes to null (Requirement 1.5).
        if (result === null) return true;

        // Every produced probability is a finite number within [0, 1].
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(PROBABILITY_MIN);
        expect(result).toBeLessThanOrEqual(PROBABILITY_MAX);
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("normalizeProbability: maps missing/unparseable inputs to null", () => {
    fc.assert(
      fc.property(fc.constantFrom(null, undefined, Number.NaN), (missing) => {
        expect(normalizeProbability(missing)).toBeNull();
        return true;
      }),
      { numRuns: 50 },
    );
  });

  it("normalizeBinaryProbabilities: each normalized value is within [0, 1]", () => {
    fc.assert(
      fc.property(rawProbabilityValue(), rawProbabilityValue(), (yes, no) => {
        const { normalized } = normalizeBinaryProbabilities([yes, no]);

        expect(normalized).toHaveLength(2);
        for (const p of normalized) {
          expect(Number.isFinite(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(PROBABILITY_MIN);
          expect(p).toBeLessThanOrEqual(PROBABILITY_MAX);
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("normalizeBinaryProbabilities: non-degenerate results sum to within tolerance of 1", () => {
    fc.assert(
      fc.property(rawProbabilityValue(), rawProbabilityValue(), (yes, no) => {
        const result = normalizeBinaryProbabilities([yes, no]);
        const sum = result.normalized.reduce((acc, p) => acc + p, 0);

        if (result.adjusted) {
          // Out-of-tolerance inputs are rescaled to sum to exactly 1.
          expect(sum).toBeCloseTo(1, 9);
          return true;
        }

        // Not adjusted: either already within tolerance, or a degenerate
        // all-zero set that cannot be rescaled (originalSum <= 0).
        if (result.originalSum <= 0) {
          // Degenerate: every value is the clamped floor (0).
          expect(sum).toBeCloseTo(0, 9);
          return true;
        }

        // Within-tolerance, non-degenerate: sum is within ε of 1.
        expect(Math.abs(sum - 1)).toBeLessThanOrEqual(BINARY_SUM_TOLERANCE);
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("normalizeBinaryProbabilities: supports arbitrary n-ary outcome sets within [0, 1]", () => {
    fc.assert(
      fc.property(fc.array(rawProbabilityValue(), { minLength: 1, maxLength: 8 }), (raws) => {
        const result = normalizeBinaryProbabilities(raws);

        expect(result.normalized).toHaveLength(raws.length);
        for (const p of result.normalized) {
          expect(p).toBeGreaterThanOrEqual(PROBABILITY_MIN);
          expect(p).toBeLessThanOrEqual(PROBABILITY_MAX);
        }

        // When rescaled, the normalized set sums to 1.
        if (result.adjusted) {
          const sum = result.normalized.reduce((acc, p) => acc + p, 0);
          expect(sum).toBeCloseTo(1, 9);
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
