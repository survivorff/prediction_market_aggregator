/**
 * Framework-agnostic handlers for the user-scoped watchlist endpoints (task
 * 8.1; design.md "Outbound API Surface" — `GET/POST/DELETE /api/watchlist`).
 *
 * Each takes the injected {@link GatewayDeps}, the authenticated `userId`
 * (resolved by the `requireAuth` preHandler — Requirement 9.4), and
 * already-validated input, then delegates to the {@link WatchlistStore} port
 * (SQL lives in `@pma/storage`). Keeping these free of Fastify makes them
 * unit-testable with an in-memory fake store.
 *
 * Behavior:
 *   - add (POST): idempotent/duplicate-preventing per `(userId, targetType,
 *     targetId)` — re-adding the same target returns the EXISTING item, no
 *     duplicate row (Requirement 5.1).
 *   - list (GET): only the authenticated user's items (Requirement 9.4).
 *   - delete (DELETE): scoped to the owner; an unknown/un-owned item → 404
 *     (Requirements 5.4, 9.4).
 *
 * All user scoping is enforced via the `userId` threaded into every store call,
 * so one user can never read or delete another user's items.
 */

import type { WatchlistItem } from "@pma/core";
import type {
  AddWatchlistItemBody,
  GatewayDeps,
  WatchlistItemDto,
  WatchlistListResponse,
} from "./dto.js";
import { NotFoundError } from "./errors.js";

/** Require the watchlist store, surfacing a clear error when unconfigured. */
function requireWatchlist(deps: GatewayDeps): NonNullable<GatewayDeps["watchlist"]> {
  if (deps.watchlist === undefined) {
    throw new Error("Gateway is missing the watchlist store for watchlist routes");
  }
  return deps.watchlist;
}

/** Map a core {@link WatchlistItem} to its wire DTO (drops the owner `userId`). */
function toDto(item: WatchlistItem): WatchlistItemDto {
  return {
    id: item.id,
    targetType: item.targetType,
    targetId: item.targetId,
    createdAt: item.createdAt,
  };
}

/**
 * `GET /api/watchlist` — list the authenticated user's watchlist entries
 * (Requirement 9.4: user-scoped). Returns only `userId`'s items, newest first.
 */
export async function handleListWatchlist(
  deps: GatewayDeps,
  userId: string,
): Promise<WatchlistListResponse> {
  const store = requireWatchlist(deps);
  const items = await store.listByUser(userId);
  return { items: items.map(toDto) };
}

/**
 * `POST /api/watchlist` — add a market/canonical event to the authenticated
 * user's watchlist and persist it (Requirement 5.1). Idempotent: a duplicate
 * add for the same `(userId, targetType, targetId)` returns the existing item
 * with no duplicate row created. The route returns 200 for this consistently
 * (see `server.ts`).
 */
export async function handleAddWatchlist(
  deps: GatewayDeps,
  userId: string,
  body: AddWatchlistItemBody,
): Promise<WatchlistItemDto> {
  const store = requireWatchlist(deps);
  const item = await store.add({
    userId,
    targetType: body.targetType,
    targetId: body.targetId,
  });
  return toDto(item);
}

/**
 * `DELETE /api/watchlist/{itemId}` — remove the authenticated user's watchlist
 * entry and stop evaluating it (Requirement 5.4). Scoped to the owner: deleting
 * an unknown id OR another user's item removes nothing and throws
 * {@link NotFoundError} (404), so users cannot probe or delete others' items
 * (Requirement 9.4).
 */
export async function handleDeleteWatchlist(
  deps: GatewayDeps,
  userId: string,
  itemId: string,
): Promise<void> {
  const store = requireWatchlist(deps);
  const removed = await store.delete(userId, itemId);
  if (!removed) {
    throw new NotFoundError(`Watchlist item "${itemId}" not found`);
  }
}
