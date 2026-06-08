/**
 * Layer 3 — human calibration queue + labeled data for the same-question
 * matching engine (design.md `matchMarket` → "Layer 3 — calibration gate for
 * ambiguous / high-value pairs"; the "Same-Question Matching Flow" diagram;
 * task 6.3).
 *
 * Layer 2 ({@link scoreCandidates}) hands the best similarity match to Layer 3,
 * which decides whether the pair is confident enough to auto-link (continue to
 * Layer 4) or must be routed to a human for review:
 *
 * ```pascal
 * best ← argmax(scored by sim)
 * IF best.sim < AUTO_CONFIRM_THRESHOLD OR isHighValue(candidate, best) THEN
 *   calibrationQueue.enqueue(candidate, best)
 *   RETURN PendingCalibration                 // no auto-link
 * END IF
 * // else: eligible for Layer 4
 * ```
 *
 * The design's **calibration feedback loop** — "confirmed/rejected pairs from
 * Layer 3 are stored as labeled data" — is realized by {@link MatchLabelStore}:
 * a human's same/different verdict is persisted (and later used to tune
 * `SIM_THRESHOLD`, the extraction rules, and a future learned matcher). The
 * store mirrors the `match_label` table (design.md "Storage Schemas":
 * `market_a_id, market_b_id, decision, similarity, labeled_by, created_at`,
 * with `UNIQUE(market_a_id, market_b_id)`).
 *
 * **Provider-agnostic by design.** Like Layer 2's {@link EmbeddingProvider},
 * this module depends only on two ports — {@link CalibrationQueue} and
 * {@link MatchLabelStore} — never on a concrete backend. Production wires a
 * durable queue and the Postgres-backed `match_label` table behind these
 * interfaces (a seam that can live in `@pma/storage`). This file ships
 * {@link InMemoryCalibrationQueue} and {@link InMemoryMatchLabelStore} as the
 * reference adapters: dependency-free, used by tests, and a faithful spec of
 * the contract a real adapter must satisfy.
 *
 * **Pair-key canonicalization.** A label/queue entry is about an *unordered*
 * pair of markets: `(A, B)` and `(B, A)` are the same pair. To match the
 * `match_label UNIQUE(market_a_id, market_b_id)` constraint and keep linkage
 * symmetric (Requirement 2.2), both ports canonicalize a pair to
 * `marketAId = min(id1, id2)`, `marketBId = max(id1, id2)` (lexicographic) via
 * {@link canonicalPairKey} before keying. So enqueuing/labeling `(A, B)` then
 * `(B, A)` touches exactly one entry.
 *
 * Requirements: 11.2 (below-auto-confirm OR high-value pairs route to a human
 * calibration queue rather than auto-linking), 11.4 (a human calibration
 * decision is stored as labeled data for improving future matching).
 */

import type { Market } from "@pma/core";
import { AUTO_CONFIRM_THRESHOLD, type ScoredMarket } from "./layer2-similarity.js";

// ---------------------------------------------------------------------------
// Labeled-data and decision vocabulary (mirrors the match_label table)
// ---------------------------------------------------------------------------

/**
 * A calibration verdict on a market pair — the `decision` column of
 * `match_label` (design.md "Storage Schemas", `CHECK (decision IN
 * ('same','different'))`). `"same"` = the two markets are the same real-world
 * question; `"different"` = they are not.
 */
export type MatchDecisionLabel = "same" | "different";

/**
 * Who produced a label — the `labeled_by` column of `match_label`
 * (`CHECK (labeled_by IN ('human','auto'))`). `"human"` comes from the
 * calibration queue; `"auto"` is an optional self-label recorded when the gate
 * auto-confirms a confident, non-high-value pair.
 */
export type LabeledBy = "human" | "auto";

/**
 * A row of labeled training data — the in-memory shape of a `match_label`
 * record (design.md "Storage Schemas"). `marketAId`/`marketBId` are always in
 * canonical order (`marketAId <= marketBId`); see {@link canonicalPairKey}.
 *
 * `similarity` is the Layer-2 cosine score that triggered the label, or `null`
 * when unknown. The DB column is `NUMERIC CHECK (similarity BETWEEN 0 AND 1)`;
 * callers should pass a value in `[0, 1]` (the in-memory store does not enforce
 * the bound — that is the database's job).
 */
export interface MatchLabel {
  /** Canonical lower market id (`<= marketBId`). */
  marketAId: string;
  /** Canonical upper market id (`>= marketAId`). */
  marketBId: string;
  /** The verdict: same question or not. */
  decision: MatchDecisionLabel;
  /** Layer-2 similarity that produced the label, or `null`. */
  similarity: number | null;
  /** Provenance of the label (human review vs. auto-confirm). */
  labeledBy: LabeledBy;
}

