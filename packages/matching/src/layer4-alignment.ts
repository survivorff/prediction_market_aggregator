/**
 * Layer 4 — resolution-criteria alignment + canonical linking for the
 * same-question matching engine (design.md `matchMarket` → "Layer 4 —
 * resolution-criteria alignment (mandatory before signals)"; the
 * "Same-Question Matching Flow" diagram; task 6.4).
 *
 * After Layer 3 ({@link calibrationGate}) auto-confirms (or a human confirms) a
 * pair, Layer 4 is the **mandatory final gate before any spread/arbitrage
 * signal**. It compares the two markets' {@link ResolutionCriteria} and links
 * them to a shared {@link CanonicalEvent}, tagging the link with a
 * `resolutionMismatch` flag (design.md `matchMarket` Layer 4):
 *
 * ```pascal
 * IF criteriaAligned(candidate.resolutionCriteria, best.market.resolutionCriteria) THEN
 *   canonical ← repo.linkToCanonical(candidate, best.market, mismatch=false)
 *   RETURN Matched(canonical, eligibleForSignals=true)
 * ELSE
 *   canonical ← repo.linkToCanonical(candidate, best.market, mismatch=true)
 *   RETURN Matched(canonical, eligibleForSignals=false)   // flagged, no false arb
 * END IF
 * ```
 *
 * **Why this exists.** Two markets can be the *same question* yet settle by
 * materially different rules — a different data source ("CoinGecko close" vs.
 * "Binance close"), a different cutoff time, or a different rounding rule. Such
 * a pair is still worth *linking* (so the comparison view can show both side by
 * side) but must NOT produce an arbitrage signal: the price gap is explained by
 * the differing settlement, not a real mispricing. So a mismatch links the pair
 * with `resolutionMismatch = true`, which:
 *   - surfaces an explicit mismatch flag in the comparison view (Requirement
 *     2.3), and
 *   - **excludes** the pair from spread-signal computation (Requirements 3.2,
 *     11.3) — `computeSignals` (task 6.5) consumes the flag via
 *     {@link MatchingRepository.marketsForCanonical}'s `LinkedMarket`.
 *
 * This is the guard against **false arbitrage signals**.
 *
 * ## Null-handling policy (documented, conservative by default)
 *
 * Not every platform exposes structured resolution criteria, so each field can
 * be `null` (or blank). The default policy is tuned to *avoid false arbitrage*:
 * when alignment cannot be positively confirmed, the pair is flagged as a
 * mismatch (excluded from signals) rather than risking a misleading signal —
 * excluding a borderline pair is cheap, a false signal is not. Per field
 * (`dataSource`, `cutoffTime`, `rounding`), comparing two values `a` and `b`
 * (treating `null`/whitespace-only as "unknown"):
 *
 *   - **both unknown**            → aligned. Neither platform declares the
 *     field; this is a symmetric unknown, not a divergence, so it does not by
 *     itself flag a mismatch. (Layers 1-3 already established these are the same
 *     question; the raw criteria remain preserved for audit per Req 10.3.)
 *   - **equal (normalized)**      → aligned. Compared case-, whitespace-, and
 *     surrounding-space-insensitively (`normalizeText`).
 *   - **both known but different**→ NOT aligned → mismatch. The clear material
 *     divergence the design calls out.
 *   - **exactly one unknown (asymmetric)** → governed by
 *     {@link CriteriaAlignmentOptions.asymmetricNullAligned}, default `false`
 *     (conservative: one side names a data source / cutoff / rounding and the
 *     other is silent, so we *cannot confirm* they match → treat as not aligned
 *     → mismatch). Set it to `true` to treat an unknown side as "no evidence of
 *     divergence" and align instead (a looser, signal-friendlier policy).
 *
 * `cutoffTime` additionally compares **within a tolerance** rather than for
 * exact equality (settlement cutoffs that differ by minutes are not a material
 * divergence). See {@link CriteriaAlignmentOptions.cutoffToleranceMs} and
 * {@link DEFAULT_CUTOFF_TOLERANCE_MS}. Both present and parseable → aligned iff
 * `|a - b| <= tolerance`. If a present value is unparseable as ISO 8601, the
 * comparison falls back to normalized string equality (so identical raw strings
 * still align; a parseable-vs-unparseable or differing pair → mismatch).
 *
 * Everything here is **pure and deterministic** (no I/O, no clock, no
 * randomness) except {@link linkAfterAlignment}, the single seam that calls the
 * repository to persist the link.
 *
 * Requirements: 11.3 (on a matched pair, set `resolutionMismatch = true` when
 * data source, cutoff time, or rounding materially differ), 2.3 (a linked
 * market with a resolution-criteria mismatch is displayed with an explicit
 * mismatch flag and excluded from spread computation).
 */

import type { CanonicalEvent, Market, MatchingRepository, ResolutionCriteria } from "@pma/core";

// ---------------------------------------------------------------------------
// Options + defaults
// ---------------------------------------------------------------------------

