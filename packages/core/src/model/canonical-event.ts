import type { Category } from "./category.js";

/**
 * A cross-platform grouping that links different platforms' markets
 * representing the same real-world question. Basis for the comparison view
 * and spread signals. See design.md "Model Definitions (domain types)".
 *
 * `subjectEntity` and `thresholdValue` are extracted by the matching engine's
 * Layer-1 pre-filter and are nullable when not applicable.
 */
export interface CanonicalEvent {
  /** Internal UUID. */
  id: string;
  title: string;
  category: Category;
  /** e.g. "BTC", a candidate name — used by matching Layer 1. Null if none. */
  subjectEntity: string | null;
  /** Extracted numeric threshold, e.g. 100000. Null if none. */
  thresholdValue: number | null;
  /** ISO 8601. Null when not applicable. */
  targetDate: string | null;
}
