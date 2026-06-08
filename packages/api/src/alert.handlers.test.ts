/**
 * Unit tests for the framework-agnostic alert handlers (task 8.2), using an
 * in-memory {@link FakeAlertStore} (no Postgres). Cover create/list/delete, the
 * absence of deduplication (multiple rules per target — Req 5.2), user scoping
 * (Req 9.4), and the 404 on unknown/un-owned delete (Req 5.4).
 */

import { describe, it, expect } from "vitest";
import type { GatewayDeps } from "./dto.js";
import { handleCreateAlert, handleDeleteAlert, handleListAlerts } from "./alert.handlers.js";
import { NotFoundError } from "./errors.js";
import { FakeAlertStore } from "./test-support.js";

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TARGET_1 = "11111111-1111-1111-1111-111111111111";
const TARGET_2 = "22222222-2222-2222-2222-222222222222";

function buildDeps(store = new FakeAlertStore()): GatewayDeps {
  return {
    // The alert handlers only touch deps.alerts; the other readers are unused
    // here, so minimal stubs suffice.
    discovery: { listMarkets: async () => [], getMarketDetail: async () => null },
    outcomes: { listByMarket: async () => [] },
    prices: { history: async () => [] },
    sources: { list: async () => [] },
    alerts: store,
  };
}

describe("handleCreateAlert", () => {
  it("creates a thresholdCross rule and returns the DTO (no userId on the wire, active defaults true)", async () => {
    const deps = buildDeps();
    const rule = await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.6 },
    });
    expect(rule.targetType).toBe("market");
    expect(rule.targetId).toBe(TARGET_1);
    expect(rule.ruleType).toBe("thresholdCross");
    expect(rule.params).toEqual({ threshold: 0.6 });
    expect(rule.active).toBe(true);
    expect(rule.id).toBeTruthy();
    expect(rule.createdAt).toBeTruthy();
    expect(rule).not.toHaveProperty("userId");
  });

  it("creates a spreadWiden rule on a canonicalEvent target", async () => {
    const deps = buildDeps();
    const rule = await handleCreateAlert(deps, USER_A, {
      targetType: "canonicalEvent",
      targetId: TARGET_1,
      ruleType: "spreadWiden",
      params: { minGap: 0.05 },
    });
    expect(rule.ruleType).toBe("spreadWiden");
    expect(rule.params).toEqual({ minGap: 0.05 });
  });

  it("does NOT deduplicate: multiple rules for the same target are distinct (Req 5.2)", async () => {
    const store = new FakeAlertStore();
    const deps = buildDeps(store);

    const first = await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.4 },
    });
    const second = await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.6 },
    });

    expect(second.id).not.toBe(first.id);
    expect(store.size).toBe(2);
  });
});

describe("handleListAlerts", () => {
  it("returns only the authenticated user's rules (Req 9.4)", async () => {
    const deps = buildDeps();
    await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
    });
    await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_2,
      ruleType: "thresholdCross",
      params: { threshold: 0.7 },
    });
    await handleCreateAlert(deps, USER_B, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "spreadWiden",
      params: { minGap: 0.1 },
    });

    const listA = await handleListAlerts(deps, USER_A);
    expect(listA.alerts.map((a) => a.targetId).sort()).toEqual([TARGET_1, TARGET_2].sort());

    const listB = await handleListAlerts(deps, USER_B);
    expect(listB.alerts).toHaveLength(1);
    expect(listB.alerts[0]?.ruleType).toBe("spreadWiden");
  });

  it("returns an empty list for a user with no rules", async () => {
    const deps = buildDeps();
    const list = await handleListAlerts(deps, USER_A);
    expect(list.alerts).toEqual([]);
  });
});

describe("handleDeleteAlert", () => {
  it("removes the user's own rule and stops listing it (Req 5.4)", async () => {
    const deps = buildDeps();
    const rule = await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
    });

    await expect(handleDeleteAlert(deps, USER_A, rule.id)).resolves.toBeUndefined();
    const list = await handleListAlerts(deps, USER_A);
    expect(list.alerts).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown rule id", async () => {
    const deps = buildDeps();
    await expect(
      handleDeleteAlert(deps, USER_A, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("does not delete another user's rule: throws 404 and leaves it intact (Req 9.4)", async () => {
    const deps = buildDeps();
    const ownersRule = await handleCreateAlert(deps, USER_A, {
      targetType: "market",
      targetId: TARGET_1,
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
    });

    await expect(handleDeleteAlert(deps, USER_B, ownersRule.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const listA = await handleListAlerts(deps, USER_A);
    expect(listA.alerts.map((a) => a.id)).toContain(ownersRule.id);
  });
});

describe("handler missing-store guard", () => {
  it("throws a clear error when the alert store is not configured", async () => {
    const deps = buildDeps();
    delete deps.alerts;
    await expect(handleListAlerts(deps, USER_A)).rejects.toThrow(/alert store/i);
  });
});