/** Why a pair was escalated to the calibration queue by {@link calibrationGate}. */
export type CalibrationReason = "below-threshold" | "high-value";

/**
 * A pending item in the {@link CalibrationQueue}: the candidate market, its
 * best Layer-2 match (market + similarity), and the reason(s) it was escalated.
 * The queue derives the canonical pair key from `candidate.id` and
 * `best.market.id`, so callers never construct the key themselves.
 */
export interface CalibrationItem {
  /** The new/updated market being matched (design `candidate`). */
  candidate: Market;
  /** The best Layer-2 match: the pool market and its cosine similarity. */
  best: ScoredMarket;
  /**
   * Why this pair needs human review — non-empty. A pair can be escalated for
   * both reasons at once (below the auto-confirm bar AND high-value).
   */
  reasons: CalibrationReason[];
}

// ---------------------------------------------------------------------------
// Pair-key canonicalization
// ---------------------------------------------------------------------------

/** Separator used to serialize a canonical pair into a Map key (NUL: never in a UUID). */
const PAIR_KEY_SEPARATOR = "\u0000";

/** A canonical, order-independent identity for an unordered market pair. */
export interface CanonicalPair {
  /** Lexicographically smaller id. */
  marketAId: string;
  /** Lexicographically larger id (equal to `marketAId` only if both ids match). */
  marketBId: string;
  /** A single stable string key for use in a Map/Set. */
  key: string;
}

/**
 * Canonicalize an unordered market pair so `(A, B)` and `(B, A)` map to the
 * same identity. Returns the two ids in lexicographic order plus a single
 * string `key`. This is the shared rule both ports use to satisfy the
 * `match_label UNIQUE(market_a_id, market_b_id)` constraint and keep linkage
 * symmetric (Requirement 2.2).
 *
 * Pure and deterministic.
 *
 * @param idOne One market id.
 * @param idTwo The other market id.
 */
export function canonicalPairKey(idOne: string, idTwo: string): CanonicalPair {
  const [marketAId, marketBId] = idOne <= idTwo ? [idOne, idTwo] : [idTwo, idOne];
  return { marketAId, marketBId, key: `${marketAId}${PAIR_KEY_SEPARATOR}${marketBId}` };
}

// ---------------------------------------------------------------------------
// Ports: calibration queue + labeled-data store
// ---------------------------------------------------------------------------

/**
 * Port for the human calibration queue (design `calibrationQueue`). The gate
 * enqueues ambiguous/high-value pairs; an operator UI lists/peeks pending work
 * and resolves an item once a human has judged it.
 *
 * Implementations MUST key entries by the canonical pair
 * ({@link canonicalPairKey} of `candidate.id` and `best.market.id`) so a pair
 * is queued at most once regardless of orientation; {@link enqueue} is
 * idempotent on that key (re-enqueuing updates the pending entry, never
 * duplicates it). {@link list} and {@link peek} expose pending work in FIFO
 * (oldest-first) order.
 */
export interface CalibrationQueue {
  /**
   * Enqueue a pending pair for human review. Idempotent on the canonical pair
   * key: enqueuing the same pair again (in either orientation) replaces the
   * pending entry rather than adding a second one.
   */
  enqueue(item: CalibrationItem): Promise<void>;
  /** All pending items, oldest enqueued first. */
  list(): Promise<CalibrationItem[]>;
  /** The oldest pending item without removing it, or `null` when empty. */
  peek(): Promise<CalibrationItem | null>;
  /** Number of pending items. */
  size(): Promise<number>;
  /**
   * Remove and return the pending item for a pair (order-independent), or
   * `null` when no such item is queued.
   */
  remove(idOne: string, idTwo: string): Promise<CalibrationItem | null>;
}

/**
 * Port for the labeled-data store backing the calibration feedback loop
 * (design "confirmed/rejected pairs from Layer 3 are stored as labeled data";
 * Requirement 11.4). Mirrors the `match_label` table.
 *
 * {@link put} is idempotent on the canonical pair (the table's
 * `UNIQUE(market_a_id, market_b_id)`): labeling `(A, B)` then `(B, A)` yields a
 * single row whose later write wins (`ON CONFLICT ... DO UPDATE`). {@link get}
 * reads a label order-independently; {@link list} returns the full label set
 * (training data for tuning Layers 1-2).
 */
