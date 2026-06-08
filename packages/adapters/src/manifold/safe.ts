/**
 * Safe accessors for **untrusted** upstream payloads.
 *
 * Every Manifold response is treated as untrusted JSON of unknown shape. The
 * mapper never indexes raw objects directly; it goes through these helpers so a
 * missing or malformed field becomes an explicit `null`/`undefined`/`[]` rather
 * than a thrown error (Requirement 1.5 — represent missing values explicitly;
 * adapters must "never throw on missing optional fields").
 *
 * These functions are PURE and have no I/O dependency. They mirror the
 * Polymarket adapter's `safe.ts` so each adapter folder stays self-contained
 * (Requirement 8.1 — adding a platform is a localized change).
 */

/** Type guard: a non-null, non-array plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a property from an unknown value, returning `undefined` when absent. */
export function getField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Read the first present property among `keys` (left-to-right). */
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
 * Coerce to a finite number, or `null`. Accepts numeric strings (defensive —
 * Manifold returns most numbers as JSON numbers, but upstream shapes are
 * untrusted).
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

/** Coerce to a boolean, accepting the common string/number encodings. */
export function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  if (typeof value === "number") return value === 1;
  return false;
}

/** Return the value as an array, or `[]` when it is not one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Convert an upstream timestamp to an ISO-8601 string, or `null`.
 *
 * Manifold timestamps are epoch milliseconds (e.g. `closeTime`, `createdTime`).
 * This also accepts ISO strings and epoch seconds for robustness: values below
 * the year-2001 millisecond threshold (~1e12) are treated as seconds. Returns
 * `null` for anything unparseable (never throws).
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
