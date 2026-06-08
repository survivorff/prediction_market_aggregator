import { describe, expect, it } from "vitest";
import { EMPTY, formatCurrency, formatProbability, formatTimeRemaining, titleCase } from "./format";

describe("formatProbability", () => {
  it("renders a 0..1 probability as a whole percent", () => {
    expect(formatProbability(0.62)).toBe("62%");
    expect(formatProbability(0)).toBe("0%");
    expect(formatProbability(1)).toBe("100%");
  });

  it("renders null/undefined/NaN as the explicit placeholder (Req 1.5)", () => {
    expect(formatProbability(null)).toBe(EMPTY);
    expect(formatProbability(undefined)).toBe(EMPTY);
    expect(formatProbability(Number.NaN)).toBe(EMPTY);
  });
});

describe("formatCurrency", () => {
  it("uses compact suffixes by magnitude", () => {
    expect(formatCurrency(500)).toBe("$500");
    expect(formatCurrency(1_234)).toBe("$1.2K");
    expect(formatCurrency(2_500_000)).toBe("$2.5M");
    expect(formatCurrency(3_100_000_000)).toBe("$3.1B");
  });

  it("renders missing values as the placeholder", () => {
    expect(formatCurrency(null)).toBe(EMPTY);
    expect(formatCurrency(undefined)).toBe(EMPTY);
  });
});

describe("formatTimeRemaining", () => {
  it("formats coarse durations", () => {
    expect(formatTimeRemaining(3 * 86_400 + 4 * 3_600)).toBe("3d 4h");
    expect(formatTimeRemaining(5 * 3_600 + 12 * 60)).toBe("5h 12m");
    expect(formatTimeRemaining(42 * 60)).toBe("42m");
  });

  it("returns Ended for non-positive durations and placeholder for missing", () => {
    expect(formatTimeRemaining(0)).toBe("Ended");
    expect(formatTimeRemaining(-10)).toBe("Ended");
    expect(formatTimeRemaining(null)).toBe(EMPTY);
  });
});

describe("titleCase", () => {
  it("capitalizes the first letter", () => {
    expect(titleCase("crypto")).toBe("Crypto");
    expect(titleCase("open")).toBe("Open");
    expect(titleCase("")).toBe("");
  });
});
