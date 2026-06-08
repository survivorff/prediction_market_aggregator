/**
 * {@link SourceRepository} — read access to registered platforms for the
 * gateway's `GET /api/sources` endpoint (design.md "Outbound API Surface").
 *
 * The `source` table stores platform identity (key, name, type, base currency).
 * Adapter *capabilities* (websocketPrices, priceHistory, orderBookDepth,
 * keysetPagination) are declared in code by each adapter's `capabilities()` and
 * are not persisted, so this repository returns identity only; the gateway
 * overlays capabilities from the adapter registry / a provided capability map.
 */

import type { SourceType } from "@pma/core";
import type { Queryable } from "../client.js";

/** A registered source's persisted identity. */
export interface SourceRecord {
  id: string;
  key: string;
  name: string;
  type: SourceType;
  baseCurrency: string;
  /**
   * RESERVED future-phase seam (Requirement 12.2): the per-source
   * data-redistribution policy, RECORDED for future commercial/B2B exposure
   * gating. Read-only and NEVER gated on in v1 — surfaced here only for
   * inspection/admin tooling. The repository always populates it (defaulting to
   * `{}`, "no policy recorded"); it is OPTIONAL on the type so existing callers
   * and fixtures need not set it. See docs/compliance-and-future-seams.md and
   * migration 002_compliance_seams.sql.
   */
  redistributionPolicy?: Record<string, unknown>;
}

interface SourceRow {
  id: string;
  key: string;
  name: string;
  type: string;
  base_currency: string;
  redistribution_policy: Record<string, unknown> | null;
}

const SOURCE_COLUMNS = `id, key, name, type, base_currency, redistribution_policy`;

export class SourceRepository {
  constructor(private readonly db: Queryable) {}

  /** List all registered sources, ordered by key for stable output. */
  async list(): Promise<SourceRecord[]> {
    const result = await this.db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM source ORDER BY key ASC`,
    );
    return result.rows.map(mapSourceRow);
  }

  /** Fetch a single source by its stable slug; `null` when not present. */
  async getByKey(key: string): Promise<SourceRecord | null> {
    const result = await this.db.query<SourceRow>(
      `SELECT ${SOURCE_COLUMNS} FROM source WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? mapSourceRow(row) : null;
  }
}

function mapSourceRow(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    type: row.type as SourceType,
    baseCurrency: row.base_currency,
    // Recorded-only future-phase seam (Req 12.2); never gated in v1. Null-coalesce
    // to `{}` to tolerate rows from before migration 002 (defensive; the column
    // is NOT NULL DEFAULT '{}' so this is just belt-and-suspenders).
    redistributionPolicy: row.redistribution_policy ?? {},
  };
}
