/**
 * {@link OutcomeRepository} — idempotent persistence for market outcomes.
 *
 * `upsertOutcome`/`upsertOutcomes` are idempotent on `(market_id, label)` per
 * the `outcome` table's unique constraint (design.md "Storage Schemas"). The
 * batch variant issues a single multi-row `INSERT ... ON CONFLICT DO UPDATE`,
 * which is atomic, and returns rows in the same order as the input.
 */

import type { Outcome, OutcomeRepository as IOutcomeRepository, OutcomeUpsert } from "@pma/core";
import type { Queryable } from "../client.js";
import { mapOutcomeRow, type OutcomeRow } from "../mappers.js";

const OUTCOME_COLUMNS = `id, market_id, label, token_id, implied_prob, last_price`;

const ON_CONFLICT_UPDATE = `ON CONFLICT (market_id, label) DO UPDATE SET
  token_id = EXCLUDED.token_id,
  implied_prob = EXCLUDED.implied_prob,
  last_price = EXCLUDED.last_price`;

export class OutcomeRepository implements IOutcomeRepository {
  constructor(private readonly db: Queryable) {}

  /** Idempotent upsert keyed on `(market_id, label)`; returns the persisted row. */
  async upsertOutcome(outcome: OutcomeUpsert): Promise<Outcome> {
    const result = await this.db.query<OutcomeRow>(
      `INSERT INTO outcome (market_id, label, token_id, implied_prob, last_price)
       VALUES ($1, $2, $3, $4, $5)
       ${ON_CONFLICT_UPDATE}
       RETURNING ${OUTCOME_COLUMNS}`,
      [outcome.marketId, outcome.label, outcome.tokenId, outcome.impliedProb, outcome.lastPrice],
    );
    const row = result.rows[0];
    if (!row) {
      // RETURNING always yields a row for an unconditional DO UPDATE.
      throw new Error(`upsertOutcome: no row returned for (${outcome.marketId}, ${outcome.label})`);
    }
    return mapOutcomeRow(row);
  }

  /**
   * Batch idempotent upsert via a single multi-row statement. The returned
   * rows are re-ordered to match the input order. An empty input yields `[]`.
   */
  async upsertOutcomes(outcomes: readonly OutcomeUpsert[]): Promise<Outcome[]> {
    if (outcomes.length === 0) return [];

    const values: unknown[] = [];
    const tuples = outcomes.map((o, i) => {
      const base = i * 5;
      values.push(o.marketId, o.label, o.tokenId, o.impliedProb, o.lastPrice);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });

    const result = await this.db.query<OutcomeRow>(
      `INSERT INTO outcome (market_id, label, token_id, implied_prob, last_price)
       VALUES ${tuples.join(", ")}
       ${ON_CONFLICT_UPDATE}
       RETURNING ${OUTCOME_COLUMNS}`,
      values,
    );

    // Re-order results to match the input order (a multi-row upsert does not
    // guarantee RETURNING order). Key on (market_id, label).
    const byKey = new Map<string, Outcome>();
    for (const row of result.rows) {
      byKey.set(`${row.market_id}\u0000${row.label}`, mapOutcomeRow(row));
    }
    return outcomes.map((o) => {
      const mapped = byKey.get(`${o.marketId}\u0000${o.label}`);
      if (!mapped) {
        throw new Error(`upsertOutcomes: missing returned row for (${o.marketId}, ${o.label})`);
      }
      return mapped;
    });
  }

  /** List a market's outcomes, ordered by label for stable output. */
  async listByMarket(marketId: string): Promise<Outcome[]> {
    const result = await this.db.query<OutcomeRow>(
      `SELECT ${OUTCOME_COLUMNS} FROM outcome
       WHERE market_id = $1
       ORDER BY label ASC`,
      [marketId],
    );
    return result.rows.map(mapOutcomeRow);
  }
}
