import type { ResolutionCriteria } from "./resolution-criteria.js";

/**
 * Normalization & validation helpers enforcing the design's "Validation
 * Rules" (design.md) for the normalized domain model.
 *
 * These functions are intentionally PURE: the core package has no I/O
 * dependencies (see design.md "Layered Architecture"). The design notes that
 * binary-sum deviations are "normalized and logged"; rather than logging from
 * pure domain code, {@link normalizeBinaryProbabilities} reports the deviation
 * and whether an adjustment was made so the ingestion layer can log it at the
 * boundary.
 *
 * Requirements: 1.3 (probability bounds + binary sum tolerance), 10.3
 * (resolutionCriteria.raw always preserved).
 */

/** Inclusive lower bound for implied probability / binary last price. */
export const PROBABILITY_MIN = 0;
/** Inclusive upper bound for implied probability / binary last price. */
export const PROBABILITY_MAX = 1;

/**
 * Default tolerance for the binary-market sum-to-one rule. A binary market's
 * outcome implied probabilities should sum to ≈ 1; deviations beyond this
 * tolerance are normalized (Requirement 1.3).
 */
export const BINARY_SUM_TOLERANCE = 0.01;

/**
 * Returns true when `value` is a finite number within the inclusive
 * probability range [0, 1]. `NaN` and infinities are rejected.
 */
export function isValidProbability(value: number): boolean {
  return Number.isFinite(value) && value >= PROBABILITY_MIN && value <= PROBABILITY_MAX;
}

/**
 * Clamp a finite number into the probability range [0, 1].
 *
 * `+Infinity` clamps to {@link PROBABILITY_MAX}, `-Infinity` to
 * {@link PROBABILITY_MIN}. `NaN` cannot be clamped meaningfully and is
 * returned unchanged; callers that accept missing data should use
 * {@link normalizeProbability} instead.
 */
export function clampProbability(value: number): number {
  if (Number.isNaN(value)) return value;
  if (value < PROBABILITY_MIN) return PROBABILITY_MIN;
  if (value > PROBABILITY_MAX) return PROBABILITY_MAX;
  return value;
}

/**
 * Normalize a nullable probability field (e.g. `Outcome.impliedProb`,
 * `Outcome.lastPrice`) to a value guaranteed within [0, 1], or `null`.
 *
 * - `null`/`undefined` (missing upstream data) → `null` (Requirement 1.5).
 * - `NaN` (unparseable) → `null`.
 * - finite numbers → clamped into [0, 1].
 */
export function normalizeProbability(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (Number.isNaN(value)) return null;
  return clampProbability(value);
}

/**
 * Returns true when the supplied probabilities sum to within `tolerance` of 1.
 * Used to validate binary-market outcome probabilities (Requirement 1.3).
 */
export function binaryProbabilitiesSumToOne(
  probabilities: readonly number[],
  tolerance: number = BINARY_SUM_TOLERANCE,
): boolean {
  const sum = probabilities.reduce((acc, p) => acc + p, 0);
  return Math.abs(sum - 1) <= tolerance;
}

/** Result of {@link normalizeBinaryProbabilities}. */
export interface BinaryNormalizationResult {
  /** Probabilities guaranteed within [0, 1]; scaled to sum to 1 when adjusted. */
  normalized: number[];
  /** True when values were rescaled because the original sum was out of tolerance. */
  adjusted: boolean;
  /** True when the original (clamped) sum was already within tolerance of 1. */
  withinTolerance: boolean;
  /** Sum of the clamped input probabilities before any rescaling. */
  originalSum: number;
  /** Absolute deviation of `originalSum` from 1 (useful for logging). */
  deviation: number;
}

/**
 * Normalize a binary market's outcome implied probabilities.
 *
 * Each input is first clamped into [0, 1] (non-finite inputs are treated as 0).
 * If the clamped values already sum to within `tolerance` of 1, they are
 * returned unchanged (`adjusted = false`). Otherwise they are rescaled to sum
 * to exactly 1 (`adjusted = true`) and the caller is given the `deviation` so
 * it can log the correction (Requirement 1.3).
 *
 * A degenerate all-zero set cannot be rescaled and is returned as-is.
 */
export function normalizeBinaryProbabilities(
  probabilities: readonly number[],
  tolerance: number = BINARY_SUM_TOLERANCE,
): BinaryNormalizationResult {
  const clamped = probabilities.map((p) =>
    Number.isFinite(p) ? clampProbability(p) : PROBABILITY_MIN,
  );
  const originalSum = clamped.reduce((acc, p) => acc + p, 0);
  const deviation = Math.abs(originalSum - 1);
  const withinTolerance = deviation <= tolerance;

  if (withinTolerance || originalSum <= 0) {
    return {
      normalized: clamped,
      adjusted: false,
      withinTolerance,
      originalSum,
      deviation,
    };
  }

  const normalized = clamped.map((p) => clampProbability(p / originalSum));
  return {
    normalized,
    adjusted: true,
    withinTolerance,
    originalSum,
    deviation,
  };
}

/**
 * Returns true when `spread` satisfies the non-negative rule (Requirement
 * 1.3 / design "Validation Rules"). `null` (missing data) is considered valid;
 * non-finite values are not.
 */
export function isValidSpread(spread: number | null): boolean {
  return spread === null || (Number.isFinite(spread) && spread >= 0);
}

/**
 * Normalize a nullable spread to a non-negative value or `null`.
 *
 * - `null`/`undefined` → `null` (missing upstream data, Requirement 1.5).
 * - non-finite (`NaN`/Infinity) → `null`.
 * - negative finite values → 0 (spread must be `>= 0`).
 * - non-negative finite values → unchanged.
 */
export function normalizeSpread(spread: number | null | undefined): number | null {
  if (spread === null || spread === undefined) return null;
  if (!Number.isFinite(spread)) return null;
  return spread < 0 ? 0 : spread;
}

/** Loose shape accepted by {@link normalizeResolutionCriteria}. */
export interface ResolutionCriteriaInput {
  dataSource?: string | null;
  cutoffTime?: string | null;
  rounding?: string | null;
  raw?: Record<string, unknown> | null;
}

/**
 * Build a {@link ResolutionCriteria} that always preserves `raw` for
 * auditability, even when the structured fields cannot be parsed (Requirement
 * 10.3). Missing structured fields default to `null`; a missing `raw` defaults
 * to an empty object so the field is never lost.
 */
export function normalizeResolutionCriteria(input: ResolutionCriteriaInput): ResolutionCriteria {
  return {
    dataSource: input.dataSource ?? null,
    cutoffTime: input.cutoffTime ?? null,
    rounding: input.rounding ?? null,
    raw: input.raw ?? {},
  };
}
