/**
 * Unit tests for the framework-agnostic watchlist handlers (task 8.1), using an
 * in-memory {@link FakeWatchlistStore} (no Postgres). Cover add/list/delete,
 * duplicate-add idempotency (Req 5.1), user scoping (Req 9.4), and the 404 on
 * unknown/un-owned delete (Req 5.4).
 */

import { describe, it, expect } from "vitest";
import type { GatewayDeps } from "./dto.js";
import {
  handleAddWatchlist,
  handleDeleteWatchlist,
  handleListWatchlist,
} from "./watchlist.handlers.js";
import { NotFoundError } from "./errors.js";
import { FakeWatchlistStore } from "./test-support.js";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TARGET_1 = "11111111-1111-1111-1111-111111111111";
const TARGET_2 = "22222222-2222-2222-2222-222222222222";

function buildDeps(store = new FakeWatchlistStore()): GatewayDeps {
  return {
    // The watchlist handlers only touch deps.watchlist; the other readers are
    // unused here, so minimal stubs suffice.
    discovery: { listMarkets: async () => [], getMarketDetail: async () => null },
    outcomes: { listByMarket: async () => [] },
    prices: { history: async () => [] },
    sources: { list: async () => [] },
    watchlist: store,
  };
}

describe("handleAddWatchlist", () => {
  it("adds a market entry and returns the DTO (no userId on the wire)", async () => {
    const deps = buildDeps();
    const item = await handleAddWatchlist(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
    });
    expect(item.targetType).toBe("market");
    expect(item.targetId).toBe(TARGET_1);
    expect(item.id).toBeTruthy();
    expect(item.createdAt).toBeTruthy();
    expect(item).not.toHaveProperty("userId");
  });

  it("is idempotent: a duplicate add returns the existing item, no duplicate row (Req 5.1)", async () => {
    const store = new FakeWatchlistStore();
    const deps = buildDeps(store);

    const first = await handleAddWatchlist(deps, USER_A, {
      targetType: "canonicalEvent",
      targetId: TARGET_1,
    });
    const second = await handleAddWatchlist(deps, USER_A, {
      targetType: "canonicalEvent",
      targetId: TARGET_1,
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(store.size).toBe(1);
  });

  it("scopes the same target separately per user", async () => {
    const store = new FakeWatchlistStore();
    const deps = buildDeps(store);
    await handleAddWatchlist(deps, USER_A, { targetType: "market", targetId: TARGET_1 });
    await handleAddWatchlist(deps, USER_B, { targetType: "market", targetId: TARGET_1 });
    expect(store.size).toBe(2);
  });
});

describe("handleListWatchlist", () => {
  it("returns only the authenticated user's items (Req 9.4)", async () => {
    const deps = buildDeps();
    await handleAddWatchlist(deps, USER_A, { targetType: "market", targetId: TARGET_1 });
    await handleAddWatchlist(deps, USER_A, { targetType: "market", targetId: TARGET_2 });
    await handleAddWatchlist(deps, USER_B, { targetType: "market", targetId: TARGET_1 });

    const listA = await handleListWatchlist(deps, USER_A);
    expect(listA.items.map((i) => i.targetId).sort()).toEqual([TARGET_1, TARGET_2].sort());

    const listB = await handleListWatchlist(deps, USER_B);
    expect(listB.items).toHaveLength(1);
    expect(listB.items[0]?.targetId).toBe(TARGET_1);
  });

  it("returns an empty list for a user with no items", async () => {
    const deps = buildDeps();
    const list = await handleListWatchlist(deps, USER_A);
    expect(list.items).toEqual([]);
  });
});

describe("handleDeleteWatchlist", () => {
  it("removes the user's own item and stops listing it (Req 5.4)", async () => {
    const deps = buildDeps();
    const item = await handleAddWatchlist(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
    });

    await expect(handleDeleteWatchlist(deps, USER_A, item.id)).resolves.toBeUndefined();
    const list = await handleListWatchlist(deps, USER_A);
    expect(list.items).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown item id", async () => {
    const deps = buildDeps();
    await expect(
      handleDeleteWatchlist(deps, USER_A, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not delete another user's item: throws 404 and leaves it intact (Req 9.4)", async () => {
    const deps = buildDeps();
    const ownersItem = await handleAddWatchlist(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
    });

    await expect(handleDeleteWatchlist(deps, USER_B, ownersItem.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // Owner still sees it.
    const listA = await handleListWatchlist(deps, USER_A);
    expect(listA.items.map((i) => i.id)).toContain(ownersItem.id);
  });
});

describe("handler missing-store guard", () => {
  it("throws a clear error when the watchlist store is not configured", async () => {
    const deps = buildDeps();
    delete deps.watchlist;
    await expect(handleListWatchlist(deps, USER_A)).rejects.toThrow(/watchlist store/i);
  });
});
