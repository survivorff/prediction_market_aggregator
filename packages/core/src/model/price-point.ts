/**
 * A time-series price observation for a market outcome.
 *
 * Persisted in a TimescaleDB hypertable keyed by `(marketId, outcomeId, ts)`
 * (Requirement 10.2). `ts` is the hypertable time dimension. Pure data only.
 * See design.md "Model Definitions (domain types)".
 */
export interface PricePoint {
  marketId: string;
  outcomeId: string;
  /** ISO 8601, hypertable time dimension. */
  ts: string;
  price: number;
  /** Observed volume at `ts`. Null when unavailable. */
  volume: number | null;
}
