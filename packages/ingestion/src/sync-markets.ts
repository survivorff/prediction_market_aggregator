/**
 * Metadata incremental sync — `syncMarkets` (design.md "Ingestion Pipeline
 * Algorithms" → "Metadata incremental sync"; task 5.1).
 *
 * Drives one keyset-paginated metadata sync pass for a single source: fetch a
 * page, normalize + validate each market, idempotently upsert it, hand it to
 * the matching engine, and only THEN advance and persist the keyset cursor.
 *
 * The load-bearing invariant is **cursor-after-durable-write** (Requirements
 * 7.1, 7.3 / design Property 6):
 *
 * - The cursor is persisted *only after* every write for the page succeeds.
 * - If any write throws, the error propagates and the stored cursor is left
 *   untouched — there is no temporary advancement and nothing to roll back, so
 *   a re-run resumes from exactly the failed page (crash-safe resume).
 * - Cursors therefore never regress: within a run they only move forward by
 *   following `page.nextCursor`, and across runs we resume from
 *   `repo.loadCursor`.
 *
 * The per-page fetch goes through an injectable {@link FetchWrapper} seam that
 * defaults to a pass-through. Task 5.2's `withRetry` (rate limiting + jittered
 * exponential backoff) plugs in here without touching this algorithm.
 *
 * Requirements: 7.1 (idempotent ingestion), 7.3 (cursor persisted only after a
 * durable write; never regress; crash-safe resume), 11.1 (each ingested/updated
 * market is handed to the matching engine via {@link EnqueueForMatching}).
 */

import type {
  Market,
  MarketRepository,
  MarketSource,
  MarketUpsert,
  NormalizedMarket,
  NormalizedOutcome,
  OutcomeRepository,
  OutcomeUpsert,
} from "@pma/core";
import {
  normalizeBinaryProbabilities,
  normalizeProbability,
  normalizeResolutionCriteria,
  normalizeSpread,
} from "@pma/core";

/** Default keyset page size (`PAGE_SIZE` in the design pseudocode). */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * The injectable per-page fetch seam. `syncMarkets` runs each
 * `source.fetchMarkets(...)` through this wrapper so the resilient fetch
 * behavior (task 5.2 `withRetry`: token-bucket rate limiting + jittered
 * exponential backoff) can be layered in without changing this algorithm. The
 * default is a transparent pass-through.
 */
export type FetchWrapper = <T>(operation: () => Promise<T>) => Promise<T>;

/**
 * Hook invoked once per ingested/updated market so the same-question matching
 * engine (task 6) can evaluate it (Requirement 11.1). It receives the
 * **persisted** {@link Market} (with its resolved internal `id`), because
 * `matchMarket` keys off the persisted row. Defaults to a no-op so ingestion
 * runs standalone before matching is wired up; production passes a queue
 * producer here. A rejected promise/throw propagates and aborts the page
 * before the cursor advances (the market is durably written, but the page is
 * not considered complete until matching has been enqueued).
 */
export type EnqueueForMatching = (market: Market) => void | Promise<void>;

/** Options for {@link syncMarkets}; every field has a safe default. */
export interface SyncMarketsOptions {
  /** Page size for keyset pagination. Defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
  /**
   * Per-page fetch wrapper seam. Defaults to a pass-through; task 5.2 injects
   * `withRetry` here.
   */
  fetchWrapper?: FetchWrapper;
  /**
   * Matching-engine hook invoked per market (Requirement 11.1). Defaults to a
   * no-op.
   */
  enqueueForMatching?: EnqueueForMatching;
  /**
   * Optional outcome persistence. When provided, each market's normalized
   * outcomes are upserted (idempotent on `(market_id, label)`) after the market
   * row is written. When omitted, outcome persistence is left to a later pass.
   */
  outcomeRepo?: OutcomeRepository;
  /**
   * ISO 8601 lower bound for incremental sync — forwarded as
   * `PageRequest.updatedSince` so only markets changed after this instant are
   * returned. Omit for a full sync window.
   */
  updatedSince?: string;
}

/**
 * Outcome of a single {@link syncMarkets} pass (design `SyncResult`).
 */
export interface SyncResult {
  /** Stable source slug (`source.meta.key`). */
  sourceKey: string;
  /** Internal source UUID (`source.meta.id`). */
  sourceId: string;
  /** Total markets upserted across all pages in this pass. */
  processed: number;
  /** Number of pages durably written (and cursors persisted) this pass. */
  pages: number;
}

/** A market's outcomes after normalization, minus the not-yet-resolved `marketId`. */
type NormalizedOutcomeValues = Omit<OutcomeUpsert, "marketId">;

/** Result of {@link normalizeAndValidate}: the upsertable market + its outcomes. */
export interface NormalizedMarketEntity {
  market: MarketUpsert;
  outcomes: NormalizedOutcomeValues[];
}

/** Transparent default fetch seam: invoke the operation as-is. */
const passThroughFetch: FetchWrapper = (operation) => operation();

/** Default matching hook: do nothing (ingestion can run before matching). */
const noopEnqueue: EnqueueForMatching = () => undefined;

