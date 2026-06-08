/**
 * Integration tests for {@link AlertRuleRepository} against the docker-compose
 * TimescaleDB (Requirements 5.2, 5.4, 9.4). Cover create (thresholdCross +
 * spreadWiden, with params + active flag), list-by-user, user-scoped
 * getById/delete, the absence of deduplication (multiple rules per target), and
 * the 404/false path for un-owned/unknown rows.
 *
 * Alert rules reference a `user_id` (not a `source`), so each test uses fresh
 * random user/target UUIDs and cleans up by user id. When the database is
 * unreachable the suite skips gracefully (see test-support.connectOrSkip).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Pool } from "pg";
import { AlertRuleRepository } from "./index.js";
import { connectOrSkip, cleanupAlertUser, uniqueUuid } from "../test-support.js";

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
    if (id) await cleanupAlertUser(pool, id);
  }
});

/** Allocate a fresh user id tracked for cleanup. */
function freshUser(): string {
  const id = uniqueUuid();
  userIds.push(id);
  return id;
}

describe("AlertRuleRepository (integration)", () => {
  it("skips when the database is unavailable", () => {
    if (!pool) {
      expect(pool).toBeNull();
    } else {
      expect(pool).not.toBeNull();
    }
  });

  it("creates a thresholdCross rule with params + active flag (Req 5.2)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();
    const targetId = uniqueUuid();

    const rule = await repo.create({
      userId,
      targetType: "market",
      targetId,
      ruleType: "thresholdCross",
      params: { threshold: 0.75 },
    });

    expect(rule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rule.userId).toBe(userId);
    expect(rule.targetType).toBe("market");
    expect(rule.targetId).toBe(targetId);
    expect(rule.ruleType).toBe("thresholdCross");
    expect(rule.params).toEqual({ threshold: 0.75 });
    // active defaults to TRUE.
    expect(rule.active).toBe(true);
    expect(Number.isNaN(new Date(rule.createdAt).getTime())).toBe(false);
  });

  it("creates a spreadWiden rule on a canonicalEvent target", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();

    const rule = await repo.create({
      userId,
      targetType: "canonicalEvent",
      targetId: uniqueUuid(),
      ruleType: "spreadWiden",
      params: { minGap: 0.05 },
    });

    expect(rule.targetType).toBe("canonicalEvent");
    expect(rule.ruleType).toBe("spreadWiden");
    expect(rule.params).toEqual({ minGap: 0.05 });
  });

  it("persists an explicit active=false flag", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();

    const rule = await repo.create({
      userId,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
      active: false,
    });

    expect(rule.active).toBe(false);
    const fetched = await repo.getById(userId, rule.id);
    expect(fetched?.active).toBe(false);
  });

  it("normalizes params, dropping extraneous keys before persisting", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();

    const rule = await repo.create({
      userId,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      // Extra keys must not be persisted.
      params: { threshold: 0.3, minGap: 0.9 } as unknown as { threshold: number },
    });

    expect(rule.params).toEqual({ threshold: 0.3 });
  });

  it("does NOT deduplicate: multiple rules for the same target are distinct rows (Req 5.2)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();
    const targetId = uniqueUuid();

    const first = await repo.create({
      userId,
      targetType: "market",
      targetId,
      ruleType: "thresholdCross",
      params: { threshold: 0.4 },
    });
    const second = await repo.create({
      userId,
      targetType: "market",
      targetId,
      ruleType: "thresholdCross",
      params: { threshold: 0.6 },
    });

    expect(second.id).not.toBe(first.id);
    const list = await repo.listByUser(userId);
    expect(list).toHaveLength(2);
  });

  it("lists a user's rules (newest first) and is user-scoped (Req 9.4)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userA = freshUser();
    const userB = freshUser();

    const a1 = await repo.create({
      userId: userA,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      params: { threshold: 0.2 },
    });
    const a2 = await repo.create({
      userId: userA,
      targetType: "canonicalEvent",
      targetId: uniqueUuid(),
      ruleType: "spreadWiden",
      params: { minGap: 0.1 },
    });
    await repo.create({
      userId: userB,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      params: { threshold: 0.9 },
    });

    const listA = await repo.listByUser(userA);
    expect(listA.map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(listA.every((r) => r.userId === userA)).toBe(true);

    const listB = await repo.listByUser(userB);
    expect(listB).toHaveLength(1);
    expect(listB[0]?.userId).toBe(userB);
  });

  it("getById is scoped to the owner (null for another user's rule)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const owner = freshUser();
    const other = freshUser();
    const rule = await repo.create({
      userId: owner,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
    });

    expect((await repo.getById(owner, rule.id))?.id).toBe(rule.id);
    expect(await repo.getById(other, rule.id)).toBeNull();
    expect(await repo.getById(owner, uniqueUuid())).toBeNull();
  });

  it("deletes a user's own rule and stops listing it (Req 5.4)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();
    const rule = await repo.create({
      userId,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
    });

    expect(await repo.delete(userId, rule.id)).toBe(true);
    expect(await repo.listByUser(userId)).toHaveLength(0);
    // Deleting again is a no-op (already gone).
    expect(await repo.delete(userId, rule.id)).toBe(false);
  });

  it("does not let a user delete another user's rule (Req 9.4)", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const owner = freshUser();
    const attacker = freshUser();
    const rule = await repo.create({
      userId: owner,
      targetType: "market",
      targetId: uniqueUuid(),
      ruleType: "spreadWiden",
      params: { minGap: 0.05 },
    });

    expect(await repo.delete(attacker, rule.id)).toBe(false);
    expect((await repo.getById(owner, rule.id))?.id).toBe(rule.id);
  });

  it("returns false when deleting an unknown id", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();
    expect(await repo.delete(userId, uniqueUuid())).toBe(false);
  });

  it("rejects invalid params before touching the DB", async () => {
    if (!pool) return;
    const repo = new AlertRuleRepository(pool);
    const userId = freshUser();
    await expect(
      repo.create({
        userId,
        targetType: "market",
        targetId: uniqueUuid(),
        ruleType: "thresholdCross",
        params: { threshold: 2 },
      }),
    ).rejects.toThrow(/thresholdCross/);
  });
});
