/**
 * {@link PricePointRepository} — time-series persistence for the `price_point`
 * TimescaleDB hypertable.
 *
 * `writePricePoint`/`writePricePoints` are idempotent on
 * `(market_id, outcome_id, ts)`: writing the same point more than once (e.g.
 * reconnect backfill overlapping live ticks) yields exactly one row
 * (Requirements 7.2, 10.2 / Property 2). We use `ON CONFLICT DO UPDATE` so a
 * re-write of the same key keeps a single row (last-write-wins on price/volume),
 * never a duplicate.
 *
 * `history` backs price-curve queries and WebSocket gap backfill (Requirements
 * 4.2, 4.4, 7.6), with optional `time_bucket` downsampling.
 */

import type {
  PricePoint,
  PricePointRepository as IPricePointRepository,
  TimeRange,
} from "@pma/core";
import type { Queryable } from "../client.js";
import { mapPricePointRow, type PricePointRow } from "../mappers.js";

const PRICE_POINT_COLUMNS = `market_id, outcome_id, ts, price, volume`;

const ON_CONFLICT_UPDATE = `ON CONFLICT (market_id, outcome_id, ts) DO UPDATE SET
  price = EXCLUDED.price,
  volume = EXCLUDED.volume`;

/** Map a {@link TimeRange.interval} to a Postgres interval literal. */
const INTERVAL_SQL: Record<NonNullable<TimeRange["interval"]>, string> = {
  "1m": "1 minute",
  "5m": "5 minutes",
  "1h": "1 hour",
  "1d": "1 day",
};

export class PricePointRepository implements IPricePointRepository {
  constructor(private readonly db: Queryable) {}

  /** Idempotent append keyed on `(market_id, outcome_id, ts)`. */
  async writePricePoint(point: PricePoint): Promise<void> {
    await this.db.query(
      `INSERT INTO price_point (market_id, outcome_id, ts, price, volume)
       VALUES ($1, $2, $3, $4, $5)
       ${ON_CONFLICT_UPDATE}`,
      [point.marketId, point.outcomeId, point.ts, point.price, point.volume],
    );
  }

  /**
   * Batch idempotent append via a single multi-row statement. Duplicate keys
   * within the batch collapse to one row (later wins), matching the
   * single-write idempotency semantics.
   */
  async writePricePoints(points: readonly PricePoint[]): Promise<void> {
    if (points.length === 0) return;

    // Collapse intra-batch duplicate keys (Postgres rejects a multi-row upsert
    // that touches the same conflict key twice); last occurrence wins.
    const deduped = new Map<string, PricePoint>();
    for (const p of points) {
      deduped.set(`${p.marketId}\u0000${p.outcomeId}\u0000${p.ts}`, p);
    }

    const values: unknown[] = [];
    const tuples = [...deduped.values()].map((p, i) => {
      const base = i * 5;
      values.push(p.marketId, p.outcomeId, p.ts, p.price, p.volume);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    await this.db.query(
      `INSERT INTO price_point (market_id, outcome_id, ts, price, volume)
       VALUES ${tuples.join(", ")}
       ${ON_CONFLICT_UPDATE}`,
      values,
    );
  }

  /**
   * Read a price series for a market over `[from, to]`. When `range.interval`
   * is set, downsamples to the last point in each `time_bucket` per outcome;
   * otherwise returns every stored point. Ordered by `ts` then `outcome_id`.
   */
  async history(marketId: string, range: TimeRange): Promise<PricePoint[]> {
    if (range.interval) {
      const intervalSql = INTERVAL_SQL[range.interval];
      const result = await this.db.query<PricePointRow>(
        `SELECT market_id, outcome_id, ts, price, volume
         FROM (
           SELECT DISTINCT ON (outcome_id, bucket)
             market_id, outcome_id, ts, price, volume
           FROM (
             SELECT market_id, outcome_id, ts, price, volume,
                    time_bucket($4::interval, ts) AS bucket
             FROM price_point
             WHERE market_id = $1 AND ts >= $2 AND ts <= $3
           ) bucketed
           ORDER BY outcome_id, bucket, ts DESC
         ) downsampled
         ORDER BY ts ASC, outcome_id ASC`,
        [marketId, range.from, range.to, intervalSql],
      );
      return result.rows.map(mapPricePointRow);
    }

    const result = await this.db.query<PricePointRow>(
      `SELECT ${PRICE_POINT_COLUMNS} FROM price_point
       WHERE market_id = $1 AND ts >= $2 AND ts <= $3
       ORDER BY ts ASC, outcome_id ASC`,
      [marketId, range.from, range.to],
    );
    return result.rows.map(mapPricePointRow);
  }

  /** Latest stored point for a market outcome; `null` when none exists. */
  async latest(marketId: string, outcomeId: string): Promise<PricePoint | null> {
    const result = await this.db.query<PricePointRow>(
      `SELECT ${PRICE_POINT_COLUMNS} FROM price_point
       WHERE market_id = $1 AND outcome_id = $2
       ORDER BY ts DESC
       LIMIT 1`,
      [marketId, outcomeId],
    );
    const row = result.rows[0];
    return row ? mapPricePointRow(row) : null;
  }
}
