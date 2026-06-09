import { describe, it, expect } from "vitest";
import { inferCategory, isCategory, CATEGORIES } from "./category.js";

/**
 * Unit tests for {@link inferCategory} — the deterministic keyword classifier
 * that projects a market question / platform hint onto the normalized
 * {@link Category} taxonomy (used by adapters to derive the denormalized
 * market category at ingestion).
 */

describe("inferCategory", () => {
  it("classifies crypto questions", () => {
    expect(inferCategory("Will BTC close above $100,000 in 2025?")).toBe("crypto");
    expect(inferCategory("Will Bitcoin reach $100k by end of 2025?")).toBe("crypto");
    expect(inferCategory("Will Ethereum flip Solana?")).toBe("crypto");
  });

  it("classifies politics questions", () => {
    expect(inferCategory("Who wins the 2028 US presidential election?")).toBe("politics");
    expect(inferCategory("Will the Senate pass the bill?")).toBe("politics");
  });

  it("classifies sports questions", () => {
    expect(inferCategory("Will Colombia win the 2026 FIFA World Cup?")).toBe("sports");
    expect(inferCategory("Will Victor Wembanyama win the NBA Finals MVP?")).toBe("sports");
  });

  it("classifies economics questions", () => {
    expect(inferCategory("Will the Fed cut interest rates in March?")).toBe("economics");
    expect(inferCategory("Will US CPI inflation exceed 3%?")).toBe("economics");
  });

  it("classifies tech questions", () => {
    expect(inferCategory("Will OpenAI release GPT-6 in 2026?")).toBe("tech");
    expect(inferCategory("Will SpaceX reach orbit with Starship?")).toBe("tech");
  });

  it("honors an explicit category label", () => {
    expect(inferCategory("crypto")).toBe("crypto");
    expect(inferCategory("  Politics  ")).toBe("politics");
  });

  it("uses a platform hint prepended to the question", () => {
    expect(inferCategory("us-politics Will the incumbent be re-elected?")).toBe("politics");
    expect(inferCategory("epl-cry-mac-2025 Crystal Palace to win")).toBe("sports");
  });

  it("falls back to 'other' for unmatched / empty text", () => {
    expect(inferCategory("Will it rain tomorrow somewhere unspecified?")).toBe("other");
    expect(inferCategory("")).toBe("other");
    expect(inferCategory("   ")).toBe("other");
  });

  it("never returns a value outside the taxonomy", () => {
    for (const q of ["BTC", "election", "world cup", "", "random words here"]) {
      expect(isCategory(inferCategory(q))).toBe(true);
      expect(CATEGORIES).toContain(inferCategory(q));
    }
  });

  it("does not false-match short keywords inside unrelated words", () => {
    // "ai" must not match inside "aid"; "eth" must not match inside "ethics".
    expect(inferCategory("Will foreign aid increase next year?")).not.toBe("tech");
    expect(inferCategory("Will the ethics committee convene?")).not.toBe("crypto");
  });
});
