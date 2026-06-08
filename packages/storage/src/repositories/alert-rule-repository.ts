/**
 * {@link AlertRuleRepository} — user-scoped persistence for alert rules
 * (design.md "Component 6: Alert / Watchlist Service" + the `alert_rule`
 * table). SQL lives here in `@pma/storage`; the alerts service / API gateway
 * depend on the `@pma/core` {@link IAlertRuleRepository} port.
 *
 * No deduplication (Requirement 5.2): unlike the watchlist, a user may create
 * MULTIPLE rules for the same target (e.g. different thresholds), so `create`
 * always inserts a new row and returns it. The rule is persisted with its
 * parameters (`params` JSONB) and an `active` flag.
 *
 * User scoping (Requirements 5.4, 9.4): every read/delete is filtered by
 * `user_id`, so a user can only ever see or remove their OWN rules; another
 * user's `id` resolves to `null` / `false` (→ 404 at the gateway), never a
 * cross-user read or delete.
 *
 * Validation: `ruleType` (against the `('thresholdCross','spreadWiden')`
 * domain) and `params` (per rule type) are validated/normalized BEFORE the
 * insert via {@link normalizeAlertRuleParams}, so a bad value surfaces a clear
 * error rather than a CHECK-constraint failure, and the persisted JSONB is
 * canonical (only the relevant field).
 */

import type {
  AlertRule,
  AlertRuleInput,
  AlertRuleRepository as IAlertRuleRepository,
} from "@pma/core";
import { isAlertRuleType, isWatchlistTargetType, normalizeAlertRuleParams } from "@pma/core";
import type { Queryable } from "../client.js";
import { mapAlertRuleRow, type AlertRuleRow } from "../mappers.js";

const ALERT_RULE_COLUMNS = `id, user_id, target_type, target_id, rule_type, params, active, created_at`;

export class AlertRuleRepository implements IAlertRuleRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Persist a new alert rule with its parameters + `active` flag
   * (Requirement 5.2). NOT deduplicated — always inserts a new row. `targetType`
   * and `ruleType` are validated against their domains, and `params` is
   * normalized per rule type (dropping extraneous keys) before the insert so a
   * bad value yields a clear error rather than a CHECK-constraint failure.
   * `active` defaults to `true` (the `alert_rule.active DEFAULT TRUE` column)
   * when omitted.
   */
  async create(input: AlertRuleInput): Promise<AlertRule> {
    if (!isWatchlistTargetType(input.targetType)) {
      throw new Error(
        `Invalid alert targetType "${String(input.targetType)}"; expected "market" or "canonicalEvent"`,
      );
    }
    if (!isAlertRuleType(input.ruleType)) {
      throw new Error(
        `Invalid alert ruleType "${String(input.ruleType)}"; expected "thresholdCross" or "spreadWiden"`,
      );
    }
    // Throws on a params/ruleType mismatch; returns canonical params.
    const params = normalizeAlertRuleParams(input.ruleType, input.params);
    const active = input.active ?? true;

    const inserted = await this.db.query<AlertRuleRow>(
      `INSERT INTO alert_rule (user_id, target_type, target_id, rule_type, params, active)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING ${ALERT_RULE_COLUMNS}`,
      [
        input.userId,
        input.targetType,
        input.targetId,
        input.ruleType,
        JSON.stringify(params),
        active,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      // Unreachable: a plain INSERT ... RETURNING always yields the inserted row.
      throw new Error("create: alert_rule insert returned no row");
    }
    return mapAlertRuleRow(row);
  }

  /** List a user's alert rules, newest first (Requirement 9.4). */
  async listByUser(userId: string): Promise<AlertRule[]> {
    const result = await this.db.query<AlertRuleRow>(
      `SELECT ${ALERT_RULE_COLUMNS} FROM alert_rule
       WHERE user_id = $1
       ORDER BY created_at DESC, id ASC`,
      [userId],
    );
    return result.rows.map(mapAlertRuleRow);
  }

  /**
   * Fetch a single alert rule by id, scoped to its owner. Returns `null` when
   * the id does not exist OR belongs to another user (Requirements 5.4, 9.4) —
   * callers cannot probe other users' rules.
   */
  async getById(userId: string, id: string): Promise<AlertRule | null> {
    const result = await this.db.query<AlertRuleRow>(
      `SELECT ${ALERT_RULE_COLUMNS} FROM alert_rule
       WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    const row = result.rows[0];
    return row ? mapAlertRuleRow(row) : null;
  }

  /**
   * Delete a user's alert rule by id, scoped to its owner. Returns `true` when
   * a row was removed, `false` when no matching `(id, user_id)` row exists
   * (unknown id OR owned by another user → 404 at the gateway). Once removed,
   * the system no longer evaluates it (Requirement 5.4).
   */
  async delete(userId: string, id: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM alert_rule WHERE id = $1 AND user_id = $2`, [
      id,
      userId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
