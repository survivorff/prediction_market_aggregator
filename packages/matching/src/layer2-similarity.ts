/**
 * Layer 2 — semantic similarity for the same-question matching engine
 * (design.md `matchMarket` → "Layer 2 — semantic similarity on question text";
 * the "Same-Question Matching Flow" diagram; task 6.2).
 *
 * Layer 1 ({@link findCandidatePool}) cheaply narrows the universe to a small
 * candidate pool. Layer 2 then embeds the candidate's question and each pool
 * market's question, scores them by cosine similarity, keeps the pairs at or
 * above a configurable `SIM_THRESHOLD`, and returns them sorted best-first so
 * `best = scored[0]` (design `best ← argmax(scored by sim)`):
 *
 * ```pascal
 * qVec ← embed(candidate.question)
 * FOR each other IN pool DO
 *   sim ← cosine(qVec, embed(other.question))
 *   IF sim ≥ SIM_THRESHOLD THEN scored.add((other, sim))
 * END FOR
 * best ← argmax(scored by sim)
 * ```
 *
 * **Provider-agnostic by design.** This module never depends on a specific
 * embedding model. Production wires an actual embedding service (OpenAI, a
 * local sentence-transformer, etc.) behind the {@link EmbeddingProvider} port;
 * tests wire a deterministic in-memory provider (see the package's test-support
 * export) so similarity scoring is reproducible without a real model. The
 * matching engine only ever talks to the port.
 *
 * **Seam with Layer 3 (task 6.3).** Layer 2 owns *similarity scoring and the
 * `SIM_THRESHOLD` cut only*. The separate `AUTO_CONFIRM_THRESHOLD` gate — "is
 * the best match confident enough to auto-link, or must it go to the human
 * calibration queue?" — is Layer 3's responsibility. To keep that boundary
 * clean, {@link scoreCandidates} returns the full sorted/filtered list and lets
 * Layer 3 apply the gate. {@link selectBest} and {@link meetsAutoConfirm} are
 * thin, side-effect-free helpers exposed here for convenience; the auto-confirm
 * *decision* (enqueue vs. link) lives in Layer 3.
 *
 * Requirements: 11.1 (rules/metadata pre-filter followed by semantic similarity
 * on question text).
 */

import type { Market } from "@pma/core";

/**
 * Provider-agnostic embedding port. An implementation maps text to a dense
 * vector in some fixed-dimension space; the matching engine treats it as an
 * opaque source of vectors and compares them with {@link cosineSimilarity}.
 *
 * Implementations MUST be deterministic for a given input within a run (the
 * same text yields the same vector) and MUST return vectors of a consistent
 * dimension, otherwise {@link cosineSimilarity} will reject mismatched pairs.
 *
 * `embedAll` is optional: when present it is used to embed a batch in one call
 * (most hosted embedding APIs are far cheaper batched); otherwise the engine
 * falls back to mapping {@link embed} over the inputs (see {@link embedTexts}).
 */
export interface EmbeddingProvider {
  /** Embed a single text into a dense vector. */
  embed(text: string): Promise<number[]>;
  /** Optional batch embedding; falls back to {@link embed} when absent. */
  embedAll?(texts: string[]): Promise<number[][]>;
}

/** A pool market scored against the candidate question by cosine similarity. */
export interface ScoredMarket {
  /** The pool market being compared to the candidate. */
  market: Market;
  /** Cosine similarity of the two questions, in `[-1, 1]`. */
  similarity: number;
}

/** Tuning knobs for {@link scoreCandidates}. */
export interface Layer2Options {
  /**
   * Minimum cosine similarity (inclusive) for a pool market to be kept.
   * Defaults to {@link SIM_THRESHOLD}.
   */
  simThreshold?: number;
}

/**
 * Default Layer-2 similarity cut (`SIM_THRESHOLD` in design.md). Pool markets
 * whose question similarity is `>=` this are kept as candidate matches; the
 * rest are dropped. This is a *calibration* knob — the calibration feedback
 * loop (Layer 3) tunes it from labeled pairs — so it is overridable per call
 * via {@link Layer2Options.simThreshold}. The default is tuned for normalized
 * semantic-embedding cosine scores; deterministic test embeddings may warrant a
 * different value supplied explicitly.
 */
export const SIM_THRESHOLD = 0.75;

/**
 * Default auto-confirm threshold (`AUTO_CONFIRM_THRESHOLD` in design.md). When
 * the best match's similarity is below this (or the pair is high-value), the
 * pair is routed to the human calibration queue instead of being auto-linked.
 *
 * Exposed here so the constant lives next to similarity scoring, but the gating
 * *decision* is owned by Layer 3 (task 6.3); see the module-level seam note.
 */
export const AUTO_CONFIRM_THRESHOLD = 0.9;

