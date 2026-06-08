/**
 * {@link CanonicalEventRepository} — persistence for cross-platform
 * {@link CanonicalEvent} groupings (the basis of the comparison view and spread
 * signals). Linking markets to a canonical event is handled by the matching
 * repository (task scope: tasks 3.3+) so the matching vocabulary stays cohesive.
 *
 * Beyond the core {@link ICanonicalEventRepository} contract (create / getById /
 * listByCategory), this repository owns the read-only canonical SQL that backs
 * the outbound API gateway's comparison + signals endpoints (design.md
 * "Outbound API Surface", Requirements 2.1, 2.3, 2.4, 3.1, 3.2):
 *   - {@link listSummaries} — cross-platform groupings + a lightweight member
 *     count summary (`GET /api/canonical-events`).
 *   - {@link comparisonMembers} — each linked market's per-platform row data for
 *     the comparison view (`GET /api/canonical-events/{id}`), carrying the
 *     `resolution_mismatch` flag (Req 2.3) and the joined Yes-outcome implied
 *     probability.
 *   - {@link marketsForCanonical} — the {@link MatchingRepository}-shaped
 *     membership query (markets WHERE canonical_event_id = $1, each carrying its
 *     `resolutionMismatch` flag as a {@link LinkedMarket}) consumed by the
 *     matching engine's `computeSignals` (task 6.5) via the gateway.
 *
 * All canonical SQL lives here; the gateway maps the returned rows into its
 * response DTOs and overlays the Redis hot cache for latest prices (Req 10.4).
 */

import type {
  CanonicalEvent,
  CanonicalEventInput,
  CanonicalEventRepository as ICanonicalEventRepository,
  Category,
  LinkedMarket,
  MarketStatus,
} from "@pma/core";
import type { Queryable } from "../client.js";
import {
  mapCanonicalEventRow,
  mapMarketRow,
  numericToNumber,
  type CanonicalEventRow,
  type MarketRow,
} from "../mappers.js";

const CANONICAL_COLUMNS = `id, title, category, subject_entity, threshold_value, target_date`;

/** Market columns (incl. the matching `resolution_mismatch` flag) for {@link LinkedMarket}. */
const LINKED_MARKET_COLUMNS = `id, source_id, event_id, canonical_event_id, external_id,
  question, category, status, volume_24h, liquidity, spread,
  resolution_criteria, resolution_mismatch, updated_at`;

/** Optional filter for {@link CanonicalEventRepository.listSummaries}. */
export interface CanonicalEventFilter {
  /** Restrict to a single normalized category (Requirement 2.x / discovery parity). */
  category?: Category;
}

/**
 * A canonical event plus a lightweight cross-platform summary for the
 * `GET /api/canonical-events` list (design.md "Outbound API Surface"). The
 * counts are cheap aggregate columns (no per-member fan-out), so the list stays
 * inexpensive; the full per-platform rows + spread are computed on the detail
 * endpoint.
 */
export interface CanonicalEventSummaryRow {
  id: string;
  title: string;
  category: Category;
  subjectEntity: string | null;
  thresholdValue: number | null;
  targetDate: string | null;
  /** Number of markets linked to this canonical event. */
  memberCount: number;
  /** Number of linked markets flagged `resolution_mismatch = true` (Req 2.3). */
  mismatchCount: number;
}

/**
 * One linked market's data for the comparison view (design.md `ComparisonView`
 * row, Requirement 2.1). Carries the per-platform source identity, the
 * `resolutionMismatch` flag (Req 2.3), 24h volume, and the joined Yes-outcome
 * implied probability (which the gateway may overlay from the hot cache). The
 * market's external id is included so the gateway can key the hot-cache lookup
 * exactly as the ingestion `onTick` write path does.
 */
export interface CanonicalComparisonMemberRow {
  marketId: string;
  externalId: string;
  sourceKey: string;
  sourceName: string;
  status: MarketStatus;
  volume24h: number | null;
  resolutionMismatch: boolean;
  /** Label of the Yes outcome used for the hot-cache lookup; null when none. */
  yesOutcomeLabel: string | null;
  /** Stored Yes-outcome implied probability (0..1); null when unavailable. */
  yesImpliedProb: number | null;
}

/** Raw row shape for {@link CanonicalEventRepository.listSummaries}. */
interface SummaryQueryRow extends CanonicalEventRow {
  member_count: string | number;
  mismatch_count: string | number;
}

/** Raw row shape for {@link CanonicalEventRepository.comparisonMembers}. */
interface ComparisonMemberQueryRow {
  market_id: string;
  external_id: string;
  source_key: string;
  source_name: string;
  status: string;
  volume_24h: string | null;
  resolution_mismatch: boolean;
  yes_label: string | null;
  yes_implied_prob: string | null;
}

