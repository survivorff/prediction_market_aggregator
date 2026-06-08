/**
 * Normalized core domain model — pure types, value objects, and validation
 * helpers with NO I/O dependencies (see design.md "Data Models").
 */

export type { Category } from "./category.js";
export { CATEGORIES, isCategory } from "./category.js";

export type { Source, SourceType } from "./source.js";
export { SOURCE_TYPES, isSourceType } from "./source.js";

export type { Event } from "./event.js";

export type { Market, MarketStatus } from "./market.js";
export { MARKET_STATUSES, isMarketStatus } from "./market.js";

export type { Outcome } from "./outcome.js";

export type { PricePoint } from "./price-point.js";

export type { CanonicalEvent } from "./canonical-event.js";

export type { WatchlistItem, WatchlistTargetType } from "./watchlist.js";
export { WATCHLIST_TARGET_TYPES, isWatchlistTargetType } from "./watchlist.js";

export type {
  AlertRule,
  AlertRuleType,
  AlertRuleParams,
  ThresholdCrossParams,
  SpreadWidenParams,
} from "./alert-rule.js";
export {
  ALERT_RULE_TYPES,
  ALERT_THRESHOLD_MIN,
  ALERT_THRESHOLD_MAX,
  isAlertRuleType,
  isThresholdCrossParams,
  isSpreadWidenParams,
  isValidAlertRuleParams,
  normalizeAlertRuleParams,
} from "./alert-rule.js";

export type { ResolutionCriteria } from "./resolution-criteria.js";

export type { BinaryNormalizationResult, ResolutionCriteriaInput } from "./validation.js";
export {
  PROBABILITY_MIN,
  PROBABILITY_MAX,
  BINARY_SUM_TOLERANCE,
  isValidProbability,
  clampProbability,
  normalizeProbability,
  binaryProbabilitiesSumToOne,
  normalizeBinaryProbabilities,
  isValidSpread,
  normalizeSpread,
  normalizeResolutionCriteria,
} from "./validation.js";
