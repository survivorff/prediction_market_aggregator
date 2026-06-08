/**
 * Safe accessors for **untrusted** Predict.fun payloads.
 *
 * Every Predict.fun response is treated as untrusted JSON of unknown shape. The
 * mapper never indexes raw objects directly; it goes through these helpers so a
 * missing or malformed field becomes an explicit `null`/`undefined`/`[]` rather
 * than a thrown error (Requirement 1.5 — represent missing values explicitly;
 * adapters must "never throw on missing optional fields").
 *
 * This mirrors the other adapters' `safe.ts` so each adapter folder stays
 * self-contained (Requirement 8.1 — adding a platform is a localized change).
 *
 * These functions are PURE and have no I/O dependency.
 */

/** Type guard: a non-null, non-array plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a property from an unknown value, returning `undefined` when absent. */
export function getField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Read the first present (non-null) property among `keys` (left-to-right). */
export function getFirstField(value: unknown, keys: readonly string[]): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

/** Coerce to a trimmed non-empty string, or `null` (numbers are stringified). */
export function asStringOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  return null;
}

/**
 * Coerce to a finite number, or `null`. Accepts numeric strings — Predict.fun
 * returns some prices as numbers (orderbook ladders) and others as strings
 * (`lastOrderSettled.price`), so callers must tolerate both.
 */
export function asFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Return the value as an array, or `[]` when it is not one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Convert an upstream timestamp to an ISO-8601 string, or `null`.
 *
 * Accepts ISO strings, epoch-seconds, and epoch-milliseconds (values past the
 * year-2001 millisecond threshold are treated as milliseconds — Predict.fun's
 * `updateTimestampMs` is in milliseconds). Returns `null` for anything
 * unparseable.
 */
export function toIsoTimestampOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) {
      return epochToIso(Number(trimmed));
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return epochToIso(value);
  }
  return null;
}

/** Convert an epoch value (seconds or milliseconds) to an ISO string. */
function epochToIso(epoch: number): string | null {
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const ms = epoch < 1e12 ? epoch * 1000 : epoch;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