/**
 * Default cutoff-time tolerance: settlement cutoffs within **one hour** are
 * treated as aligned. Small by design — a difference of minutes is rounding
 * noise between platforms, but a difference of hours/days is a material
 * divergence that can move which side resolves and therefore must flag a
 * mismatch. Override per call via {@link CriteriaAlignmentOptions.cutoffToleranceMs}.
 */
export const DEFAULT_CUTOFF_TOLERANCE_MS = 60 * 60 * 1000;

/** Tuning knobs for {@link criteriaAligned} / {@link explainCriteriaAlignment}. */
export interface CriteriaAlignmentOptions {
  /**
   * Maximum absolute difference between two parseable `cutoffTime` instants (in
   * milliseconds) for them to count as aligned. Defaults to
   * {@link DEFAULT_CUTOFF_TOLERANCE_MS} (1 hour). Negative values are treated as
   * their absolute value.
   */
  cutoffToleranceMs?: number;
  /**
   * How to treat an **asymmetric-null** field — exactly one side declares a
   * value and the other is `null`/blank. `false` (default, conservative): the
   * field is NOT aligned (cannot confirm a match → flag a mismatch → keep the
   * pair out of signals). `true`: treat the unknown side as "no evidence of
   * divergence" and align the field. Both-unknown is always aligned regardless;
   * this option only governs the one-known/one-unknown case.
   */
  asymmetricNullAligned?: boolean;
}

// ---------------------------------------------------------------------------
// Per-field alignment result (for diagnostics + the UI mismatch explanation)
// ---------------------------------------------------------------------------

/** The resolution-criteria fields Layer 4 compares. */
export type ResolutionCriteriaField = "dataSource" | "cutoffTime" | "rounding";

/**
 * A field-by-field breakdown of a {@link criteriaAligned} comparison. `aligned`
 * is the overall verdict (`true` only when every field aligns). `divergentFields`
 * lists exactly which fields materially differ — useful both for tests and for
 * the comparison view's "why is this row excluded" explanation (Requirement
 * 2.3).
 */
export interface CriteriaAlignment {
  /** Overall: `true` iff every compared field aligns. */
  aligned: boolean;
  /** Whether the (normalized) data sources align. */
  dataSourceAligned: boolean;
  /** Whether the cutoff times align within tolerance. */
  cutoffTimeAligned: boolean;
  /** Whether the (normalized) rounding rules align. */
  roundingAligned: boolean;
  /** The fields that materially diverge (empty when fully aligned). */
  divergentFields: ResolutionCriteriaField[];
}

// ---------------------------------------------------------------------------
// Normalization + field comparators
// ---------------------------------------------------------------------------

/** Lowercase, trim, and collapse internal whitespace runs to a single space. */
function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** A field is "blank" (unknown) when it is `null` or normalizes to the empty string. */
function isBlank(value: string | null): boolean {
  return value === null || normalizeText(value) === "";
}

/**
 * Align two nullable string fields under the documented null policy:
 * both-blank → aligned; exactly-one-blank → `asymmetricNullAligned`; both
 * present → normalized-equal.
 */
function alignText(a: string | null, b: string | null, asymmetricNullAligned: boolean): boolean {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank && bBlank) return true;
  if (aBlank !== bBlank) return asymmetricNullAligned;
  // Both present (the `as string` casts are safe: non-blank ⇒ non-null).
  return normalizeText(a as string) === normalizeText(b as string);
}

/**
 * Align two nullable `cutoffTime` fields within `toleranceMs`. Null policy
 * matches {@link alignText}; both-present values are compared as ISO 8601
 * instants within tolerance, falling back to normalized string equality when a
 * present value is unparseable.
 */
function alignCutoff(
  a: string | null,
  b: string | null,
  toleranceMs: number,
  asymmetricNullAligned: boolean,
): boolean {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank && bBlank) return true;
  if (aBlank !== bBlank) return asymmetricNullAligned;

  const aStr = a as string;
  const bStr = b as string;
  const aMs = Date.parse(aStr);
  const bMs = Date.parse(bStr);
  if (Number.isFinite(aMs) && Number.isFinite(bMs)) {
    return Math.abs(aMs - bMs) <= Math.abs(toleranceMs);
  }
  // At least one cutoff is present but unparseable: fall back to a normalized
  // string compare so identical raw strings still align, anything else flags.
  return normalizeText(aStr) === normalizeText(bStr);
}

// ---------------------------------------------------------------------------
// criteriaAligned / explainCriteriaAlignment
// ---------------------------------------------------------------------------

/**
 * Compare two markets' resolution criteria field by field and return the full
 * breakdown (design.md "`criteriaAligned` compares `dataSource`, `cutoffTime`
 * (within tolerance), and `rounding`"). `aligned` is `true` only when **every**
 * field aligns; `divergentFields` names the ones that do not.
 *
 * Pure and deterministic. See the module header for the complete null /
 * tolerance / unparseable policy.
 *
 * @param a One market's resolution criteria.
 * @param b The other market's resolution criteria.
 * @param options Tolerance + asymmetric-null policy overrides.
 */
