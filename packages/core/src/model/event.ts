import type { Category } from "./category.js";

/**
 * A platform-native grouping of related markets.
 *
 * Identified cross-system by `(sourceId, externalId)`. May be linked to a
 * {@link CanonicalEvent} once the matching engine groups it cross-platform.
 * See design.md "Model Definitions (domain types)".
 */
export interface Event {
  /** Internal UUID. */
  id: string;
  sourceId: string;
  /** Platform-native event id. */
  externalId: string;
  /** Set once linked cross-platform; null otherwise. */
  canonicalEventId: string | null;
  title: string;
  category: Category;
  /** ISO 8601. Null when the platform does not provide an end date. */
  endDate: string | null;
}