/** Parse a Postgres bigint `COUNT(...)` (returned as a string) to a number. */
function countToNumber(value: string | number): number {
  if (typeof value === "number") return value;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class CanonicalEventRepository implements ICanonicalEventRepository {
  constructor(private readonly db: Queryable) {}

  /** Create a canonical event; the persistence layer generates its `id`. */
  async create(canonical: CanonicalEventInput): Promise<CanonicalEvent> {
    const result = await this.db.query<CanonicalEventRow>(
      `INSERT INTO canonical_event
         (title, category, subject_entity, threshold_value, target_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${CANONICAL_COLUMNS}`,
      [
        canonical.title,
        canonical.category,
        canonical.subjectEntity,
        canonical.thresholdValue,
        canonical.targetDate,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("create: no row returned for canonical_event insert");
    }
    return mapCanonicalEventRow(row);
  }

  /** Fetch a canonical event by id; `null` when not present. */
  async getById(id: string): Promise<CanonicalEvent | null> {
    const result = await this.db.query<CanonicalEventRow>(
      `SELECT ${CANONICAL_COLUMNS} FROM canonical_event WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapCanonicalEventRow(row) : null;
  }

  /** List canonical events for a category (matching Layer-1 candidate scoping). */
  async listByCategory(category: Category): Promise<CanonicalEvent[]> {
    const result = await this.db.query<CanonicalEventRow>(
      `SELECT ${CANONICAL_COLUMNS} FROM canonical_event
       WHERE category = $1
       ORDER BY title ASC`,
      [category],
    );
    return result.rows.map(mapCanonicalEventRow);
  }

  /**
   * List cross-platform groupings with a lightweight member-count summary for
   * `GET /api/canonical-events` (Requirement 2.1). Optionally filter by
   * category. A LEFT JOIN keeps canonical events with no linked markets (count
   * 0) in the list; counts are computed in a single grouped query.
   */
  async listSummaries(filter: CanonicalEventFilter = {}): Promise<CanonicalEventSummaryRow[]> {
    const result = await this.db.query<SummaryQueryRow>(
      `SELECT
         ce.id,
         ce.title,
         ce.category,
         ce.subject_entity,
         ce.threshold_value,
         ce.target_date,
         COUNT(m.id) AS member_count,
         COUNT(m.id) FILTER (WHERE m.resolution_mismatch) AS mismatch_count
       FROM canonical_event ce
       LEFT JOIN market m ON m.canonical_event_id = ce.id
       WHERE ($1::text IS NULL OR ce.category = $1)
       GROUP BY ce.id, ce.title, ce.category, ce.subject_entity, ce.threshold_value, ce.target_date
       ORDER BY ce.title ASC, ce.id ASC`,
      [filter.category ?? null],
    );
    return result.rows.map(mapSummaryRow);
  }

  /**
   * Return each market linked to a canonical event with its per-platform source
   * identity, 24h volume, `resolution_mismatch` flag (Req 2.3), and the joined
   * Yes-outcome implied probability — the data the comparison view renders
   * side by side (Requirement 2.1). Ordered by source key for a stable view.
   */
  async comparisonMembers(canonicalEventId: string): Promise<CanonicalComparisonMemberRow[]> {
    const result = await this.db.query<ComparisonMemberQueryRow>(
      `SELECT
         m.id            AS market_id,
         m.external_id,
         s.key           AS source_key,
         s.name          AS source_name,
         m.status,
         m.volume_24h,
         m.resolution_mismatch,
         yes.label        AS yes_label,
         yes.implied_prob AS yes_implied_prob
       FROM market m
       JOIN source s ON s.id = m.source_id
       LEFT JOIN LATERAL (
         SELECT o.label, o.implied_prob
         FROM outcome o
         WHERE o.market_id = m.id AND lower(o.label) = 'yes'
         LIMIT 1
       ) yes ON true
       WHERE m.canonical_event_id = $1
       ORDER BY s.key ASC, m.id ASC`,
      [canonicalEventId],
    );
    return result.rows.map(mapComparisonMemberRow);
  }

  /**
   * Return all markets linked to a canonical event, each carrying its
   * `resolutionMismatch` flag as a {@link LinkedMarket} — the
   * {@link MatchingRepository}-shaped membership query consumed by the matching
   * engine's `computeSignals` (Requirements 3.2, 3.4). Linkage is symmetric, so
   * membership is order-independent (Requirement 2.2).
   */
  async marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    const result = await this.db.query<MarketRow>(
      `SELECT ${LINKED_MARKET_COLUMNS} FROM market
       WHERE canonical_event_id = $1
       ORDER BY id ASC`,
      [canonicalEventId],
    );
    return result.rows.map(mapLinkedMarketRow);
  }
}

function mapSummaryRow(row: SummaryQueryRow): CanonicalEventSummaryRow {
  const event = mapCanonicalEventRow(row);
  return {
    id: event.id,
    title: event.title,
    category: event.category,
    subjectEntity: event.subjectEntity,
    thresholdValue: event.thresholdValue,
    targetDate: event.targetDate,
    memberCount: countToNumber(row.member_count),
    mismatchCount: countToNumber(row.mismatch_count),
  };
}

function mapComparisonMemberRow(row: ComparisonMemberQueryRow): CanonicalComparisonMemberRow {
  return {
    marketId: row.market_id,
    externalId: row.external_id,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    status: row.status as MarketStatus,
    volume24h: numericToNumber(row.volume_24h),
    resolutionMismatch: row.resolution_mismatch,
    yesOutcomeLabel: row.yes_label,
    yesImpliedProb: numericToNumber(row.yes_implied_prob),
  };
}

/** Map a `market` row (incl. `resolution_mismatch`) to a {@link LinkedMarket}. */
function mapLinkedMarketRow(row: MarketRow): LinkedMarket {
  return { ...mapMarketRow(row), resolutionMismatch: row.resolution_mismatch };
}
