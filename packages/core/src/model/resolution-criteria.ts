/**
 * How a market settles — the data used by the matching engine's Layer-4
 * resolution-criteria alignment check (see design.md).
 *
 * `raw` is ALWAYS preserved for auditability, even when the structured fields
 * cannot be parsed (Requirement 10.3). Structured fields are nullable because
 * not every platform exposes them.
 */
export interface ResolutionCriteria {
  /** e.g. "CoinGecko close", "AP race call". Null when not parseable. */
  dataSource: string | null;
  /** ISO 8601 settlement cutoff. Null when not parseable. */
  cutoffTime: string | null;
  /** Platform rounding rule description. Null when not parseable. */
  rounding: string | null;
  /** Preserved raw criteria for auditability (matching Layer 4). */
  raw: Record<string, unknown>;
}
