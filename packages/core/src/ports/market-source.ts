import type { Category } from "../model/category.js";
import type { SourceType } from "../model/source.js";
import type { MarketStatus } from "../model/market.js";
import type { ResolutionCriteria } from "../model/resolution-criteria.js";

/**
 * The `MarketSource` adapter port — the foundational extension point of the
 * system. Each platform (Polymarket, Manifold, …) implements this interface in
 * its own `adapters/*` module; nothing else in the system imports platform
 * SDKs or knows platform-specific details (see design.md "The `MarketSource`
 * Adapter Interface").
 *
 * Optional methods are gated by {@link SourceCapabilities} so the orchestrator
 * degrades gracefully (e.g. Manifold has no native WebSocket →
 * `capabilities().websocketPrices === false` → fall back to polling).
 *
 * This module is part of the I/O-free `@pma/core` package: it declares the
 * port contract only, never an implementation (see design.md "Layered
 * Architecture"). Requirements: 8.2 (conform to interface + declare
 * capabilities), 10.1 (normalized model shapes).
 */

/**
 * Identity of a registered source. `id` is the internal source UUID resolved
 * at registration time; `key` is the stable slug used in code and routing.
 */
export interface SourceMeta {
  /** Internal source UUID (resolved at registration). */
  id: string;
  /** Stable slug: "polymarket" | "manifold". */
  key: string;
  name: string;
  /** "onchain" | "cex" | "regulated". */
  type: SourceType;
  baseCurrency: string;
}

/**
 * Self-declared capabilities of an adapter. The ingestion orchestrator only
 * calls optional methods that the capabilities permit (Requirement 8.3): e.g.
 * it invokes {@link MarketSource.subscribePrices} only when
 * `websocketPrices === true`.
 */
export interface SourceCapabilities {
  /** true: {@link MarketSource.subscribePrices} is implemented. */
  websocketPrices: boolean;
  /** true: {@link MarketSource.fetchPriceHistory} returns real history. */
  priceHistory: boolean;
  /** true: order-book depth is available (e.g. Polymarket CLOB). */
  orderBookDepth: boolean;
  /** true: cursor-based keyset pagination; false: offset fallback. */
  keysetPagination: boolean;
}

/**
 * A page request for keyset-paginated, incremental metadata sync.
 *
 * `cursor` is an opaque keyset marker (`undefined` = start of stream).
 * `updatedSince` enables incremental sync by only returning entities changed
 * after the given instant.
 */
export interface PageRequest {
  /** Opaque keyset cursor; `undefined` = start. */
  cursor?: string;
  /** Page size requested. */
  limit: number;
  /** ISO 8601; for incremental metadata sync. */
  updatedSince?: string;
}

/**
 * A page of results plus the cursor to fetch the next page. `nextCursor` is
 * `null` at the end of the stream for the current sync window (see design.md
 * ingestion algorithm `syncMarkets`).
 */
export interface Page<T> {
  items: T[];
  /** `null` = end of stream for this sync window. */
  nextCursor: string | null;
}

/** A time range (with optional bucketing) for price-history queries. */
export interface TimeRange {
  /** ISO 8601 (inclusive lower bound). */
  from: string;
  /** ISO 8601 (inclusive upper bound). */
  to: string;
  /** Optional downsampling interval for the returned series. */
  interval?: "1m" | "5m" | "1h" | "1d";
}

/**
 * A raw-normalized event payload — already mapped to the domain shape by the
 * adapter but not yet persisted (no internal UUIDs assigned). `rawResolution`
 * preserves the platform's raw criteria for auditability (Requirement 10.3).
 */
export interface NormalizedEvent {
  externalId: string;
  title: string;
  category: Category;
  endDate: string | null;
  rawResolution?: Record<string, unknown>;
}

/**
 * A raw-normalized market payload produced by an adapter. Identified upstream
 * by `externalId`; the persistence layer resolves `(source_id, external_id)`
 * to an internal UUID on upsert (Requirement 10.1).
 */
export interface NormalizedMarket {
  externalId: string;
  /** Platform-native owning event id; null when ungrouped. */
  eventExternalId: string | null;
  question: string;
  status: MarketStatus;
  volume24h: number | null;
  liquidity: number | null;
  spread: number | null;
  outcomes: NormalizedOutcome[];
  resolutionCriteria: ResolutionCriteria;
  /**
   * Adapter-derived category hint (the normalized domain `Market` carries no
   * category — it is denormalized onto the storage row at ingestion). Optional:
   * when omitted, the persistence layer defaults the row to `"other"`. Adapters
   * should populate it from their best category signal (tags / group slugs /
   * category slug + question text) — see {@link inferCategory}.
   */
  category?: Category;
}

/** A raw-normalized outcome payload carried within a {@link NormalizedMarket}. */
export interface NormalizedOutcome {
  label: string;
  tokenId: string | null;
  /** Implied probability, 0..1. Null when unavailable. */
  impliedProb: number | null;
  /** Last traded price, 0..1 for binary. Null when unavailable. */
  lastPrice: number | null;
}

/**
 * A single normalized price observation (pull snapshot or push tick),
 * identified upstream by `(marketExternalId, outcomeLabel, ts)`. The
 * persistence layer maps this to `(market_id, outcome_id, ts)` for idempotent
 * writes (Requirement 7.2).
 */
export interface NormalizedPriceSnapshot {
  marketExternalId: string;
  outcomeLabel: string;
  /** 0..1 for binary. */
  price: number;
  volume: number | null;
  /** ISO 8601 capture time. */
  ts: string;
}

/**
 * A point in a price-history series. Structurally identical to
 * {@link NormalizedPriceSnapshot} (history is a sequence of snapshots), kept as
 * a distinct alias to match the design's vocabulary.
 */
export type NormalizedPricePoint = NormalizedPriceSnapshot;

/** Callback invoked for each live price tick from {@link MarketSource.subscribePrices}. */
export type PriceTickHandler = (tick: NormalizedPriceSnapshot) => void;

/**
 * Handle to an open price subscription. `close()` tears down the underlying
 * stream; `isOpen` reflects current connection state so the orchestrator can
 * drive reconnect-with-backoff (Requirement 7.6).
 */
export interface Subscription {
  close(): void;
  readonly isOpen: boolean;
}

/**
 * The uniform per-platform adapter contract. Implementations live in
 * `adapters/*` and depend only on `@pma/core` (the dependency rule in
 * design.md "Module / Repository Layout").
 *
 * - Metadata sync uses keyset pagination and incremental `updatedSince`.
 * - Prices are available via pull ({@link fetchPriceSnapshot} /
 *   {@link fetchPriceHistory}) and optional push ({@link subscribePrices}).
 * - {@link capabilities} lets the orchestrator adapt and only call optional
 *   methods the adapter supports (Requirements 8.2, 8.3).
 */
export interface MarketSource {
  readonly meta: SourceMeta;

  // Metadata sync (keyset pagination, incremental via `updatedSince`).
  fetchEvents(opts: PageRequest): Promise<Page<NormalizedEvent>>;
  fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>>;

  // Prices — pull.
  fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]>;
  fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]>;

  // Prices — push (present only when `capabilities().websocketPrices`).
  subscribePrices?(marketIds: string[], handler: PriceTickHandler): Subscription;

  capabilities(): SourceCapabilities;
}
