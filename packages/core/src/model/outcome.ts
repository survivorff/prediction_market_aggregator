/**
 * A possible result of a market (e.g. "Yes" / "No" / a candidate name).
 *
 * Carries the market-derived implied probability and last price, both in the
 * range [0, 1] for binary markets (see design.md "Validation Rules"). Values
 * are nullable because a source may provide incomplete metadata (Requirement
 * 1.5).
 */
export interface Outcome {
  /** Internal UUID. */
  id: string;
  marketId: string;
  /** "Yes" / "No" / candidate name. */
  label: string;
  /** On-chain outcome token (e.g. Polymarket); null off-chain. */
  tokenId: string | null;
  /** Implied probability, 0..1. Null when unavailable. */
  impliedProb: number | null;
  /** Last traded price, 0..1 for binary. Null when unavailable. */
  lastPrice: number | null;
}