/**
 * Cosine similarity of two equal-length vectors, in `[-1, 1]`.
 *
 * Documented edge-case handling:
 *  - **Mismatched lengths** → throws {@link RangeError}. Comparing vectors from
 *    different embedding spaces is a programming error, not a 0-similarity
 *    result, so we fail loudly rather than silently returning a bogus score.
 *  - **Zero vector** (either operand has zero magnitude) → returns `0`. Cosine
 *    is undefined at the origin (division by zero); `0` ("no similarity") is the
 *    safe, neutral choice and keeps the function total.
 *  - **Float error** → the raw quotient can land just outside `[-1, 1]` (e.g.
 *    `1.0000000002`) from rounding; the result is clamped back into range.
 *
 * Pure and deterministic.
 *
 * @param a First vector.
 * @param b Second vector (must have the same length as `a`).
 * @returns Cosine similarity in `[-1, 1]`, or `0` for a zero-magnitude operand.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new RangeError(`cosineSimilarity: vector length mismatch (${a.length} vs ${b.length})`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  if (normA === 0 || normB === 0) return 0; // zero vector → undefined → 0

  const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // Clamp away floating-point overshoot so the contract `[-1, 1]` always holds.
  if (sim > 1) return 1;
  if (sim < -1) return -1;
  return sim;
}

/**
 * Embed many texts, preferring the provider's batch path when available.
 *
 * Uses {@link EmbeddingProvider.embedAll} in a single call when the provider
 * implements it (cheaper for hosted APIs); otherwise maps {@link
 * EmbeddingProvider.embed} over the inputs concurrently. Order is preserved:
 * `result[i]` is the embedding of `texts[i]`.
 *
 * @param provider The embedding port.
 * @param texts Texts to embed (may be empty → resolves to `[]`).
 * @returns Vectors aligned 1:1 with `texts`.
 */
export function embedTexts(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return Promise.resolve([]);
  if (provider.embedAll !== undefined) return provider.embedAll(texts);
  return Promise.all(texts.map((t) => provider.embed(t)));
}

/**
 * Layer 2 entry point: score a candidate question against a Layer-1 candidate
 * pool by embedding cosine similarity, keep the matches at or above
 * `simThreshold`, and return them sorted by similarity descending so the best
 * match is `scored[0]` (design `best ← argmax(scored by sim)`).
 *
 * The candidate question is embedded **once** and that single vector is reused
 * for every pool comparison; the pool questions are embedded as a batch (via
 * {@link embedTexts}). An empty pool yields an empty result without calling the
 * provider for any pool vectors.
 *
 * This function deliberately stops at the `SIM_THRESHOLD` cut and sorting. It
 * does not apply the `AUTO_CONFIRM_THRESHOLD` auto-link gate — that is Layer 3's
 * job (task 6.3). Callers take `scored[0]` as the best candidate and decide,
 * via Layer 3, whether to auto-link or enqueue for calibration.
 *
 * @param candidateQuestion The new/updated market's question text.
 * @param pool The Layer-1 candidate pool (other markets).
 * @param provider The embedding port (provider-agnostic).
 * @param options Tuning; `simThreshold` defaults to {@link SIM_THRESHOLD}.
 * @returns Scored matches `>= simThreshold`, sorted by similarity descending.
 */
export async function scoreCandidates(
  candidateQuestion: string,
  pool: Market[],
  provider: EmbeddingProvider,
  options: Layer2Options = {},
): Promise<ScoredMarket[]> {
  const simThreshold = options.simThreshold ?? SIM_THRESHOLD;

  if (pool.length === 0) return [];

  // Embed the candidate question ONCE, then reuse the vector for every pool
  // comparison (design `qVec ← embed(candidate.question)` outside the loop).
  const qVec = await provider.embed(candidateQuestion);
  const poolVecs = await embedTexts(
    provider,
    pool.map((m) => m.question),
  );

  const scored: ScoredMarket[] = [];
  for (let i = 0; i < pool.length; i += 1) {
    const market = pool[i];
    const vec = poolVecs[i];
    if (market === undefined || vec === undefined) continue;
    const similarity = cosineSimilarity(qVec, vec);
    if (similarity >= simThreshold) scored.push({ market, similarity });
  }

  // argmax-first: highest similarity leads, so callers read `best = scored[0]`.
  scored.sort((x, y) => y.similarity - x.similarity);
  return scored;
}

/**
 * Pick the best match (argmax by similarity) from a {@link scoreCandidates}
 * result, or `null` when the list is empty. Because `scoreCandidates` already
 * returns the list sorted descending, this is simply `scored[0] ?? null`,
 * exposed as a named helper so call sites read intentionally.
 */
export function selectBest(scored: ScoredMarket[]): ScoredMarket | null {
  return scored[0] ?? null;
}

/**
 * Whether a best match clears the auto-confirm bar — a thin predicate exposed
 * for Layer 3 (task 6.3), which owns the actual auto-link vs. calibration-queue
 * decision. Returns `false` for a `null` best (nothing to confirm).
 *
 * Note this is intentionally *only* the similarity check; Layer 3 also factors
 * in the high-value escalation rule (`isHighValue`) before auto-linking.
 *
 * @param best The argmax match (e.g. from {@link selectBest}).
 * @param autoConfirmThreshold Bar to clear; defaults to {@link AUTO_CONFIRM_THRESHOLD}.
 */
export function meetsAutoConfirm(
  best: ScoredMarket | null,
  autoConfirmThreshold: number = AUTO_CONFIRM_THRESHOLD,
): boolean {
  return best !== null && best.similarity >= autoConfirmThreshold;
}
