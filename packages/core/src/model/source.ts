/**
 * A registered prediction-market platform (e.g. Polymarket, Manifold).
 *
 * See design.md "Model Definitions (domain types)". Pure data only — no I/O.
 */

/** Platform classification used for compliance gating and display. */
export type SourceType = "onchain" | "cex" | "regulated";

/** All valid {@link SourceType} values. */
export const SOURCE_TYPES: readonly SourceType[] = ["onchain", "cex", "regulated"] as const;

/** Type guard: returns true when `value` is a valid {@link SourceType}. */
export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && (SOURCE_TYPES as readonly string[]).includes(value);
}

export interface Source {
  /** Internal UUID. */
  id: string;
  /** Display name, e.g. "Polymarket", "Manifold". */
  name: string;
  type: SourceType;
  /** Settlement currency, e.g. "USDC", "MANA". */
  baseCurrency: string;
}