export interface MatchLabelStore {
  /**
   * Idempotent upsert of a label keyed on the canonical pair. The stored row's
   * `marketAId`/`marketBId` are canonicalized; the returned label reflects what
   * was persisted.
   */
  put(label: MatchLabel): Promise<MatchLabel>;
  /** Read the label for a pair (order-independent), or `null` when absent. */
  get(idOne: string, idTwo: string): Promise<MatchLabel | null>;
  /** All labels, for the feedback loop / training data (Requirement 11.4). */
  list(): Promise<MatchLabel[]>;
}

// ---------------------------------------------------------------------------
// High-value policy
// ---------------------------------------------------------------------------

/**
 * A pluggable predicate deciding whether a candidate/best pair is "high-value"
 * and therefore worth a human's eyes even when similarity clears the
 * auto-confirm bar (design `isHighValue(candidate, best)`). Injecting a custom
 * predicate lets an operator encode their own escalation policy.
 */
export type HighValuePredicate = (candidate: Market, best: ScoredMarket) => boolean;

/** Tuning knobs for the default {@link isHighValue} heuristic. */
export interface HighValueOptions {
  /**
   * Combined 24h volume (`candidate.volume24h + best.market.volume24h`,
   * treating `null` as `0`) at or above which a pair is high-value. Defaults to
   * {@link DEFAULT_HIGH_VALUE_VOLUME}.
   */
  volumeThreshold?: number;
  /**
   * Combined liquidity (`candidate.liquidity + best.market.liquidity`, `null`
   * as `0`) at or above which a pair is high-value. Defaults to
   * {@link DEFAULT_HIGH_VALUE_LIQUIDITY}.
   */
  liquidityThreshold?: number;
}

/**
 * Default combined-24h-volume bar for {@link isHighValue}. A deliberately
 * conservative, units-agnostic default (markets are denominated per source —
 * USDC, MANA — so operators should tune this per deployment).
 */
export const DEFAULT_HIGH_VALUE_VOLUME = 100_000;

/** Default combined-liquidity bar for {@link isHighValue}. */
export const DEFAULT_HIGH_VALUE_LIQUIDITY = 100_000;

/** Coerce a nullable numeric metric to `0` so missing data never reads as high-value. */
function metric(value: number | null): number {
  return value ?? 0;
}

/**
 * Default high-value heuristic: a pair is high-value when the **combined** 24h
 * volume OR the **combined** liquidity of the candidate and its best match
 * meets/exceeds the configured threshold. Missing (`null`) metrics count as
 * `0`, so a pair is never escalated for value on the strength of absent data.
 *
 * This is intentionally simple and overridable: the rationale is that mistakes
 * on large, liquid markets are the costly ones, so they warrant human review
 * even at high similarity. Supply {@link HighValueOptions} to retune the bars,
 * or inject a different {@link HighValuePredicate} entirely via
 * {@link CalibrationGateOptions.isHighValue}.
 *
 * Pure and deterministic.
 *
 * @param candidate The new/updated market.
 * @param best The best Layer-2 match (market + similarity).
 * @param options Threshold overrides; defaults documented above.
 */
export function isHighValue(
  candidate: Market,
  best: ScoredMarket,
  options: HighValueOptions = {},
): boolean {
  const volumeThreshold = options.volumeThreshold ?? DEFAULT_HIGH_VALUE_VOLUME;
  const liquidityThreshold = options.liquidityThreshold ?? DEFAULT_HIGH_VALUE_LIQUIDITY;

  const combinedVolume = metric(candidate.volume24h) + metric(best.market.volume24h);
  const combinedLiquidity = metric(candidate.liquidity) + metric(best.market.liquidity);

  return combinedVolume >= volumeThreshold || combinedLiquidity >= liquidityThreshold;
}

// ---------------------------------------------------------------------------
// The Layer 3 calibration gate
// ---------------------------------------------------------------------------

/**
 * The outcome of {@link calibrationGate} — the design's three Layer-3 paths:
 *  - `NoMatch`            — no best candidate (Layer 2 found nothing).
 *  - `PendingCalibration` — escalated to the human queue; **not** auto-linked.
 *  - `AutoConfirm`        — confident, non-high-value; eligible for Layer 4.
 */
export type CalibrationDecision =
  | { kind: "NoMatch" }
  | { kind: "PendingCalibration"; item: CalibrationItem }
  | { kind: "AutoConfirm"; best: ScoredMarket };

/** Collaborators for {@link calibrationGate}. */
export interface CalibrationGateDeps {
  /** Queue to enqueue ambiguous/high-value pairs into. */
  queue: CalibrationQueue;
  /**
   * Optional label store. When present and {@link CalibrationGateOptions.recordAutoLabel}
   * is set, an `"auto"` `"same"` label is written on auto-confirm.
   */
  labels?: MatchLabelStore;
}

