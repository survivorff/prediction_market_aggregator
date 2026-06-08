import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { CORE_PACKAGE } from "./index.js";

/**
 * Bootstrap smoke tests for task 1.
 *
 * These confirm the toolchain is wired correctly: Vitest runs, TypeScript
 * compiles workspace imports, and fast-check (property-based testing) is
 * available. Real domain properties are added in later tasks.
 */
describe("toolchain bootstrap", () => {
  it("exposes the core package marker", () => {
    expect(CORE_PACKAGE).toBe("@pma/core");
  });

  it("runs a fast-check property (PBT runner is available)", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        // Addition is commutative — a trivial universal property to prove the
        // property-based testing runner is correctly installed and executing.
        return a + b === b + a;
      }),
    );
  });
});
