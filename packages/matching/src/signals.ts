/**
 * Spread / signal computation — the **display-only** price-gap signals for the
 * same-question matching engine (design.md "Spread / signal computation
 * (display-only)" → `computeSignals`; the `SpreadSignal` response contract;
 * task 6.5).
 *
 * After Layer 4 ({@link linkAfterAlignment}) links cross-platform markets to a
 * shared {@link CanonicalEvent} — flagging `resolutionMismatch` on material
 * settlement divergence — this module turns an aligned group into a single,
 * ranked, **non-executable** spread signal: the cross-platform gap between the
 * highest and lowest Yes-outcome implied probability.
 *
 * Design algorithm (design.md):
 *
 * ```pascal
 * ALGORITHM computeSignals(canonicalEventId)
 * BEGIN
 *   markets ← repo.marketsForCanonical(canonicalEventId)
 *              .filter(m → m.status = "open" AND NOT m.resolutionMismatch)
 *   IF count(markets) < 2 THEN RETURN [] END IF
 *   probs ← [ (m.source, yesOutcome(m).impliedProb) FOR m IN markets ]
 *   gap ← max(probs.value) - min(probs.value)
 *   RETURN [ SpreadSignal(canonicalEventId, probs, gap, executable=false) ]
 * END
 * ```
 *
 * ## The four requirements this enforces
 *
 * - **3.1 — ranked by largest gap.** A single canonical event yields at most one
 *   signal; {@link rankSignals} (and {@link computeSignalsForMany}) order a list
 *   of signals by `gap` descending so the biggest cross-platform gaps surface
 *   first.
 * - **3.2 — aligned + open only.** Only markets with `status === "open"` AND
 *   `resolutionMismatch === false` contribute. Mismatched pairs (flagged by
 *   Layer 4) are excluded so a settlement difference never masquerades as
 *   arbitrage — the guard against **false arbitrage signals**.
 * - **3.3 — display-only.** Every returned signal carries the literal
 *   `executable: false`. There is **no execution / order-placement path** here
 *   or anywhere downstream of it; the flag is the contract the API and UI rely
 *   on (Requirement 12.1). The type is the literal `false`, so a `true` cannot
 *   even be constructed.
 * - **3.4 — omit insufficient groups.** A canonical event with fewer than two
 *   *usable* aligned markets returns `[]` rather than a misleading single-sided
 *   "gap". "Usable" also accounts for markets dropped because their Yes implied
 *   probability is unavailable (see the null policy below).
 *
 * ## How a market's Yes implied probability is resolved (documented choice)
 *
 * The normalized {@link Market} (design.md "Model Definitions") deliberately
 * does **not** carry its outcomes — outcomes (and their `impliedProb`) live in
 * the `outcome` table behind {@link OutcomeRepository}. Rather than couple this
 * pure computation to a concrete repository, `computeSignals` takes an injected
 * **resolver** ({@link ComputeSignalsDeps.getYesImpliedProb}) that maps a market
 * to its Yes-outcome implied probability (`0..1`) or `null` when unavailable.
 * Production wires this to `OutcomeRepository.listByMarket(...)` (pick the "Yes"
 * outcome's `impliedProb`); tests wire a trivial lookup. This keeps the module
 * I/O-free and fully deterministic in tests.
 *
 * Likewise the per-platform **source label** is resolved by
 * {@link ComputeSignalsOptions.resolveSource}, defaulting to the market's
 * `sourceId`. Production may map the internal source id to a stable slug
 * ("polymarket" / "manifold"); the default keeps it dependency-free.
 *
 * ## Null / unusable probability policy (documented)
 *
 * A market whose resolver returns `null`, `undefined`, or a non-finite number
 * (`NaN`, `±Infinity`) is **dropped** before the count check. Rationale: a gap
 * computed against a missing probability would be meaningless, and silently
 * coercing it (e.g. to 0) would manufacture a false gap. Dropping it and then
 * applying the "≥ 2" rule (Requirement 3.4) is the conservative choice —
 * consistent with Layer 4's bias toward never emitting a misleading signal. The
 * caller's resolver is expected to return normalized `0..1` probabilities; this
 * module does not clamp, only filters out unusable values.
 *
 * Everything here is **pure and deterministic** except the injected
 * `repo.marketsForCanonical` / `getYesImpliedProb` seams (the only I/O).
 *
 * Requirements: 3.1 (rank by largest cross-platform gap), 3.2 (open +
 * `resolutionMismatch = false` only), 3.3 (`executable = false`, no execution
 * path), 3.4 (omit canonical events with insufficient aligned markets).
 */

