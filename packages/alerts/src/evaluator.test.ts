/**
 * Unit tests for the alert engine ({@link AlertEvaluator}) with in-memory fakes
 * (a fake rules source + a fake publisher) — no Redis required. Covers the
 * crossing/widening semantics, active-only evaluation, payload addressing, and
 * the multiple-rules / no-rules cases (Requirements 5.3, 9.2).
 */

import { describe, it, expect } from "vitest";
import type { AlertRule, AlertRuleParams, WatchlistTargetType } from "@pma/core";
import { AlertEvaluator, detectThresholdCross, detectSpreadWiden } from "./evaluator.js";
import type { AlertPublisher, AlertRulesSource } from "./ports.js";
import type { AlertNotification } from "./notification.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Records every payload passed to `publishAlert`, in order. */
class FakeAlertPublisher implements AlertPublisher {
  readonly published: AlertNotification[] = [];

  publishAlert<T>(payload: T): Promise<number> {
    this.published.push(payload as unknown as AlertNotification);
    return Promise.resolve(1);
  }
}

/**
 * Serves a fixed set of rules keyed by `(targetType, targetId)`. Returns
 * exactly what it is given so a test can prove the evaluator's own `active`
 * filter (it does not pre-filter here unless a test asks it to).
 */
class FakeRulesSource implements AlertRulesSource {
  readonly calls: Array<{ targetType: WatchlistTargetType; targetId: string }> = [];
  private readonly byKey = new Map<string, AlertRule[]>();

  set(targetType: WatchlistTargetType, targetId: string, rules: AlertRule[]): void {
    this.byKey.set(`${targetType}:${targetId}`, rules);
  }

  findActiveRules(targetType: WatchlistTargetType, targetId: string): AlertRule[] {
    this.calls.push({ targetType, targetId });
    return this.byKey.get(`${targetType}:${targetId}`) ?? [];
  }
}

let ruleSeq = 0;

/** Build an alert rule with sensible defaults (active, freshly-numbered id/user). */
function makeRule(overrides: Partial<AlertRule> & { params: AlertRuleParams }): AlertRule {
  ruleSeq += 1;
  return {
    id: overrides.id ?? `rule-${ruleSeq}`,
    userId: overrides.userId ?? `user-${ruleSeq}`,
    targetType: overrides.targetType ?? "market",
    targetId: overrides.targetId ?? "market-1",
    ruleType: overrides.ruleType ?? "thresholdCross",
    params: overrides.params,
    active: overrides.active ?? true,
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
  };
}

function setup(): {
  evaluator: AlertEvaluator;
  rules: FakeRulesSource;
  publisher: FakeAlertPublisher;
} {
  const rules = new FakeRulesSource();
  const publisher = new FakeAlertPublisher();
  const evaluator = new AlertEvaluator({ rulesSource: rules, publisher });
  return { evaluator, rules, publisher };
}

// ---------------------------------------------------------------------------
// Pure crossing/widening predicates
// ---------------------------------------------------------------------------

describe("detectThresholdCross", () => {
  it("detects an up-cross (prev below, next at/above)", () => {
    expect(detectThresholdCross(0.4, 0.6, 0.5)).toBe("up");
    expect(detectThresholdCross(0.4, 0.5, 0.5)).toBe("up"); // next === threshold counts
  });

  it("detects a down-cross (prev above, next at/below)", () => {
    expect(detectThresholdCross(0.6, 0.4, 0.5)).toBe("down");
    expect(detectThresholdCross(0.6, 0.5, 0.5)).toBe("down"); // next === threshold counts
  });

  it("returns null when both values stay on the same side", () => {
    expect(detectThresholdCross(0.6, 0.7, 0.5)).toBeNull(); // both above
    expect(detectThresholdCross(0.3, 0.4, 0.5)).toBeNull(); // both below
  });

  it("returns null when starting exactly on the boundary (no side to cross from)", () => {
    expect(detectThresholdCross(0.5, 0.6, 0.5)).toBeNull();
    expect(detectThresholdCross(0.5, 0.4, 0.5)).toBeNull();
    expect(detectThresholdCross(0.5, 0.5, 0.5)).toBeNull();
  });
});

