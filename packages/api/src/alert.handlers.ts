/**
 * Framework-agnostic handlers for the user-scoped alert-rule endpoints (task
 * 8.2; design.md "Outbound API Surface" — `GET/POST/DELETE /api/alerts`).
 *
 * Each takes the injected {@link GatewayDeps}, the authenticated `userId`
 * (resolved by the `requireAuth` preHandler — Requirement 9.4), and
 * already-validated input, then delegates to the {@link AlertStore} port (SQL
 * lives in `@pma/storage`). Keeping these free of Fastify makes them
 * unit-testable with an in-memory fake store.
 *
 * Behavior:
 *   - create (POST): persists a new rule with its params + active flag
 *     (Requirement 5.2). NOT deduplicated — a user may create multiple rules
 *     for the same target.
 *   - list (GET): only the authenticated user's rules (Requirement 9.4).
 *   - delete (DELETE): scoped to the owner; an unknown/un-owned rule → 404
 *     (Requirements 5.4, 9.4).
 *
 * All user scoping is enforced via the `userId` threaded into every store call,
 * so one user can never read or delete another user's rules.
 */

import type { AlertRule } from "@pma/core";
import type { AlertListResponse, AlertRuleDto, CreateAlertBody, GatewayDeps } from "./dto.js";
import { NotFoundError } from "./errors.js";

/** Require the alert store, surfacing a clear error when unconfigured. */
function requireAlerts(deps: GatewayDeps): NonNullable<GatewayDeps["alerts"]> {
  if (deps.alerts === undefined) {
    throw new Error("Gateway is missing the alert store for alert routes");
  }
  return deps.alerts;
}

/** Map a core {@link AlertRule} to its wire DTO (drops the owner `userId`). */
function toDto(rule: AlertRule): AlertRuleDto {
  return {
    id: rule.id,
    targetType: rule.targetType,
    targetId: rule.targetId,
    ruleType: rule.ruleType,
    params: rule.params,
    active: rule.active,
    createdAt: rule.createdAt,
  };
}

/**
 * `GET /api/alerts` — list the authenticated user's alert rules
 * (Requirement 9.4: user-scoped). Returns only `userId`'s rules, newest first.
 */
export async function handleListAlerts(
  deps: GatewayDeps,
  userId: string,
): Promise<AlertListResponse> {
  const store = requireAlerts(deps);
  const rules = await store.listByUser(userId);
  return { alerts: rules.map(toDto) };
}

/**
 * `POST /api/alerts` — create an alert rule for the authenticated user and
 * persist it with its parameters + active flag (Requirement 5.2). NOT
 * deduplicated: a user may create multiple rules for the same target. The
 * route returns 201 (see `server.ts`).
 */
export async function handleCreateAlert(
  deps: GatewayDeps,
  userId: string,
  body: CreateAlertBody,
): Promise<AlertRuleDto> {
  const store = requireAlerts(deps);
  const rule = await store.create({
    userId,
    targetType: body.targetType,
    targetId: body.targetId,
    ruleType: body.ruleType,
    params: body.params,
  });
  return toDto(rule);
}

/**
 * `DELETE /api/alerts/{alertId}` — remove the authenticated user's alert rule
 * and stop evaluating it (Requirement 5.4). Scoped to the owner: deleting an
 * unknown id OR another user's rule removes nothing and throws
 * {@link NotFoundError} (404), so users cannot probe or delete others' rules
 * (Requirement 9.4).
 */
export async function handleDeleteAlert(
  deps: GatewayDeps,
  userId: string,
  alertId: string,
): Promise<void> {
  const store = requireAlerts(deps);
  const removed = await store.delete(userId, alertId);
  if (!removed) {
    throw new NotFoundError(`Alert rule "${alertId}" not found`);
  }
}