/** Tuning for {@link calibrationGate}. */
export interface CalibrationGateOptions {
  /**
   * Similarity at/above which a (non-high-value) pair auto-confirms. Defaults
   * to {@link AUTO_CONFIRM_THRESHOLD}.
   */
  autoConfirmThreshold?: number;
  /**
   * High-value escalation policy. A custom {@link HighValuePredicate} fully
   * replaces the default; otherwise {@link isHighValue} runs with
   * {@link highValue} options.
   */
  isHighValue?: HighValuePredicate;
  /** Threshold overrides for the default {@link isHighValue} heuristic. */
  highValue?: HighValueOptions;
  /**
   * When `true` and `deps.labels` is provided, record an `"auto"` `"same"`
   * label on auto-confirm (so auto-links also accumulate as labeled data).
   * Defaults to `false`.
   */
  recordAutoLabel?: boolean;
}

/**
 * Layer 3 calibration gate (design `matchMarket` Layer 3). Given Layer 2's best
 * match, decide whether to auto-confirm (continue to Layer 4) or escalate to
 * the human calibration queue — never auto-linking an ambiguous or high-value
 * pair (Requirement 11.2):
 *
 *  1. `best === null` → `NoMatch` (nothing to do).
 *  2. `best.similarity < autoConfirmThreshold` OR the pair is high-value →
 *     {@link CalibrationQueue.enqueue} the pair and return `PendingCalibration`.
 *     The escalation `reasons` record which condition(s) fired.
 *  3. otherwise → `AutoConfirm`. If `options.recordAutoLabel` and `deps.labels`
 *     are set, also persist an `"auto"`/`"same"` label.
 *
 * The gate performs no canonical linking itself — that is Layer 4's job
 * (task 6.4). It only routes: enqueue-for-review vs. eligible-to-link.
 *
 * @param candidate The new/updated market being matched.
 * @param best Layer 2's argmax match, or `null` when the pool had no match.
 * @param deps The calibration queue and (optional) label store.
 * @param options Threshold/high-value/auto-label tuning.
 * @returns The routing decision.
 */
export async function calibrationGate(
  candidate: Market,
  best: ScoredMarket | null,
  deps: CalibrationGateDeps,
  options: CalibrationGateOptions = {},
): Promise<CalibrationDecision> {
  if (best === null) return { kind: "NoMatch" };

  const autoConfirmThreshold = options.autoConfirmThreshold ?? AUTO_CONFIRM_THRESHOLD;
  const highValuePredicate: HighValuePredicate =
    options.isHighValue ?? ((c, b) => isHighValue(c, b, options.highValue));

  const reasons: CalibrationReason[] = [];
  if (best.similarity < autoConfirmThreshold) reasons.push("below-threshold");
  if (highValuePredicate(candidate, best)) reasons.push("high-value");

  if (reasons.length > 0) {
    const item: CalibrationItem = { candidate, best, reasons };
    await deps.queue.enqueue(item);
    return { kind: "PendingCalibration", item };
  }

  if (options.recordAutoLabel === true && deps.labels !== undefined) {
    const pair = canonicalPairKey(candidate.id, best.market.id);
    await deps.labels.put({
      marketAId: pair.marketAId,
      marketBId: pair.marketBId,
      decision: "same",
      similarity: best.similarity,
      labeledBy: "auto",
    });
  }

  return { kind: "AutoConfirm", best };
}

// ---------------------------------------------------------------------------
// Recording a human calibration decision (the feedback loop)
// ---------------------------------------------------------------------------

/** A human's verdict on a queued pair, fed to {@link recordCalibrationDecision}. */
export interface HumanCalibrationDecision {
  /** One market id of the reviewed pair (order does not matter). */
  marketAId: string;
  /** The other market id of the reviewed pair. */
  marketBId: string;
  /** The human verdict: same question or not. */
  decision: MatchDecisionLabel;
  /**
   * Optional similarity to record. When omitted, the queued item's similarity
   * is used (or `null` when the pair was not in the queue).
   */
  similarity?: number | null;
}

/** Collaborators for {@link recordCalibrationDecision}. */
export interface CalibrationRecordDeps {
  /** Queue the resolved pair is removed from. */
  queue: CalibrationQueue;
  /** Store the human label is persisted to. */
  labels: MatchLabelStore;
}

