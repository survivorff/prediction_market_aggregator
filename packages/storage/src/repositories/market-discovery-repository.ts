/**
 * {@link MarketDiscoveryRepository} — read-only discovery + detail queries that
 * back the outbound API gateway (design.md "Outbound API Surface",
 * Requirements 1.1, 1.2, 1.4, 1.5, 4.1).
 *
 * All discovery SQL lives here (the storage layer owns SQL); the gateway maps
 * the returned rows into its response DTOs and overlays the Redis hot cache for
 * latest prices (Requirement 10.4). The queries lean on the discovery indexes
 * created in migration `001_core.sql`:
 *   - `idx_market_category_status` for `(category, status)` filtering;
 *   - `idx_market_question_fts` (GIN `to_tsvector`) for full-text search.
 *
 * The `category` column is denormalized onto `market`; `time remaining` is
 * derived from the owning `event.end_date` (a market has no end date of its
 * own), so the queries LEFT JOIN `event`. Sort keys are mapped from a closed
 * whitelist to fixed SQL fragments — never interpolated from caller input — so
 * sorting cannot be a SQL-injection vector.
 */

import type { Category, MarketStatus, ResolutionCriteria } from "@pma/core";
import type { Queryable } from "../client.js";
import { mapResolutionCriteria, numericToNumber, timestampToIso } from "../mappers.js";

/** Sortable discovery keys (Requirement 1.4: volume, liquidity, time remaining). */
export type MarketSortKey = "volume" | "liquidity" | "timeRemaining";

/** Sort direction. */
export type SortOrder = "asc" | "desc";

/** Filters/sort/pagination for {@link MarketDiscoveryRepository.listMarkets}. */
export interface MarketDiscoveryFilter {
  /** Normalized category filter (Requirement 1.2). */
  category?: Category;
  /** Lifecycle-status filter. */
  status?: MarketStatus;
  /** Full-text search over the question text (Requirement 1.2). */
  q?: string;
  /** Sort key; defaults to `"volume"`. */
  sort?: MarketSortKey;
  /** Sort direction; defaults to descending for volume/liquidity, ascending for timeRemaining. */
  order?: SortOrder;
  /** Page size (clamped to 1..200; defaults to 50). */
  limit?: number;
  /** Row offset (>= 0; defaults to 0). */
  offset?: number;
}

/**
 * A discovery row carrying the data needed for the gateway's `MarketSummary`
 * (design.md response contracts). The Yes-outcome implied probability is joined
 * in directly (no per-row N+1 query); the gateway may overlay the Redis hot
 * cache on top. Missing upstream values stay explicitly `null` (Requirement 1.5).
 */
export interface MarketSummaryRow {
  id: string;
  externalId: string;
  sourceKey: string;
  sourceName: string;
  question: string;
  category: Category;
  status: MarketStatus;
  volume24h: number | null;
  liquidity: number | null;
  /** Owning event end date (ISO 8601) used to derive time remaining; null when ungrouped/unknown. */
  endDate: string | null;
  canonicalEventId: string | null;
  /** Label of the Yes outcome used for the hot-cache lookup; null when none. */
  yesOutcomeLabel: string | null;
  /** Stored Yes-outcome implied probability (0..1); null when unavailable. */
  yesImpliedProb: number | null;
}

/**
 * Market metadata for the detail view (design.md `GET /api/markets/{id}`,
 * Requirement 4.1). Outcomes and latest prices are loaded separately by the
 * gateway (via {@link OutcomeRepository} + the hot cache).
 */
export interface MarketDetailRow {
  id: string;
  sourceId: string;
  sourceKey: string;
  sourceName: string;
  externalId: string;
  eventId: string | null;
  canonicalEventId: string | null;
  question: string;
  category: Category;
  status: MarketStatus;
  volume24h: number | null;
  liquidity: number | null;
  spread: number | null;
  endDate: string | null;
  resolutionCriteria: ResolutionCriteria;
}

/** Raw row shape for the discovery list query. */
interface SummaryQueryRow {
  id: string;
  external_id: string;
  source_key: string;
  source_name: string;
  question: string;
  category: string;
  status: string;
  volume_24h: string | null;
  liquidity: string | null;
  end_date: Date | string | null;
  canonical_event_id: string | null;
  yes_label: string | null;
  yes_implied_prob: string | null;
}

/** Raw row shape for the detail query. */
interface DetailQueryRow {
  id: string;
  source_id: string;
  source_key: string;
  source_name: string;
  external_id: string;
  event_id: string | null;
  canonical_event_id: string | null;
  question: string;
  category: string;
  status: string;
  volume_24h: string | null;
  liquidity: string | null;
  spread: string | null;
  end_date: Date | string | null;
  resolution_criteria: unknown;
}

