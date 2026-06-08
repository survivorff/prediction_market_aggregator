/**
 * Integration tests for {@link WatchlistRepository} against the docker-compose
 * TimescaleDB (Requirements 5.1, 5.4, 9.4). Cover add/list/delete, duplicate
 * prevention (a re-add yields one row + the existing item), and user-scoped
 * isolation (a user cannot read or delete another user's items).
 *
 * Watchlist items reference a `user_id` (not a `source`), so each test uses
 * fresh random user/target UUIDs and cleans up by user id. When the database is
 * unreachable the suite skips gracefully (see test-support.connectOrSkip).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Pool } from "pg";
import { WatchlistRepository } from "./index.js";
import { connectOrSkip, cleanupWatchlistUser, uniqueUuid } from "../test-support.js";

let pool: Pool | null = null;

beforeAll(async () => {
  pool = await connectOrSkip();
});

afterAll(async () => {
  if (pool) await pool.end();
});

const userIds: string[] = [];

afterEach(async () => {
  if (!pool) return;
  while (userIds.length > 0) {
    const id = userIds.pop();
    if (id) await cleanupWatchlistUser(pool, id);
  }
});

/** Allocate a fresh user id tracked for cleanup. */
function freshUser(): string {
  const id = uniqueUuid();
  userIds.push(id);
  return id;
}

describe("WatchlistRepository (integration)", () => {
  it("skips when the database is unavailable", () => {
    if (!pool) {
      expect(pool).toBeNull();
    } else {
      expect(pool).not.toBeNull();
    }
  });

  it("adds a market entry and resolves an internal id + createdAt", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    const targetId = uniqueUuid();

    const item = await repo.add({ userId, targetType: "market", targetId });

    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.userId).toBe(userId);
    expect(item.targetType).toBe("market");
    expect(item.targetId).toBe(targetId);
    expect(Number.isNaN(new Date(item.createdAt).getTime())).toBe(false);
  });

  it("supports the canonicalEvent target type", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    const item = await repo.add({
      userId,
      targetType: "canonicalEvent",
      targetId: uniqueUuid(),
    });
    expect(item.targetType).toBe("canonicalEvent");
  });

  it("prevents duplicates per (user, target_type, target_id): one row, same item (Req 5.1)", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    const targetId = uniqueUuid();
    const input = { userId, targetType: "market" as const, targetId };

    const first = await repo.add(input);
    const second = await repo.add(input);
    const third = await repo.add(input);

    // Idempotent: same id returned each time.
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);

    // Exactly one row persisted for the target.
    const count = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM watchlist_item
       WHERE user_id = $1 AND target_type = $2 AND target_id = $3`,
      [userId, "market", targetId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("treats the same target_id under a different target_type as distinct", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    const targetId = uniqueUuid();

    const asMarket = await repo.add({ userId, targetType: "market", targetId });
    const asCanonical = await repo.add({ userId, targetType: "canonicalEvent", targetId });

    expect(asMarket.id).not.toBe(asCanonical.id);
    const items = await repo.listByUser(userId);
    expect(items).toHaveLength(2);
  });

  it("lists a user's entries (newest first) and is user-scoped (Req 9.4)", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userA = freshUser();
    const userB = freshUser();

    const a1 = await repo.add({ userId: userA, targetType: "market", targetId: uniqueUuid() });
    const a2 = await repo.add({
      userId: userA,
      targetType: "canonicalEvent",
      targetId: uniqueUuid(),
    });
    await repo.add({ userId: userB, targetType: "market", targetId: uniqueUuid() });

    const listA = await repo.listByUser(userA);
    expect(listA.map((i) => i.id).sort()).toEqual([a1.id, a2.id].sort());
    // User B's item is never visible to user A.
    expect(listA.every((i) => i.userId === userA)).toBe(true);

    const listB = await repo.listByUser(userB);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.userId).toBe(userB);
  });

  it("getById is scoped to the owner (null for another user's item)", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const owner = freshUser();
    const other = freshUser();
    const item = await repo.add({ userId: owner, targetType: "market", targetId: uniqueUuid() });

    expect((await repo.getById(owner, item.id))?.id).toBe(item.id);
    // Another user cannot read it.
    expect(await repo.getById(other, item.id)).toBeNull();
    // Unknown id.
    expect(await repo.getById(owner, uniqueUuid())).toBeNull();
  });

  it("deletes a user's own item and stops listing it (Req 5.4)", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    const item = await repo.add({ userId, targetType: "market", targetId: uniqueUuid() });

    expect(await repo.delete(userId, item.id)).toBe(true);
    expect(await repo.listByUser(userId)).toHaveLength(0);
    // Deleting again is a no-op (already gone).
    expect(await repo.delete(userId, item.id)).toBe(false);
  });

  it("does not let a user delete another user's item (Req 9.4)", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const owner = freshUser();
    const attacker = freshUser();
    const item = await repo.add({ userId: owner, targetType: "market", targetId: uniqueUuid() });

    // Attacker's delete affects no row.
    expect(await repo.delete(attacker, item.id)).toBe(false);
    // The owner's item is still present.
    expect((await repo.getById(owner, item.id))?.id).toBe(item.id);
  });

  it("returns false when deleting an unknown id", async () => {
    if (!pool) return;
    const repo = new WatchlistRepository(pool);
    const userId = freshUser();
    expect(await repo.delete(userId, uniqueUuid())).toBe(false);
  });
});
