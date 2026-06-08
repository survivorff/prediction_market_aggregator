/**
 * Watchlist domain types (design.md "Component 6: Alert / Watchlist Service" +
 * the `watchlist_item` table). A {@link WatchlistItem} is a user-scoped pointer
 * to a tracked target — either a normalized `market` or a cross-platform
 * `canonicalEvent`. Duplicate entries for the same `(userId, targetType,
 * targetId)` are prevented at the storage layer (Requirement 5.1).
 *
 * Pure types only (no I/O), consistent with the rest of `@pma/core`.
 */

/**
 * What a watchlist entry points at: a single normalized `market`, or a
 * cross-platform `canonicalEvent` grouping. Mirrors the `watchlist_item`
 * `target_type` CHECK constraint (design.md "Storage Schemas").
 */
export type WatchlistTargetType = "market" | "canonicalEvent";

/** All valid {@link WatchlistTargetType} values (for validation/iteration). */
export const WATCHLIST_TARGET_TYPES: readonly WatchlistTargetType[] = ["market", "canonicalEvent"];

/** Type guard: is `value` a valid {@link WatchlistTargetType}? */
export function isWatchlistTargetType(value: unknown): value is WatchlistTargetType {
  return value === "market" || value === "canonicalEvent";
}

/**
 * A user-scoped watchlist entry. `userId` identifies the owner (an
 * authenticated user — Requirement 9.4); `targetType` + `targetId` identify the
 * tracked market or canonical event. The pair-with-user
 * `(userId, targetType, targetId)` is unique (Requirement 5.1).
 */
export interface WatchlistItem {
  /** Internal UUID assigned by the persistence layer. */
  id: string;
  /** Owning user's id (the authenticated identity). */
  userId: string;
  /** Whether the target is a `market` or a `canonicalEvent`. */
  targetType: WatchlistTargetType;
  /** The tracked target's internal UUID. */
  targetId: string;
  /** When the entry was created (ISO 8601). */
  createdAt: string;
}
