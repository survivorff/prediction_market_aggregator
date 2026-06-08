/**
 * @pma/matching — Same-question matching engine.
 *
 * Layered easy->hard: Layer 1 rules/metadata pre-filter, Layer 2 semantic
 * similarity, Layer 3 human calibration queue, Layer 4 resolution-criteria
 * alignment (mandatory before any spread/arbitrage signal). Also computes
 * display-only spread signals.
 *
 * Implemented in task 6.
 */

export const MATCHING_PACKAGE = "@pma/matching" as const;

// Layer 1 — rules/metadata pre-filter (task 6.1): subject-entity / threshold
// extraction, time-window construction, and candidate-pool search.
export {
  DEFAULT_WINDOW_DAYS,
  OPEN_WINDOW_FROM,
  OPEN_WINDOW_TO,
  extractSubjectEntity,
  extractThreshold,
  resolveTimeAnchor,
  buildTimeWindow,
  buildCandidateQuery,
  findCandidatePool,
} from "./layer1-prefilter.js";
export type { MatchCandidate, Layer1Options } from "./layer1-prefilter.js";

// Layer 2 — semantic similarity (task 6.2): provider-agnostic embedding port,
// cosine-similarity scoring, and threshold-gated candidate ranking. The
// AUTO_CONFIRM gate (auto-link vs. calibration queue) is applied by Layer 3.
export {
  SIM_THRESHOLD,
  AUTO_CONFIRM_THRESHOLD,
  cosineSimilarity,
  embedTexts,
  scoreCandidates,
  selectBest,
  meetsAutoConfirm,
} from "./layer2-similarity.js";
export type { EmbeddingProvider, ScoredMarket, Layer2Options } from "./layer2-similarity.js";

// Layer 3 — human calibration queue + labeled data (task 6.3): the calibration
// gate (auto-confirm vs. enqueue-for-review), the high-value escalation policy,
// recording a human decision as labeled training data (the feedback loop), and
// in-memory reference adapters for the CalibrationQueue + MatchLabelStore ports.
// Production wires a durable queue and the Postgres `match_label` table behind
// these ports.
export {
  DEFAULT_HIGH_VALUE_VOLUME,
  DEFAULT_HIGH_VALUE_LIQUIDITY,
  canonicalPairKey,
  isHighValue,
  calibrationGate,
  recordCalibrationDecision,
  InMemoryCalibrationQueue,
  InMemoryMatchLabelStore,
} from "./layer3-calibration.js";
export type {
  MatchDecisionLabel,
  LabeledBy,
  MatchLabel,
  CalibrationReason,
  CalibrationItem,
  CanonicalPair,
  CalibrationQueue,
  MatchLabelStore,
  HighValuePredicate,
  HighValueOptions,
  CalibrationDecision,
  CalibrationGateDeps,
  CalibrationGateOptions,
  HumanCalibrationDecision,
  CalibrationRecordDeps,
} from "./layer3-calibration.js";

// Layer 4 — resolution-criteria alignment + canonical linking (task 6.4): the
// `criteriaAligned` guard (compares dataSource, cutoffTime within tolerance,
// and rounding; any material divergence → not aligned), a field-by-field
// breakdown for the comparison-view mismatch explanation, and the
// `linkAfterAlignment` link step that runs after Layer 3 auto-confirm — it sets
// `resolutionMismatch = true` on divergence so the pair is linked but excluded
// from spread signals (the guard against false arbitrage; consumed by task 6.5
// computeSignals).
export {
  DEFAULT_CUTOFF_TOLERANCE_MS,
  criteriaAligned,
  explainCriteriaAlignment,
  linkAfterAlignment,
} from "./layer4-alignment.js";
export type {
  CriteriaAlignmentOptions,
  ResolutionCriteriaField,
  CriteriaAlignment,
  AlignmentLinkResult,
} from "./layer4-alignment.js";

// Spread / signal computation (task 6.5): the display-only cross-platform
// price-gap signals. `computeSignals` runs over a canonical event's open,
// resolution-aligned markets (mismatch + closed/resolved excluded; markets
// with no usable Yes implied probability dropped), returns at most one
// `SpreadSignal` carrying the per-platform Yes probabilities, the max-min gap,
// and the literal `executable: false` (no execution path — Requirements 3.2,
// 3.3, 3.4). `rankSignals` / `computeSignalsForMany` order a signal list by
// largest gap first (Requirement 3.1). The Yes-implied-probability and
// source-label resolvers are injected so the computation stays pure/testable.
export { computeSignals, rankSignals, computeSignalsForMany } from "./signals.js";
export type {
  SpreadSignal,
  SpreadSignalLeg,
  YesImpliedProbResolver,
  ComputeSignalsDeps,
  ComputeSignalsOptions,
} from "./signals.js";

// Test-support: a deterministic, dependency-free EmbeddingProvider for tests.
// NOT for production — production wires a real embedding model behind the
// EmbeddingProvider port. Exported so matching tests can share one fake.
export { DEFAULT_EMBEDDING_DIMENSIONS, BagOfWordsEmbeddingProvider } from "./test-support.js";

// Orchestrator (design.md `matchMarket`): composes Layers 1–4 into a single
// call per market (prefilter → similarity → calibration → alignment/link).
export { matchMarket } from "./match-market.js";
export type { MatchMarketDeps, MatchMarketOptions, MatchResult } from "./match-market.js";
