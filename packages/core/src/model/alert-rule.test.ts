import { describe, it, expect } from "vitest";

import {
  ALERT_RULE_TYPES,
  isAlertRuleType,
  isThresholdCrossParams,
  isSpreadWidenParams,
  isValidAlertRuleParams,
  normalizeAlertRuleParams,
} from "./alert-rule.js";

/**
 * Unit tests for the alert-rule domain guards/validation (task 8.2;
 * Requirement 5.2). Cover the rule-type guard, the per-type params guards
 * (probability-bounded `threshold`, non-negative `minGap`), and the
 * normalize-or-throw helper that strips extraneous keys.
 */

describe("isAlertRuleType", () => {
  it("accepts the two supported rule types", () => {
    expect(isAlertRuleType("thresholdCross")).toBe(true);
    expect(isAlertRuleType("spreadWiden")).toBe(true);
    expect(ALERT_RULE_TYPES).toEqual(["thresholdCross", "spreadWiden"]);
  });

  it("rejects unknown / non-string values", () => {
    expect(isAlertRuleType("priceDrop")).toBe(false);
    expect(isAlertRuleType("")).toBe(false);
    expect(isAlertRuleType(null)).toBe(false);
    expect(isAlertRuleType(123)).toBe(false);
  });
});

describe("isThresholdCrossParams", () => {
  it("accepts a threshold within [0, 1] (inclusive bounds)", () => {
    expect(isThresholdCrossParams({ threshold: 0 })).toBe(true);
    expect(isThresholdCrossParams({ threshold: 0.5 })).toBe(true);
    expect(isThresholdCrossParams({ threshold: 1 })).toBe(true);
  });

  it("rejects out-of-range, non-finite, or missing thresholds", () => {
    expect(isThresholdCrossParams({ threshold: -0.01 })).toBe(false);
    expect(isThresholdCrossParams({ threshold: 1.01 })).toBe(false);
    expect(isThresholdCrossParams({ threshold: Number.NaN })).toBe(false);
    expect(isThresholdCrossParams({ threshold: Infinity })).toBe(false);
    expect(isThresholdCrossParams({ threshold: "0.5" })).toBe(false);
    expect(isThresholdCrossParams({})).toBe(false);
    expect(isThresholdCrossParams(null)).toBe(false);
  });
});

describe("isSpreadWidenParams", () => {
  it("accepts a non-negative minGap", () => {
    expect(isSpreadWidenParams({ minGap: 0 })).toBe(true);
    expect(isSpreadWidenParams({ minGap: 0.05 })).toBe(true);
    expect(isSpreadWidenParams({ minGap: 5 })).toBe(true);
  });

  it("rejects negative, non-finite, or missing minGap", () => {
    expect(isSpreadWidenParams({ minGap: -0.01 })).toBe(false);
    expect(isSpreadWidenParams({ minGap: Number.NaN })).toBe(false);
    expect(isSpreadWidenParams({ minGap: "0.05" })).toBe(false);
    expect(isSpreadWidenParams({})).toBe(false);
    expect(isSpreadWidenParams(null)).toBe(false);
  });
});

describe("isValidAlertRuleParams", () => {
  it("dispatches to the matching per-type guard", () => {
    expect(isValidAlertRuleParams("thresholdCross", { threshold: 0.5 })).toBe(true);
    expect(isValidAlertRuleParams("thresholdCross", { minGap: 0.5 })).toBe(false);
    expect(isValidAlertRuleParams("spreadWiden", { minGap: 0.05 })).toBe(true);
    expect(isValidAlertRuleParams("spreadWiden", { threshold: 0.5 })).toBe(false);
  });
});

describe("normalizeAlertRuleParams", () => {
  it("returns only the relevant field for thresholdCross, dropping extras", () => {
    const result = normalizeAlertRuleParams("thresholdCross", {
      threshold: 0.7,
      minGap: 0.1,
      junk: "x",
    });
    expect(result).toEqual({ threshold: 0.7 });
  });

  it("returns only minGap for spreadWiden", () => {
    const result = normalizeAlertRuleParams("spreadWiden", { minGap: 0.05, threshold: 0.2 });
    expect(result).toEqual({ minGap: 0.05 });
  });

  it("throws on params that do not match the rule type", () => {
    expect(() => normalizeAlertRuleParams("thresholdCross", { threshold: 2 })).toThrow(
      /thresholdCross/,
    );
    expect(() => normalizeAlertRuleParams("spreadWiden", { minGap: -1 })).toThrow(/spreadWiden/);
  });
});
