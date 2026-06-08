/**
 * `matchMarket` — the same-question matching orchestrator (design.md
 * `matchMarket`). Composes the four layers into a single call per market:
 *
 *   Layer 1  findCandidatePool   — category/time/subject/threshold pre-filter
 *   Layer 2  scoreCandidates     — embedding cosine similarity, argmax = best
 *   Layer 3  calibrationGate     — auto-confirm vs. human calibration queue
 *   Layer 4  linkAfterAlignment  — resolution-criteria alignment + canonical link
 *
 * The individual layers are pure/tested in isolation; this module wires them in
 * the design's order and returns a single {@link MatchResult}. All I/O is behind
 * the injected {@link MatchMarketDeps} (the matching repository, embedding
 * provider, calibration queue, optional label store), so the orchestration is
 * unit-testable with in-memory fakes.
 *
 * Requirements: 11.1 (evaluate each ingested/updated market through the layered
 * matcher), 11.2 (never auto-link an ambiguous/high-value pair — route to the
 * calibration queue), 11.3 / 2.3 (flag resolution mismatches; link but exclude
 * from signals), 2.2 (symmetric linkage).
 */

import type { CanonicalEvent, MatchingRepository } from "@pma/core";
import {
  findCandidatePool,
  type Layer1Options,
  type MatchCandidate,
} from "./layer1-prefilter.js";
import {
  scoreCandidates,
  selectBest,
  type EmbeddingProvider,
  type Layer2Options,
  type ScoredMarket,
} from "./layer2-similarity.js";
import {
  calibrationGate,
  type CalibrationGateOptions,
  type CalibrationItem,
  type CalibrationQueue,
  type MatchLabelStore,
} from "./layer3-calibration.js";
import { linkAfterAlignment, type CriteriaAlignmentOptions } from "./layer4-alignment.js";

/** Injected collaborators for {@link matchMarket} (the only I/O seams). */
export interface MatchMarketDeps {
  /** Candidate search + canonical linking (storage-backed in production). */
  repo: MatchingRepository;
  /** Provider-agnostic embedding port for Layer 2. */
  embeddings: EmbeddingProvider;
  /** Human calibration queue for ambiguous/high-value pairs (Layer 3). */
  queue: CalibrationQueue;
  /** Optional labeled-data store (the calibration feedback loop). */
  labels?: MatchLabelStore;
}

/** Per-layer tuning for {@link matchMarket}; every field is optional. */
export interface MatchMarketOptions {
  /** Layer 1 pre-filter tuning (time-window half-width). */
  layer1?: Layer1Options;
  /** Layer 2 similarity tuning (similarity threshold). */
  layer2?: Layer2Options;
  /** Layer 3 calibration tuning (auto-confirm threshold, high-value policy). */
  calibration?: CalibrationGateOptions;
  /** Layer 4 alignment tuning (cutoff tolerance, asymmetric-null policy). */
  alignment?: CriteriaAlignmentOptions;
  /**
   * Only consider candidates from a DIFFERENT source than the candidate market
   * (default `true`). Same-question matching for a cross-platform aggregator
   * links markets ACROSS venues — a single platform does not list the same
   * question twice, so same-source "matches" are spurious (e.g. two different
   * threshold buckets of one subject). Set `false` to allow intra-source links.
   */
  crossSourceOnly?: boolean;
}

/** Outcome of {@link matchMarket}. */
export type MatchResult =
  /** No candidate pool, no Layer-2 match, or nothing to confirm. */
  | { kind: "NoMatch" }
  /** Best match was ambiguous/high-value → routed to the calibration queue. */
  | { kind: "PendingCalibration"; item: CalibrationItem }
  /** Auto-confirmed and linked to a canonical event (possibly flagged mismatch). */
  | {
      kind: "Matched";
      canonical: CanonicalEvent;
      best: ScoredMarket;
      /** `true` when resolution criteria materially diverge (excluded from signals). */
      mismatch: boolean;
      /** Whether the linked pair may contribute to spread signals (`!mismatch`). */
      eligibleForSignals: boolean;
    };

/**
 * Match one candidate market against the catalog and, on an auto-confirmed
 * match, link it cross-platform. See the module header for the layer flow.
 *
 * @param candidate The new/updated market (+ its category/endDate context).
 * @param deps Injected repository, embedding provider, queue, optional labels.
 * @param options Per-layer tuning.
 */
export async function matchMarket(
  candidate: MatchCandidate,
  deps: MatchMarketDeps,
  options: MatchMarketOptions = {},
): Promise<MatchResult> {
  // Layer 1 — narrow to a small candidate pool.
  const rawPool = await findCandidatePool(candidate, deps.repo, options.layer1);
  // Cross-platform aggregator: only link ACROSS venues (default). Drop any
  // same-source candidates so spurious intra-platform pairs never match.
  const pool =
    options.crossSourceOnly === false
      ? rawPool
      : rawPool.filter((m) => m.sourceId !== candidate.market.sourceId);
  if (pool.length === 0) return { kind: "NoMatch" };

  // Layer 2 — embedding similarity; best = argmax.
  const scored = await scoreCandidates(
    candidate.market.question,
    pool,
    deps.embeddings,
    options.layer2,
  );
  const best = selectBest(scored);

  // Layer 3 — auto-confirm vs. enqueue for human calibration.
  const decision = await calibrationGate(
    candidate.market,
    best,
    { queue: deps.queue, labels: deps.labels },
    options.calibration,
  );
  if (decision.kind === "NoMatch") return { kind: "NoMatch" };
  if (decision.kind === "PendingCalibration") {
    return { kind: "PendingCalibration", item: decision.item };
  }

  // Layer 4 — resolution-criteria alignment + canonical link (mandatory gate).
  const link = await linkAfterAlignment(
    candidate.market,
    decision.best.market,
    deps.repo,
    options.alignment,
  );
  return {
    kind: "Matched",
    canonical: link.canonical,
    best: decision.best,
    mismatch: link.mismatch,
    eligibleForSignals: link.eligibleForSignals,
  };
}