import type { LinkedMarket, MatchingRepository } from "@pma/core";

// ---------------------------------------------------------------------------
// SpreadSignal response contract
// ---------------------------------------------------------------------------

/** One platform's contribution to a {@link SpreadSignal}. */
export interface SpreadSignalLeg {
  /** Per-platform source label (default: the market's `sourceId`). */
  source: string;
  /** That platform's Yes-outcome implied probability, `0..1`. */
  impliedProb: number;
}

/**
 * A **display-only** cross-platform price-gap signal (design.md `SpreadSignal`
 * contract). Computed only over open, resolution-aligned markets of a single
 * canonical event.
 *
 * The `executable` field is the literal type `false`: v1 exposes no execution
 * or order-placement path, and the type makes a `true` unconstructable
 * (Requirements 3.3, 12.1).
 */
export interface SpreadSignal {
  /** The canonical event this signal summarizes. */
  canonicalEventId: string;
  /** Human-readable canonical-event title (resolver-provided; see options). */
  title: string;
  /** Per-platform Yes implied probabilities that produced the gap. */
  perPlatform: SpreadSignalLeg[];
  /** Max minus min of `perPlatform[].impliedProb`; always `>= 0`. */
  gap: number;
  /** v1 is display-only: always `false`, and typed as the literal `false`. */
  executable: false;
}

// ---------------------------------------------------------------------------
// Dependencies + options
// ---------------------------------------------------------------------------

/**
 * Resolves a market's **Yes-outcome implied probability** (`0..1`), or `null`
 * when unavailable (no Yes outcome, or its `impliedProb` is null). Production
 * wires this to {@link OutcomeRepository}; tests wire a trivial map. Returning
 * `null` drops the market from the signal (see the module's null policy).
 */
export type YesImpliedProbResolver = (market: LinkedMarket) => Promise<number | null>;

/** Required collaborators for {@link computeSignals} (the only I/O seams). */
export interface ComputeSignalsDeps {
  /**
   * Loads the markets linked to a canonical event, each carrying its
   * `resolutionMismatch` flag (design.md
   * {@link MatchingRepository.marketsForCanonical}). Only the read method is
   * required, so a partial implementation suffices in tests.
   */
  repo: Pick<MatchingRepository, "marketsForCanonical">;
  /**
   * Resolves each market's Yes-outcome implied probability; see
   * {@link YesImpliedProbResolver}.
   */
  getYesImpliedProb: YesImpliedProbResolver;
}

