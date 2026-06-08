/**
 * {@link MarketRepository} — idempotent persistence for normalized markets.
 *
 * `upsertMarket` is idempotent on `(source_id, external_id)`: re-running with
 * the same upstream state produces no duplicate rows and no net change
 * (Requirements 7.1, 10.1 / Property 1). The `DO UPDATE` is content-guarded
 * with `IS DISTINCT FROM`, so `updated_at` only advances when a column actually
 * changes — repeated identical syncs leave the row byte-for-byte unchanged.
 *
 * Also exposes the market-scoped keyset cursor (`sync_cursor` `entity='market'`)
 * used by `syncMarkets` (design.md), and lookups by idempotency key / internal
 * id.
 *
 * Note on `category`: the `market` table denormalizes `category` for fast
 * discovery filtering, but the normalized domain `Market` (and therefore
 * `MarketUpsert = Omit<Market,"id">`) carries no category — categories live on
 * `event`/`canonical_event` and are projected by a higher layer. New rows are
 * inserted with `'other'` and the column is preserved (never clobbered) on
 * conflict so denormalization set elsewhere survives idempotent re-syncs.
 */

import type { Market, MarketRepository as IMarketRepository, MarketUpsert } from "@pma/core";
import type { Queryable } from "../client.js";
import { mapMarketRow, serializeResolutionCriteria, type MarketRow } from "../mappers.js";
import { loadCursorRow, saveCursorRow } from "./cursor-repository.js";

const MARKET_COLUMNS = `id, source_id, event_id, canonical_event_id, external_id,
  question, category, status, volume_24h, liquidity, spread,
  resolution_criteria, resolution_mismatch, updated_at`;

export class MarketRepository implements IMarketRepository {
  constructor(private readonly db: Queryable) {}

  /** Load the market-sync keyset cursor for a source; `null` = start. */
  loadCursor(sourceId: string): Promise<string | null> {
    return loadCursorRow(this.db, sourceId, "market");
  }

  /** Persist the market-sync cursor, only after the page is durably written. */
  saveCursor(sourceId: string, cursor: string | null): Promise<void> {
    return saveCursorRow(this.db, sourceId, "market", cursor);
  }

  /**
   * Idempotent upsert keyed on `(source_id, external_id)`. Content columns are
   * updated only when they differ from the stored row (`IS DISTINCT FROM`
   * guard), keeping repeated syncs a no-op. `category` is intentionally not in
   * the update set (see file header).
   */
  async upsertMarket(market: MarketUpsert): Promise<Market> {
    const params = [
      market.sourceId,
      market.eventId,
      market.canonicalEventId,
      market.externalId,
      market.question,
      market.status,
      market.volume24h,
      market.liquidity,
      market.spread,
      serializeResolutionCriteria(market.resolutionCriteria),
    ];

    const result = await this.db.query<MarketRow>(
      `INSERT INTO market (
         source_id, event_id, canonical_event_id, external_id, question,
         category, status, volume_24h, liquidity, spread, resolution_criteria
       )
       VALUES ($1, $2, $3, $4, $5, 'other', $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (source_id, external_id) DO UPDATE SET
         event_id = EXCLUDED.event_id,
         canonical_event_id = EXCLUDED.canonical_event_id,
         question = EXCLUDED.question,
         status = EXCLUDED.status,
         volume_24h = EXCLUDED.volume_24h,
         liquidity = EXCLUDED.liquidity,
         spread = EXCLUDED.spread,
         resolution_criteria = EXCLUDED.resolution_criteria,
         updated_at = now()
       WHERE market.event_id IS DISTINCT FROM EXCLUDED.event_id
          OR market.canonical_event_id IS DISTINCT FROM EXCLUDED.canonical_event_id
          OR market.question IS DISTINCT FROM EXCLUDED.question
          OR market.status IS DISTINCT FROM EXCLUDED.status
          OR market.volume_24h IS DISTINCT FROM EXCLUDED.volume_24h
          OR market.liquidity IS DISTINCT FROM EXCLUDED.liquidity
          OR market.spread IS DISTINCT FROM EXCLUDED.spread
          OR market.resolution_criteria IS DISTINCT FROM EXCLUDED.resolution_criteria
       RETURNING ${MARKET_COLUMNS}`,
      params,
    );

    const row = result.rows[0];
    if (row) return mapMarketRow(row);

    // Conflict with no content change: the guarded DO UPDATE fired no row, so
    // read the existing (unchanged) row to return it.
    const existing = await this.findByExternalId(market.sourceId, market.externalId);
    if (!existing) {
      // Should be unreachable: a conflict implies the row exists.
      throw new Error(
        `upsertMarket: row missing after conflict for (${market.sourceId}, ${market.externalId})`,
      );
    }
    return existing;
  }

  /** Resolve a market by its idempotency key; `null` when not present. */
  async findByExternalId(sourceId: string, externalId: string): Promise<Market | null> {
    const result = await this.db.query<MarketRow>(
      `SELECT ${MARKET_COLUMNS} FROM market
       WHERE source_id = $1 AND external_id = $2`,
      [sourceId, externalId],
    );
    const row = result.rows[0];
    return row ? mapMarketRow(row) : null;
  }

  /** Fetch a market by internal id; `null` when not present. */
  async getById(id: string): Promise<Market | null> {
    const result = await this.db.query<MarketRow>(
      `SELECT ${MARKET_COLUMNS} FROM market WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapMarketRow(row) : null;
  }
}