describe("detectSpreadWiden", () => {
  it("fires when the gap widens past minGap", () => {
    expect(detectSpreadWiden(0.04, 0.07, 0.05)).toBe(true);
    expect(detectSpreadWiden(0.05, 0.06, 0.05)).toBe(true); // prev === minGap, new strictly above
  });

  it("does not fire while the gap stays wide (prev already above)", () => {
    expect(detectSpreadWiden(0.07, 0.09, 0.05)).toBe(false);
  });

  it("does not fire when the gap stays at/below minGap", () => {
    expect(detectSpreadWiden(0.02, 0.05, 0.05)).toBe(false); // new === minGap is not "beyond"
    expect(detectSpreadWiden(0.02, 0.03, 0.05)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// thresholdCross evaluation
// ---------------------------------------------------------------------------

describe("AlertEvaluator.evaluatePriceUpdate (thresholdCross)", () => {
  it("fires on an up-cross and dispatches a user-addressed notification with details", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "market-1", [
      makeRule({
        id: "r1",
        userId: "alice",
        targetType: "market",
        targetId: "market-1",
        ruleType: "thresholdCross",
        params: { threshold: 0.5 },
      }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("market-1", 0.4, 0.6);

    expect(fired).toHaveLength(1);
    expect(publisher.published).toEqual([
      {
        alertId: "r1",
        userId: "alice",
        ruleType: "thresholdCross",
        targetType: "market",
        targetId: "market-1",
        details: {
          kind: "thresholdCross",
          threshold: 0.5,
          previous: 0.4,
          current: 0.6,
          direction: "up",
        },
      },
    ]);
    expect(rules.calls).toEqual([{ targetType: "market", targetId: "market-1" }]);
  });

  it("fires on a down-cross with direction 'down'", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({ targetId: "m", ruleType: "thresholdCross", params: { threshold: 0.5 } }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", 0.7, 0.3);

    expect(fired).toHaveLength(1);
    expect(publisher.published[0]?.details).toMatchObject({
      kind: "thresholdCross",
      direction: "down",
      previous: 0.7,
      current: 0.3,
    });
  });

  it("does NOT fire when the probability stays on one side of the threshold", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({ targetId: "m", ruleType: "thresholdCross", params: { threshold: 0.5 } }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", 0.6, 0.7); // both above

    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });

  it("does NOT fire when there is no previous value (first observation)", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({ targetId: "m", ruleType: "thresholdCross", params: { threshold: 0.5 } }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", null, 0.9);

    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
    // With no prior value we don't even need to query rules.
    expect(rules.calls).toHaveLength(0);
  });

  it("ignores inactive rules (active flag from task 8.2)", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({
        id: "inactive",
        targetId: "m",
        ruleType: "thresholdCross",
        params: { threshold: 0.5 },
        active: false,
      }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", 0.4, 0.6);

    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });

  it("ignores spreadWiden rules on a price update", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({ targetId: "m", ruleType: "spreadWiden", params: { minGap: 0.1 } }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", 0.0, 1.0);

    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });

  it("dispatches one notification per matching rule (multiple users / thresholds)", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("market", "m", [
      makeRule({ id: "ra", userId: "alice", targetId: "m", params: { threshold: 0.5 } }),
      makeRule({ id: "rb", userId: "bob", targetId: "m", params: { threshold: 0.55 } }),
      // Threshold not crossed (0.4 -> 0.45 stays below 0.5) — must not fire.
      makeRule({ id: "rc", userId: "carol", targetId: "m", params: { threshold: 0.8 } }),
    ]);

    const fired = await evaluator.evaluatePriceUpdate("m", 0.4, 0.6);

    expect(fired.map((n) => n.alertId).sort()).toEqual(["ra", "rb"]);
    expect(publisher.published.map((n) => n.userId).sort()).toEqual(["alice", "bob"]);
  });

  it("dispatches nothing when no rules exist for the target", async () => {
    const { evaluator, publisher } = setup();
    const fired = await evaluator.evaluatePriceUpdate("market-without-rules", 0.4, 0.6);
    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// spreadWiden evaluation
// ---------------------------------------------------------------------------

describe("AlertEvaluator.evaluateSpreadUpdate (spreadWiden)", () => {
  it("fires when the spread widens beyond minGap and addresses the right user", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("canonicalEvent", "ce-1", [
      makeRule({
        id: "s1",
        userId: "dave",
        targetType: "canonicalEvent",
        targetId: "ce-1",
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
      }),
    ]);

    const fired = await evaluator.evaluateSpreadUpdate("ce-1", 0.04, 0.08);

    expect(fired).toHaveLength(1);
    expect(publisher.published).toEqual([
      {
        alertId: "s1",
        userId: "dave",
        ruleType: "spreadWiden",
        targetType: "canonicalEvent",
        targetId: "ce-1",
        details: {
          kind: "spreadWiden",
          minGap: 0.05,
          previousGap: 0.04,
          currentGap: 0.08,
        },
      },
    ]);
    expect(rules.calls).toEqual([{ targetType: "canonicalEvent", targetId: "ce-1" }]);
  });

  it("does NOT re-fire while the spread stays wide (prev already above minGap)", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("canonicalEvent", "ce", [
      makeRule({
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
      }),
    ]);

    // First widening fires.
    const first = await evaluator.evaluateSpreadUpdate("ce", 0.04, 0.08);
    expect(first).toHaveLength(1);

    // Staying wide does not re-fire.
    const second = await evaluator.evaluateSpreadUpdate("ce", 0.08, 0.09);
    expect(second).toEqual([]);

    expect(publisher.published).toHaveLength(1);
  });

  it("fires on a first observation that opens already-wide (prevGap = 0)", async () => {
    const { evaluator, rules } = setup();
    rules.set("canonicalEvent", "ce", [
      makeRule({
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
      }),
    ]);

    const fired = await evaluator.evaluateSpreadUpdate("ce", 0, 0.2);
    expect(fired).toHaveLength(1);
  });

  it("ignores inactive and non-spread rules on a spread update", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("canonicalEvent", "ce", [
      makeRule({
        id: "inactive",
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
        active: false,
      }),
      makeRule({
        id: "threshold",
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "thresholdCross",
        params: { threshold: 0.5 },
      }),
    ]);

    const fired = await evaluator.evaluateSpreadUpdate("ce", 0.0, 0.5);

    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });

  it("dispatches one notification per matching spreadWiden rule", async () => {
    const { evaluator, rules, publisher } = setup();
    rules.set("canonicalEvent", "ce", [
      makeRule({
        id: "sa",
        userId: "u1",
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.05 },
      }),
      makeRule({
        id: "sb",
        userId: "u2",
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.06 },
      }),
      // minGap 0.2 not reached by 0.08 — must not fire.
      makeRule({
        id: "sc",
        userId: "u3",
        targetType: "canonicalEvent",
        targetId: "ce",
        ruleType: "spreadWiden",
        params: { minGap: 0.2 },
      }),
    ]);

    const fired = await evaluator.evaluateSpreadUpdate("ce", 0.04, 0.08);

    expect(fired.map((n) => n.alertId).sort()).toEqual(["sa", "sb"]);
    expect(publisher.published).toHaveLength(2);
  });

  it("dispatches nothing when no rules exist for the canonical event", async () => {
    const { evaluator, publisher } = setup();
    const fired = await evaluator.evaluateSpreadUpdate("ce-none", 0.0, 0.9);
    expect(fired).toEqual([]);
    expect(publisher.published).toHaveLength(0);
  });
});