/**
 * Run one keyset-paginated metadata sync pass for `source`, writing markets
 * idempotently and advancing the cursor only after each page is durably
 * written. Follows the design's `syncMarkets` pseudocode exactly.
 *
 * **Preconditions:** `source` is registered and `source.meta.id` is resolved;
 * `repo` exposes `loadCursor`/`upsertMarket`/`saveCursor`.
 *
 * **Postconditions:** every market in the sync window is upserted by
 * `(source_id, external_id)`; the cursor is advanced + persisted only after a
 * page's writes succeed; the pass is idempotent (re-running over the same
 * upstream state yields no duplicate rows and no net change).
 *
 * **Loop invariant:** after processing page *k*, all markets in pages `0..k`
 * are persisted and the persisted cursor points at the boundary after page *k*.
 */
export async function syncMarkets(
  source: MarketSource,
  repo: MarketRepository,
  options: SyncMarketsOptions = {},
): Promise<SyncResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const fetchWrapper = options.fetchWrapper ?? passThroughFetch;
  const enqueueForMatching = options.enqueueForMatching ?? noopEnqueue;
  const { outcomeRepo, updatedSince } = options;
  const sourceId = source.meta.id;

  // Resume from the persisted cursor (`null` = start of the sync window).
  let cursor = await repo.loadCursor(sourceId);
  let processed = 0;
  let pages = 0;

  // REPEAT ... UNTIL cursor = NULL: always fetch at least one page.
  for (;;) {
    const page = await fetchWrapper(() =>
      source.fetchMarkets({
        // `PageRequest.cursor` is `undefined` (not `null`) at the start.
        cursor: cursor ?? undefined,
        limit: pageSize,
        ...(updatedSince !== undefined ? { updatedSince } : {}),
      }),
    );

    // Durably write the WHOLE page before touching the cursor. If any write
    // throws, the error propagates here and `saveCursor` below is never
    // reached, so the stored cursor stays exactly where this page began — a
    // re-run resumes from the same place (Requirements 7.1, 7.3).
    for (const rawMarket of page.items) {
      const { market, outcomes } = normalizeAndValidate(rawMarket, sourceId);

      // Idempotent: ON CONFLICT (source_id, external_id) DO UPDATE.
      const persisted = await repo.upsertMarket(market);

      if (outcomeRepo && outcomes.length > 0) {
        const rows: OutcomeUpsert[] = outcomes.map((outcome) => ({
          ...outcome,
          marketId: persisted.id,
        }));
        await outcomeRepo.upsertOutcomes(rows);
      }

      // Feed the matching engine (Requirement 11.1).
      await enqueueForMatching(persisted);
      processed += 1;
    }

    // Page is durably written — only now is it safe to advance + persist the
    // cursor (design "durable only after writes").
    cursor = page.nextCursor;
    await repo.saveCursor(sourceId, cursor);
    pages += 1;

    if (cursor === null) break;
  }

  return { sourceKey: source.meta.key, sourceId, processed, pages };
}

/**
 * Map an adapter's {@link NormalizedMarket} into an upsertable
 * {@link MarketUpsert} plus its normalized outcomes, applying the domain
 * validation helpers (Requirements 1.3, 10.3).
 *
 * - `sourceId` is stamped from the registered source.
 * - `eventId` is left `null`: events are synced by a separate pass and the
 *   adapter only exposes the platform-native `eventExternalId`; resolving it to
 *   an internal UUID is intentionally out of scope for the market sync.
 * - `canonicalEventId` is left `null`: it is set later by the matching engine
 *   (task 6), never at ingestion time.
 * - `spread` is normalized to `>= 0` or `null`; `resolutionCriteria` always
 *   preserves `raw` for auditability.
 */
export function normalizeAndValidate(
  raw: NormalizedMarket,
  sourceId: string,
): NormalizedMarketEntity {
  const market: MarketUpsert = {
    sourceId,
    eventId: null,
    canonicalEventId: null,
    externalId: raw.externalId,
    question: raw.question,
    status: raw.status,
    volume24h: raw.volume24h,
    liquidity: raw.liquidity,
    spread: normalizeSpread(raw.spread),
    resolutionCriteria: normalizeResolutionCriteria(raw.resolutionCriteria),
  };

  return { market, outcomes: normalizeOutcomes(raw.outcomes) };
}

/**
 * Normalize a market's outcome probabilities into `[0, 1]` (or `null` when
 * missing/unparseable).
 *
 * A binary market — exactly two outcomes both carrying an implied probability —
 * is normalized jointly via {@link normalizeBinaryProbabilities} so the pair
 * sums to within tolerance of 1 (Requirement 1.3). Any other shape normalizes
 * each probability independently with {@link normalizeProbability}. `lastPrice`
 * is always normalized per-outcome.
 */
function normalizeOutcomes(outcomes: readonly NormalizedOutcome[]): NormalizedOutcomeValues[] {
  const [first, second] = outcomes;
  if (
    outcomes.length === 2 &&
    first &&
    second &&
    typeof first.impliedProb === "number" &&
    typeof second.impliedProb === "number"
  ) {
    const { normalized } = normalizeBinaryProbabilities([first.impliedProb, second.impliedProb]);
    return outcomes.map((outcome, index) => ({
      label: outcome.label,
      tokenId: outcome.tokenId,
      impliedProb: normalized[index] ?? normalizeProbability(outcome.impliedProb),
      lastPrice: normalizeProbability(outcome.lastPrice),
    }));
  }

  return outcomes.map((outcome) => ({
    label: outcome.label,
    tokenId: outcome.tokenId,
    impliedProb: normalizeProbability(outcome.impliedProb),
    lastPrice: normalizeProbability(outcome.lastPrice),
  }));
}