export function explainCriteriaAlignment(
  a: ResolutionCriteria,
  b: ResolutionCriteria,
  options: CriteriaAlignmentOptions = {},
): CriteriaAlignment {
  const cutoffToleranceMs = options.cutoffToleranceMs ?? DEFAULT_CUTOFF_TOLERANCE_MS;
  const asymmetricNullAligned = options.asymmetricNullAligned ?? false;

  const dataSourceAligned = alignText(a.dataSource, b.dataSource, asymmetricNullAligned);
  const cutoffTimeAligned = alignCutoff(
    a.cutoffTime,
    b.cutoffTime,
    cutoffToleranceMs,
    asymmetricNullAligned,
  );
  const roundingAligned = alignText(a.rounding, b.rounding, asymmetricNullAligned);

  const divergentFields: ResolutionCriteriaField[] = [];
  if (!dataSourceAligned) divergentFields.push("dataSource");
  if (!cutoffTimeAligned) divergentFields.push("cutoffTime");
  if (!roundingAligned) divergentFields.push("rounding");

  return {
    aligned: divergentFields.length === 0,
    dataSourceAligned,
    cutoffTimeAligned,
    roundingAligned,
    divergentFields,
  };
}

/**
 * Whether two markets' resolution criteria are materially aligned — the guard
 * that decides whether a matched pair is eligible for spread signals. Returns
 * `true` only when `dataSource`, `cutoffTime` (within tolerance), and `rounding`
 * all align; **any** material divergence returns `false` (→ mismatch flag, →
 * excluded from arbitrage signals).
 *
 * Thin wrapper over {@link explainCriteriaAlignment}; use that when you also
 * need to know *which* field diverged (e.g. to explain the exclusion in the UI,
 * Requirement 2.3).
 *
 * Pure and deterministic.
 *
 * @param a One market's resolution criteria.
 * @param b The other market's resolution criteria.
 * @param options Tolerance + asymmetric-null policy overrides.
 */
export function criteriaAligned(
  a: ResolutionCriteria,
  b: ResolutionCriteria,
  options: CriteriaAlignmentOptions = {},
): boolean {
  return explainCriteriaAlignment(a, b, options).aligned;
}

// ---------------------------------------------------------------------------
// linkAfterAlignment — Layer 4 link step (the only I/O seam)
// ---------------------------------------------------------------------------

/**
 * The result of {@link linkAfterAlignment}: the canonical event the pair was
 * linked into, plus the mismatch / signal-eligibility flags. `eligibleForSignals`
 * is exactly `!mismatch` — a mismatched pair is linked (visible in the
 * comparison view) but excluded from spread signals (Requirements 2.3, 3.2,
 * 11.3).
 */
export interface AlignmentLinkResult {
  /** The shared canonical event the pair now belongs to. */
  canonical: CanonicalEvent;
  /** `true` when the resolution criteria materially diverge. */
  mismatch: boolean;
  /** Whether the pair may contribute to spread signals (`!mismatch`). */
  eligibleForSignals: boolean;
}

/**
 * Layer 4 link step (design.md `matchMarket` Layer 4): run **after** Layer 3
 * confirms a pair. Computes `mismatch = !criteriaAligned(candidate, best)`,
 * links the two markets to a shared canonical event via
 * {@link MatchingRepository.linkToCanonical} with that flag, and returns the
 * canonical event plus the mismatch / `eligibleForSignals` flags.
 *
 * - **aligned** → `linkToCanonical(candidate, best, { mismatch: false })`,
 *   `eligibleForSignals = true` (the pair can produce a spread signal).
 * - **divergent** → `linkToCanonical(candidate, best, { mismatch: true })`,
 *   `eligibleForSignals = false` (linked + flagged, but no false arbitrage).
 *
 * Markets linked with `mismatch = true` are persisted with
 * `resolutionMismatch = true` (the `market.resolution_mismatch` column) and are
 * later filtered out by `computeSignals` (task 6.5) via the `LinkedMarket` flag.
 *
 * @param candidate The new/updated market being matched (design `candidate`).
 * @param best The best confirmed match (design `best.market`).
 * @param repo The matching repository (the canonical-linking seam).
 * @param options Alignment tolerance + asymmetric-null policy overrides.
 * @returns The canonical event and mismatch / eligibility flags.
 */
export async function linkAfterAlignment(
  candidate: Market,
  best: Market,
  repo: MatchingRepository,
  options: CriteriaAlignmentOptions = {},
): Promise<AlignmentLinkResult> {
  const mismatch = !criteriaAligned(candidate.resolutionCriteria, best.resolutionCriteria, options);
  const canonical = await repo.linkToCanonical(candidate, best, { mismatch });
  return { canonical, mismatch, eligibleForSignals: !mismatch };
}