/**
 * Record a human calibration decision as labeled data and dequeue the pair
 * (design "confirmed/rejected pairs from Layer 3 are stored as labeled data";
 * Requirement 11.4).
 *
 * Steps:
 *  1. Remove the pair from the calibration queue (best-effort; a no-op when the
 *     pair is not queued).
 *  2. Persist a `labeledBy: "human"` label via {@link MatchLabelStore.put},
 *     idempotently on the canonical pair — so resolving the same pair twice
 *     leaves exactly one row (the latest verdict wins).
 *
 * `similarity` defaults to the queued item's similarity when not supplied; if
 * the pair was not queued and no similarity is given, it is stored as `null`.
 *
 * @param decision The human verdict (pair ids + same/different).
 * @param deps The queue and label store.
 * @returns The persisted (canonicalized) label.
 */
export async function recordCalibrationDecision(
  decision: HumanCalibrationDecision,
  deps: CalibrationRecordDeps,
): Promise<MatchLabel> {
  const removed = await deps.queue.remove(decision.marketAId, decision.marketBId);

  const similarity =
    decision.similarity !== undefined ? decision.similarity : (removed?.best.similarity ?? null);

  const pair = canonicalPairKey(decision.marketAId, decision.marketBId);
  return deps.labels.put({
    marketAId: pair.marketAId,
    marketBId: pair.marketBId,
    decision: decision.decision,
    similarity,
    labeledBy: "human",
  });
}

// ---------------------------------------------------------------------------
// In-memory reference adapters (used by tests; mirror the production contract)
// ---------------------------------------------------------------------------

/**
 * In-memory {@link CalibrationQueue} — the reference adapter. Backed by a `Map`
 * keyed on the canonical pair key, which preserves insertion order so
 * {@link list}/{@link peek} are FIFO. Enqueue is idempotent on the pair.
 *
 * **Not** durable: production wires a persistent queue behind the
 * {@link CalibrationQueue} port. Used directly in tests and as the contract
 * spec a real adapter must satisfy.
 */
export class InMemoryCalibrationQueue implements CalibrationQueue {
  private readonly items = new Map<string, CalibrationItem>();

  private keyFor(item: CalibrationItem): string {
    return canonicalPairKey(item.candidate.id, item.best.market.id).key;
  }

  enqueue(item: CalibrationItem): Promise<void> {
    // Re-enqueue replaces the pending entry (idempotent on the canonical pair),
    // but delete-then-set so the refreshed item moves to the back of the FIFO.
    const key = this.keyFor(item);
    this.items.delete(key);
    this.items.set(key, item);
    return Promise.resolve();
  }

  list(): Promise<CalibrationItem[]> {
    return Promise.resolve([...this.items.values()]);
  }

  peek(): Promise<CalibrationItem | null> {
    for (const item of this.items.values()) return Promise.resolve(item);
    return Promise.resolve(null);
  }

  size(): Promise<number> {
    return Promise.resolve(this.items.size);
  }

  remove(idOne: string, idTwo: string): Promise<CalibrationItem | null> {
    const { key } = canonicalPairKey(idOne, idTwo);
    const existing = this.items.get(key) ?? null;
    if (existing !== null) this.items.delete(key);
    return Promise.resolve(existing);
  }
}

/**
 * In-memory {@link MatchLabelStore} — the reference adapter. Backed by a `Map`
 * keyed on the canonical pair key, so {@link put} is idempotent on
 * `(market_a_id, market_b_id)` exactly like the `match_label` UNIQUE
 * constraint. Stored ids are canonicalized.
 *
 * **Not** durable and it does not enforce the DB's `similarity BETWEEN 0 AND 1`
 * CHECK (that is the database's responsibility). Production wires the
 * Postgres-backed `match_label` table behind the {@link MatchLabelStore} port.
 */
export class InMemoryMatchLabelStore implements MatchLabelStore {
  private readonly labels = new Map<string, MatchLabel>();

  put(label: MatchLabel): Promise<MatchLabel> {
    const pair = canonicalPairKey(label.marketAId, label.marketBId);
    const canonical: MatchLabel = {
      marketAId: pair.marketAId,
      marketBId: pair.marketBId,
      decision: label.decision,
      similarity: label.similarity,
      labeledBy: label.labeledBy,
    };
    // ON CONFLICT DO UPDATE: the latest write for a pair wins (one row).
    this.labels.set(pair.key, canonical);
    return Promise.resolve(canonical);
  }

  get(idOne: string, idTwo: string): Promise<MatchLabel | null> {
    const { key } = canonicalPairKey(idOne, idTwo);
    return Promise.resolve(this.labels.get(key) ?? null);
  }

  list(): Promise<MatchLabel[]> {
    return Promise.resolve([...this.labels.values()]);
  }
}
