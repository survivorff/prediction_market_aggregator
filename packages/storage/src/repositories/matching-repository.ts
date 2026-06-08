/**
 * {@link MatchingRepository} — candidate search + canonical linking for the
 * same-question matching engine (design.md `matchMarket`; Requirements 11.x,
 * 2.2). Implements the `@pma/core` `MatchingRepository` port that the matching
 * layers (`findCandidatePool`, `linkAfterAlignment`, `computeSignals`) depend
 * on.
 *
 *   - {@link findCandidates} — Layer-1 candidate search (category + open status
 *     + optional subject-entity text match), bounded so the Layer-2 embedding
 *     pass stays tractable even when the category is broad.
 *   - {@link linkToCanonical} — link two markets into a shared canonical event
 *     (reusing an existing one when either market is already linked, else
 *     creating it), applying the `resolutionMismatch` flag.
 *   - {@link marketsForCanonical} — membership query carrying each market's
 *     `resolutionMismatch` flag (consumed by `computeSignals`).
 *
 * Candidate-search simplification (documented): the normalized `Market` domain
 * row carries no end date, so this v1 query scopes by category + open status +
 * a subject-entity ILIKE (when extractable) and bounds the pool by a LIMIT
 * ordered by 24h volume. The `CandidateQuery.timeWindow` / `threshold` signals
 * are available on the query but the precise narrowing is left to Layer 2
 * (embedding similarity); this keeps a broad category (e.g. the denormalized
 * `'other'` default) from returning an unbounded pool.
 */

import type {
  CandidateQuery,
  CanonicalEvent,
  CanonicalLinkOptions,
  LinkedMarket,
  Market,
  MatchingRepository as IMatchingRepository,
} from "@pma/core";
import type { Queryable } from "../client.js";
import { mapCanonicalEventRow, mapMarketRow, type CanonicalEventRow, type MarketRow } from "../mappers.js";

const MARKET_COLUMNS = `id, source_id, event_id, canonical_event_id, external_id,
  question, category, status, volume_24h, liquidity, spread,
  resolution_criteria, resolution_mismatch, updated_at`;

const CANONICAL_COLUMNS = `id, title, category, subject_entity, threshold_value, target_date`;

/** Default upper bound on the Layer-1 candidate pool (keeps Layer 2 tractable). */
export const DEFAULT_CANDIDATE_LIMIT = 100;

export class MatchingRepository implements IMatchingRepository {
  constructor(
    private readonly db: Queryable,
    private readonly candidateLimit: number = DEFAULT_CANDIDATE_LIMIT,
  ) {}

  /**
   * Layer-1 candidate search. Returns OPEN markets in the query's category,
   * excluding the candidate itself, optionally narrowed by a subject-entity
   * text match, bounded by {@link candidateLimit} ordered by 24h volume (so the
   * highest-liquidity candidates are preferred when the pool is large).
   */
  async findCandidates(query: CandidateQuery): Promise<Market[]> {
    const params: unknown[] = [query.category];
    let sql = `SELECT ${MARKET_COLUMNS} FROM market
       WHERE category = $1
         AND status = 'open'`;

    if (query.excludeMarketId !== undefined) {
      params.push(query.excludeMarketId);
      sql += ` AND id <> $${params.length}`;
    }
    if (query.subjectEntity !== null && query.subjectEntity.trim() !== "") {
      params.push(`%${query.subjectEntity.trim()}%`);
      sql += ` AND question ILIKE $${params.length}`;
    }

    params.push(this.candidateLimit);
    sql += ` ORDER BY volume_24h DESC NULLS LAST, id ASC LIMIT $${params.length}`;

    const result = await this.db.query<MarketRow>(sql, params);
    return result.rows.map(mapMarketRow);
  }

  /**
   * Link two markets to a shared canonical event. If either market is already
   * linked, that canonical event is reused (marketA's takes precedence);
   * otherwise a new canonical event is created from marketA's metadata. Both
   * markets are then set to the canonical id and flagged with `mismatch`.
   *
   * Linkage is symmetric: both rows end up pointing at the same canonical id,
   * so {@link marketsForCanonical} membership is order-independent (Req 2.2).
   */
  async linkToCanonical(
    marketA: Market,
    marketB: Market,
    options: CanonicalLinkOptions,
  ): Promise<CanonicalEvent> {
    const canonicalId =
      marketA.canonicalEventId ??
      marketB.canonicalEventId ??
      (await this.createCanonicalFromMarket(marketA.id));

    // Point both markets at the shared canonical event and apply the mismatch
    // flag (a mismatched pair is linked but excluded from spread signals).
    await this.db.query(
      `UPDATE market
         SET canonical_event_id = $1, resolution_mismatch = $2
       WHERE id = ANY($3::uuid[])`,
      [canonicalId, options.mismatch, [marketA.id, marketB.id]],
    );

    const canonical = await this.getCanonical(canonicalId);
    if (canonical === null) {
      throw new Error(`linkToCanonical: canonical event ${canonicalId} not found after link`);
    }
    return canonical;
  }

  /**
   * Return all markets linked to a canonical event, each carrying its
   * `resolutionMismatch` flag as a {@link LinkedMarket} (consumed by
   * `computeSignals`).
   */
  async marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    const result = await this.db.query<MarketRow>(
      `SELECT ${MARKET_COLUMNS} FROM market
       WHERE canonical_event_id = $1
       ORDER BY id ASC`,
      [canonicalEventId],
    );
    return result.rows.map((row) => ({
      ...mapMarketRow(row),
      resolutionMismatch: row.resolution_mismatch,
    }));
  }

  /**
   * Create a canonical event seeded from a market's row (title = question,
   * category from the denormalized column). Subject/threshold/target are left
   * null here; the matching engine can enrich them later.
   */
  private async createCanonicalFromMarket(marketId: string): Promise<string> {
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO canonical_event (title, category, subject_entity, threshold_value, target_date)
       SELECT m.question, m.category, NULL, NULL, NULL
       FROM market m WHERE m.id = $1
       RETURNING id`,
      [marketId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`createCanonicalFromMarket: market ${marketId} not found`);
    return row.id;
  }

  /** Fetch a canonical event by id; `null` when not present. */
  private async getCanonical(id: string): Promise<CanonicalEvent | null> {
    const result = await this.db.query<CanonicalEventRow>(
      `SELECT ${CANONICAL_COLUMNS} FROM canonical_event WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapCanonicalEventRow(row) : null;
  }
}
