/**
 * {@link WatchlistRepository} — user-scoped persistence for watchlist entries
 * (design.md "Component 6: Alert / Watchlist Service" + the `watchlist_item`
 * table). SQL lives here in `@pma/storage`; the alerts service / API gateway
 * depend on the `@pma/core` {@link IWatchlistRepository} port.
 *
 * Duplicate prevention (Requirement 5.1): `add` upserts with
 * `ON CONFLICT (user_id, target_type, target_id) DO NOTHING`. On conflict no
 * row is returned by `RETURNING`, so the existing row is read back — the result
 * is idempotent (re-adding the same target yields the same entry, never a
 * duplicate row).
 *
 * User scoping (Requirements 5.4, 9.4): every read/delete is filtered by
 * `user_id`, so a user can only ever see or remove their OWN items; another
 * user's `itemId` resolves to `null` / `false` (→ 404 at the gateway), never a
 * cross-user read or delete.
 */

import type {
  WatchlistItem,
  WatchlistItemInput,
  WatchlistRepository as IWatchlistRepository,
} from "@pma/core";
import { isWatchlistTargetType } from "@pma/core";
import type { Queryable } from "../client.js";
import { mapWatchlistItemRow, type WatchlistItemRow } from "../mappers.js";

const WATCHLIST_COLUMNS = `id, user_id, target_type, target_id, created_at`;

export class WatchlistRepository implements IWatchlistRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Add a target to a user's watchlist idempotently (Requirement 5.1). Uses
   * `ON CONFLICT (user_id, target_type, target_id) DO NOTHING`; when the row
   * already exists the insert returns no row, so the existing entry is read
   * back and returned (no duplicate is created). `targetType` is validated
   * against the `('market','canonicalEvent')` domain before touching the DB so
   * a bad value surfaces a clear error rather than a CHECK-constraint failure.
   */
  async add(input: WatchlistItemInput): Promise<WatchlistItem> {
    if (!isWatchlistTargetType(input.targetType)) {
      throw new Error(
        `Invalid watchlist targetType "${String(input.targetType)}"; expected "market" or "canonicalEvent"`,
      );
    }

    const inserted = await this.db.query<WatchlistItemRow>(
      `INSERT INTO watchlist_item (user_id, target_type, target_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, target_type, target_id) DO NOTHING
       RETURNING ${WATCHLIST_COLUMNS}`,
      [input.userId, input.targetType, input.targetId],
    );
    const row = inserted.rows[0];
    if (row) return mapWatchlistItemRow(row);

    // Conflict: the entry already exists — read it back so the call is
    // idempotent and returns the existing item (Requirement 5.1).
    const existing = await this.db.query<WatchlistItemRow>(
      `SELECT ${WATCHLIST_COLUMNS} FROM watchlist_item
       WHERE user_id = $1 AND target_type = $2 AND target_id = $3`,
      [input.userId, input.targetType, input.targetId],
    );
    const existingRow = existing.rows[0];
    if (!existingRow) {
      // Unreachable: a conflict implies the row exists.
      throw new Error(
        `add: watchlist_item missing after conflict for (${input.userId}, ${input.targetType}, ${input.targetId})`,
      );
    }
    return mapWatchlistItemRow(existingRow);
  }

  /** List a user's watchlist entries, newest first (Requirement 9.4). */
  async listByUser(userId: string): Promise<WatchlistItem[]> {
    const result = await this.db.query<WatchlistItemRow>(
      `SELECT ${WATCHLIST_COLUMNS} FROM watchlist_item
       WHERE user_id = $1
       ORDER BY created_at DESC, id ASC`,
      [userId],
    );
    return result.rows.map(mapWatchlistItemRow);
  }

  /**
   * Fetch a single watchlist entry by id, scoped to its owner. Returns `null`
   * when the id does not exist OR belongs to another user (Requirements 5.4,
   * 9.4) — callers cannot probe other users' items.
   */
  async getById(userId: string, itemId: string): Promise<WatchlistItem | null> {
    const result = await this.db.query<WatchlistItemRow>(
      `SELECT ${WATCHLIST_COLUMNS} FROM watchlist_item
       WHERE id = $1 AND user_id = $2`,
      [itemId, userId],
    );
    const row = result.rows[0];
    return row ? mapWatchlistItemRow(row) : null;
  }

  /**
   * Delete a user's watchlist entry by id, scoped to its owner. Returns `true`
   * when a row was removed, `false` when no matching `(id, user_id)` row exists
   * (unknown id OR owned by another user → 404 at the gateway). Once removed,
   * the system no longer evaluates it (Requirement 5.4).
   */
  async delete(userId: string, itemId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM watchlist_item WHERE id = $1 AND user_id = $2`,
      [itemId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