/** Optional configuration knobs for {@link computeSignals}. */
export interface ComputeSignalsOptions {
  /**
   * Resolves the per-platform **source label** for a market. Defaults to the
   * market's `sourceId`. Override to map internal source ids to stable slugs.
   */
  resolveSource?: (market: LinkedMarket) => string;
  /**
   * Resolves the canonical-event **title** for the signal. Defaults to the
   * `canonicalEventId` itself when not provided (or when it resolves to a blank
   * value), so a signal always has a non-empty title.
   */
  resolveTitle?: (canonicalEventId: string) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** A market contributes to a signal iff it is open and not a resolution mismatch. */
function isAligned(market: LinkedMarket): boolean {
  return market.status === "open" && market.resolutionMismatch === false;
}

/** A resolved probability is usable iff it is a finite number (drops null/NaN/±∞). */
function isUsableProb(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/**
 * Construct a {@link SpreadSignal} — the **single** site that stamps
 * `executable: false`, so the display-only invariant (Requirement 3.3) is
 * enforced in exactly one place.
 */
function makeSignal(
  canonicalEventId: string,
  title: string,
  perPlatform: SpreadSignalLeg[],
  gap: number,
): SpreadSignal {
  return { canonicalEventId, title, perPlatform, gap, executable: false };
}

// ---------------------------------------------------------------------------
// computeSignals
// ---------------------------------------------------------------------------

/**
 * Compute the display-only spread signal for a single canonical event
 * (design.md `computeSignals`).
 *
 * Loads the canonical event's linked markets, keeps only those that are
 * **open** and **not** a resolution mismatch (Requirement 3.2), resolves each
 * one's Yes implied probability (dropping unusable values per the module's null
 * policy), and:
 *
 * - returns `[]` when fewer than two usable aligned markets remain (Requirement
 *   3.4 — no misleading single-sided gap), otherwise
 * - returns a one-element array with the per-platform probabilities, the
 *   `max - min` gap, and `executable: false` (Requirements 3.1 input, 3.3).
 *
 * @param canonicalEventId The canonical event to summarize.
 * @param deps The repository + Yes-implied-probability resolver (I/O seams).
 * @param options Source-label / title resolver overrides.
 * @returns `[]` or a single {@link SpreadSignal}.
 */
export async function computeSignals(
  canonicalEventId: string,
  deps: ComputeSignalsDeps,
  options: ComputeSignalsOptions = {},
): Promise<SpreadSignal[]> {
  const resolveSource = options.resolveSource ?? ((m: LinkedMarket): string => m.sourceId);

  const linked = await deps.repo.marketsForCanonical(canonicalEventId);
  const aligned = linked.filter(isAligned);

  // Resolve Yes implied probability per aligned market (in parallel), then drop
  // any whose probability is unavailable/unusable.
  const legs: SpreadSignalLeg[] = (
    await Promise.all(
      aligned.map(async (market): Promise<SpreadSignalLeg | null> => {
        const impliedProb = await deps.getYesImpliedProb(market);
        if (!isUsableProb(impliedProb)) return null;
        return { source: resolveSource(market), impliedProb };
      }),
    )
  ).filter((leg): leg is SpreadSignalLeg => leg !== null);

  // Requirement 3.4: insufficient aligned markets → omit (no misleading gap).
  if (legs.length < 2) return [];

  const probs = legs.map((leg) => leg.impliedProb);
  const gap = Math.max(...probs) - Math.min(...probs);

  const title = await resolveTitle(canonicalEventId, options.resolveTitle);

  return [makeSignal(canonicalEventId, title, legs, gap)];
}

/** Resolve a non-empty title, falling back to the id when blank/unavailable. */
async function resolveTitle(
  canonicalEventId: string,
  resolver: ComputeSignalsOptions["resolveTitle"],
): Promise<string> {
  if (resolver === undefined) return canonicalEventId;
  const resolved = await resolver(canonicalEventId);
  if (resolved === null || resolved.trim() === "") return canonicalEventId;
  return resolved;
}

// ---------------------------------------------------------------------------
// Ranking (Requirement 3.1)
// ---------------------------------------------------------------------------

/**
 * Rank spread signals by **largest cross-platform gap first** (Requirement
 * 3.1). Pure and non-mutating: returns a new array, leaving the input
 * untouched. Ties preserve input order (stable). Useful for assembling the
 * `GET /api/signals` list from per-event {@link computeSignals} results.
 *
 * @param signals The signals to rank.
 * @returns A new array ordered by `gap` descending.
 */
export function rankSignals(signals: readonly SpreadSignal[]): SpreadSignal[] {
  // Array.prototype.sort is stable in modern engines, so equal gaps keep their
  // relative input order. Copy first so the caller's array is not mutated.
  return [...signals].sort((a, b) => b.gap - a.gap);
}

/**
 * Compute signals for many canonical events and return them **ranked by gap
 * descending** (Requirements 3.1, 3.4). Each event yields at most one signal
 * (events with insufficient aligned markets contribute none); the combined list
 * is then ranked via {@link rankSignals}.
 *
 * @param canonicalEventIds The canonical events to summarize.
 * @param deps The repository + Yes-implied-probability resolver.
 * @param options Source-label / title resolver overrides.
 * @returns All produced signals, ranked by `gap` descending.
 */
export async function computeSignalsForMany(
  canonicalEventIds: readonly string[],
  deps: ComputeSignalsDeps,
  options: ComputeSignalsOptions = {},
): Promise<SpreadSignal[]> {
  const perEvent = await Promise.all(
    canonicalEventIds.map((id) => computeSignals(id, deps, options)),
  );
  return rankSignals(perEvent.flat());
}
