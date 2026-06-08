/**
 * {@link CursorRepository} — keyset pagination cursor persistence.
 *
 * Backed by the `sync_cursor` table (PK `(source_id, entity)`). Cursors enable
 * crash-safe, incremental metadata sync: the ingestion orchestrator persists a
 * cursor only after its page is durably written, so cursors never regress
 * across successful syncs (Requirement 7.3, design.md `syncMarkets`).
 */

import type { CursorRepository as ICursorRepository, CursorEntity } from "@pma/core";
import type { Queryable } from "../client.js";

interface CursorRow {
  cursor: string | null;
}

/**
 * Load the persisted cursor for a `(sourceId, entity)` stream. Returns `null`
 * when no cursor row exists (start of stream) or the stored cursor is SQL NULL.
 * Shared by {@link CursorRepository} and the market-scoped cursor methods on
 * the market repository.
 */
export async function loadCursorRow(
  db: Queryable,
  sourceId: string,
  entity: CursorEntity,
): Promise<string | null> {
  const result = await db.query<CursorRow>(
    `SELECT cursor FROM sync_cursor WHERE source_id = $1 AND entity = $2`,
    [sourceId, entity],
  );
  const row = result.rows[0];
  return row ? row.cursor : null;
}

/**
 * Persist the cursor for a `(sourceId, entity)` stream. Upserts on the
 * `(source_id, entity)` primary key so repeated saves update in place; passing
 * `null` resets the stream to its start.
 */
export async function saveCursorRow(
  db: Queryable,
  sourceId: string,
  entity: CursorEntity,
  cursor: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO sync_cursor (source_id, entity, cursor, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (source_id, entity)
     DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [sourceId, entity, cursor],
  );
}

/**
 * Concrete {@link ICursorRepository} over a Postgres {@link Queryable}.
 */
export class CursorRepository implements ICursorRepository {
  constructor(private readonly db: Queryable) {}

  loadCursor(sourceId: string, entity: CursorEntity): Promise<string | null> {
    return loadCursorRow(this.db, sourceId, entity);
  }

  saveCursor(sourceId: string, entity: CursorEntity, cursor: string | null): Promise<void> {
    return saveCursorRow(this.db, sourceId, entity, cursor);
  }
}