/** Whitelisted sort key → SQL column fragment (never interpolated from input). */
const SORT_COLUMN: Record<MarketSortKey, string> = {
  volume: "m.volume_24h",
  liquidity: "m.liquidity",
  timeRemaining: "e.end_date",
};

/** Default sort direction per key (highest volume/liquidity first; soonest end first). */
const DEFAULT_ORDER: Record<MarketSortKey, SortOrder> = {
  volume: "desc",
  liquidity: "desc",
  timeRemaining: "asc",
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

export class MarketDiscoveryRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * List markets across all sources with a unified shape, applying optional
   * category/status/full-text filters and sort (Requirements 1.1, 1.2, 1.4).
   * Results are ordered by the chosen key (NULLS LAST) with a stable `id`
   * tiebreaker for deterministic keyset-free pagination.
   */
  async listMarkets(filter: MarketDiscoveryFilter = {}): Promise<MarketSummaryRow[]> {
    const sort = filter.sort ?? "volume";
    const order = filter.order ?? DEFAULT_ORDER[sort];
    const orderSql = order === "asc" ? "ASC" : "DESC";
    const sortColumn = SORT_COLUMN[sort];

    const q = filter.q && filter.q.trim().length > 0 ? filter.q.trim() : null;
    const limit = clampLimit(filter.limit);
    const offset = clampOffset(filter.offset);

    const result = await this.db.query<SummaryQueryRow>(
      `SELECT
         m.id,
         m.external_id,
         s.key  AS source_key,
         s.name AS source_name,
         m.question,
         m.category,
         m.status,
         m.volume_24h,
         m.liquidity,
         e.end_date,
         m.canonical_event_id,
         yes.label        AS yes_label,
         yes.implied_prob AS yes_implied_prob
       FROM market m
       JOIN source s ON s.id = m.source_id
       LEFT JOIN event e ON e.id = m.event_id
       LEFT JOIN LATERAL (
         SELECT o.label, o.implied_prob
         FROM outcome o
         WHERE o.market_id = m.id AND lower(o.label) = 'yes'
         LIMIT 1
       ) yes ON true
       WHERE ($1::text IS NULL OR m.category = $1)
         AND ($2::text IS NULL OR m.status = $2)
         AND ($3::text IS NULL OR to_tsvector('english', m.question) @@ plainto_tsquery('english', $3))
       ORDER BY ${sortColumn} ${orderSql} NULLS LAST, m.id ASC
       LIMIT $4 OFFSET $5`,
      [filter.category ?? null, filter.status ?? null, q, limit, offset],
    );

    return result.rows.map(mapSummaryRow);
  }

  /** Fetch a market's detail metadata by internal id; `null` when not present. */
  async getMarketDetail(id: string): Promise<MarketDetailRow | null> {
    const result = await this.db.query<DetailQueryRow>(
      `SELECT
         m.id,
         m.source_id,
         s.key  AS source_key,
         s.name AS source_name,
         m.external_id,
         m.event_id,
         m.canonical_event_id,
         m.question,
         m.category,
         m.status,
         m.volume_24h,
         m.liquidity,
         m.spread,
         e.end_date,
         m.resolution_criteria
       FROM market m
       JOIN source s ON s.id = m.source_id
       LEFT JOIN event e ON e.id = m.event_id
       WHERE m.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapDetailRow(row) : null;
  }
}

function mapSummaryRow(row: SummaryQueryRow): MarketSummaryRow {
  return {
    id: row.id,
    externalId: row.external_id,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    question: row.question,
    category: row.category as Category,
    status: row.status as MarketStatus,
    volume24h: numericToNumber(row.volume_24h),
    liquidity: numericToNumber(row.liquidity),
    endDate: timestampToIso(row.end_date),
    canonicalEventId: row.canonical_event_id,
    yesOutcomeLabel: row.yes_label,
    yesImpliedProb: numericToNumber(row.yes_implied_prob),
  };
}

function mapDetailRow(row: DetailQueryRow): MarketDetailRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceKey: row.source_key,
    sourceName: row.source_name,
    externalId: row.external_id,
    eventId: row.event_id,
    canonicalEventId: row.canonical_event_id,
    question: row.question,
    category: row.category as Category,
    status: row.status as MarketStatus,
    volume24h: numericToNumber(row.volume_24h),
    liquidity: numericToNumber(row.liquidity),
    spread: numericToNumber(row.spread),
    endDate: timestampToIso(row.end_date),
    resolutionCriteria: mapResolutionCriteria(row.resolution_criteria),
  };
}
