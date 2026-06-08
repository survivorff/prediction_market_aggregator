/**
 * Pure presentation helpers shared by the discovery + detail UI.
 *
 * The cardinal rule (Requirement 1.5): a missing upstream value is rendered
 * EXPLICITLY as the em-dash placeholder, never as `0` or a fabricated default.
 * Every formatter therefore funnels `null`/`undefined`/`NaN` to {@link EMPTY}.
 */

/** The explicit "missing value" placeholder (Requirement 1.5). */
export const EMPTY = "—";

/** True when a numeric field is absent/non-finite and should render as {@link EMPTY}. */
function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/**
 * Format an implied probability (0..1) as a whole-number percentage, e.g.
 * `0.62 → "62%"`. Missing → {@link EMPTY}.
 */
export function formatProbability(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  const pct = Math.round(value * 100);
  return `${pct}%`;
}

/**
 * Format a money-ish magnitude (volume, liquidity) with a compact suffix, e.g.
 * `1234 → "$1.2K"`, `2_500_000 → "$2.5M"`. Missing → {@link EMPTY}.
 */
export function formatCurrency(value: number | null | undefined): string {
  if (isMissing(value)) return EMPTY;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Format a duration (seconds remaining) as a coarse human label, e.g.
 * `"3d 4h"`, `"5h 12m"`, `"42m"`. A non-positive remaining time → `"Ended"`.
 * Missing → {@link EMPTY}.
 */
export function formatTimeRemaining(seconds: number | null | undefined): string {
  if (isMissing(seconds)) return EMPTY;
  if (seconds <= 0) return "Ended";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Title-case a lowercase enum-ish token for display, e.g. `"crypto" → "Crypto"`. */
export function titleCase(value: string): string {
  if (value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}
