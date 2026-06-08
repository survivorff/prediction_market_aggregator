# Requirements Document

## Introduction

The Prediction Market Aggregator is an independent, read-only comparison dashboard and data service that unifies prediction markets across multiple platforms (v1: Polymarket and Manifold). It normalizes cross-platform market data into a single schema, lets users discover the same real-world question across venues, compares implied probabilities side by side, and surfaces the largest cross-platform price gaps as **display-only** signals.

These requirements are derived from the approved design document (`design.md`). v1 is explicitly read-only: no order placement, fund routing, or execution. The architecture reserves a future "one-click participate" execution seam (the outbound deep-link), but that is out of scope for v1. Requirement numbering aligns with the correctness-property references in the design.

### Scope (v1)

In scope: unified discovery, same-question comparison, display-only price-gap signals, market detail with price history, watchlist + alerts, outbound trade deep-links, the ingestion pipeline (Polymarket, Manifold, Predict.fun), the normalized data model, the adapter extension layer, and the outbound API gateway.

Out of scope (designed-for, not built): order placement, fund routing, cross-platform execution/hedging, region-specific trade-routing compliance/geofencing, adapters beyond Polymarket, Manifold, and Predict.fun.

---

## Requirements

### Requirement 1: Unified Market Discovery

**User Story:** As a prediction-market user, I want to search and browse markets across all aggregated platforms in one place with normalized metrics, so that I can discover relevant markets without visiting each platform individually.

#### Acceptance Criteria

1. WHEN a user requests the market list THEN the system SHALL return markets from all registered sources with a unified shape including implied probability, 24h volume, liquidity, and time remaining.
2. WHEN a user filters by category (politics, crypto, sports, economics, tech) OR provides a search query THEN the system SHALL return only markets matching the filter or full-text query.
3. WHEN the system normalizes any market outcome THEN the implied probability and binary last price SHALL be within the range [0, 1], and binary-market outcome probabilities SHALL sum to within a defined tolerance of 1.
4. WHEN a user sorts the discovery list THEN the system SHALL support sorting by volume, liquidity, and time remaining.
5. WHEN a source provides incomplete metadata (e.g., missing liquidity) THEN the system SHALL return the available fields and represent missing values explicitly rather than failing the request.

### Requirement 2: Same-Question Comparison View

**User Story:** As a user comparing venues, I want to see the same real-world question across different platforms side by side, so that I can compare probabilities and identify where a market is cheaper or richer.

#### Acceptance Criteria

1. WHEN a user opens a canonical event THEN the system SHALL present each platform's corresponding market side by side with its implied probability, 24h volume, and outbound trade link.
2. WHEN markets are linked to the same canonical event THEN the linkage SHALL be symmetric (if A links to B, B links to A) and the computed maximum spread SHALL be identical regardless of row ordering.
3. WHEN a linked market has a resolution-criteria mismatch THEN the comparison view SHALL display that row with an explicit mismatch flag explaining why it is excluded from spread computation.
4. WHEN fewer than two non-mismatched markets are linked to a canonical event THEN the system SHALL display the available market(s) without a spread value.

### Requirement 3: Price-Gap / Arbitrage Signals (Display-Only)

**User Story:** As a user looking for opportunities, I want to see the markets with the largest cross-platform price gaps, so that I can spot potential mispricings — while understanding the system never executes trades.

#### Acceptance Criteria

1. WHEN a user requests signals THEN the system SHALL return canonical events ranked by the largest cross-platform implied-probability gap.
2. WHEN computing a spread signal THEN the system SHALL include only open markets whose resolution criteria are aligned (resolutionMismatch = false), so that mismatched-criteria pairs never produce an arbitrage signal.
3. WHEN any signal is returned by the API THEN it SHALL be marked non-executable (executable = false), and the system SHALL expose no execution or order-placement path in v1.
4. WHEN a canonical event has insufficient aligned markets THEN the system SHALL omit it from the signals list rather than emitting a misleading gap.

### Requirement 4: Market Detail and Price History

**User Story:** As a user evaluating a market, I want to see its detail with a historical probability curve, depth, and recent trades, so that I can understand the market's trend before acting.

#### Acceptance Criteria

1. WHEN a user opens a market detail THEN the system SHALL return the market metadata, its outcomes with latest prices, and a link to its source.
2. WHEN a user requests price history for a market over a time range and interval THEN the system SHALL return a time-series of price points suitable for rendering a probability curve.
3. WHERE a source supports order-book depth THEN the system SHALL include latest depth information in the market detail.
4. WHEN price history is requested for a market that experienced a streaming gap THEN the returned series SHALL be continuous (gaps backfilled), with no missing points within the available range.

### Requirement 5: Watchlist and Movement Alerts

**User Story:** As a returning user, I want to track specific markets or canonical events and be notified when probability crosses a threshold or a spread widens, so that I do not have to monitor the dashboard continuously.

#### Acceptance Criteria

1. WHEN an authenticated user adds a market or canonical event to their watchlist THEN the system SHALL persist it and prevent duplicate entries for the same target.
2. WHEN an authenticated user creates an alert rule (threshold crossing or spread widening) THEN the system SHALL persist the rule with its parameters and an active flag.
3. WHEN an incoming price update causes a market's probability to cross a user's threshold OR a canonical event's spread to widen beyond a user's minimum gap THEN the system SHALL dispatch a notification to that user.
4. WHEN a user deletes a watchlist item or alert rule THEN the system SHALL remove it and stop evaluating it.

### Requirement 6: Outbound Trade Deep-Link

**User Story:** As a user who decides to act, I want a direct link to the source platform for a given market, so that I can go trade on the originating venue.

#### Acceptance Criteria

1. WHEN a user requests the trade link for a market THEN the system SHALL return a deep-link to that market on its source platform.
2. WHEN the trade-link endpoint is invoked THEN the system SHALL NOT perform any order placement, fund routing, or execution (it is a navigation link only in v1).
3. WHERE a future execution phase is enabled THEN the trade-link slot SHALL be replaceable without changing the discovery, comparison, or signals contracts.

### Requirement 7: Resilient Ingestion Pipeline

**User Story:** As an operator, I want metadata and prices ingested reliably and idempotently across platforms, so that the dataset stays accurate and consistent even under upstream failures.

#### Acceptance Criteria

1. WHEN the same upstream market state is synced more than once THEN the system SHALL upsert by (source_id, external_id) such that repeated syncs produce no duplicate rows and no net change (idempotent ingestion).
2. WHEN the same price point is written more than once (e.g., reconnect backfill overlapping live ticks) THEN the system SHALL persist exactly one row keyed by (market_id, outcome_id, ts) (idempotent price writes).
3. WHEN a metadata sync page is processed THEN the system SHALL persist the keyset cursor only after the page is durably written; IF the page write fails THEN the system SHALL NOT advance the cursor at all (no temporary advancement or rollback), and cursors SHALL never regress across successful syncs (crash-safe resume).
4. WHEN a source explicitly declares the websocketPrices capability as true THEN the system SHALL stream active markets via WebSocket and SHALL invoke subscribePrices; OTHERWISE (capability false or undeclared) the system SHALL NOT invoke subscribePrices and SHALL serve the source via tiered polling, ensuring price history has no gaps.
5. WHEN an upstream call fails transiently (rate limit, 5xx, network) THEN the system SHALL apply rate limiting and jittered exponential backoff up to a maximum attempt count, and SHALL not advance the cursor on failure.
6. WHEN a WebSocket connection drops THEN the system SHALL reconnect with backoff and backfill the missed interval via price history.

### Requirement 8: Adapter Extensibility

**User Story:** As a contributor (the repo is open source), I want to add a new platform by implementing a single adapter interface, so that adding a venue requires no changes to the core domain, matching, or API layers.

#### Acceptance Criteria

1. WHEN a new platform adapter is added or an existing one removed THEN only that adapter's module SHALL change; the normalized model, matching engine, and API contracts SHALL be unaffected (adapter isolation).
2. WHEN an adapter is implemented THEN it SHALL conform to the MarketSource interface and declare its capabilities (websocketPrices, priceHistory, orderBookDepth, keysetPagination).
3. WHEN the orchestrator uses an adapter THEN it SHALL only call optional methods that the adapter's capabilities permit.
4. WHEN an adapter is registered THEN it SHALL be usable by the ingestion pipeline without any change to call sites elsewhere.

### Requirement 9: Outbound API Gateway

**User Story:** As a frontend (and future B2B consumer), I want a single normalized API and live update channel, so that I never talk to upstream platforms directly and benefit from unified rate limiting.

#### Acceptance Criteria

1. WHEN a client reads discovery, comparison, detail, or signal data THEN it SHALL be served exclusively by the system's own REST/GraphQL endpoints, not by upstream platform APIs.
2. WHEN live price or spread updates occur THEN the system SHALL push them to subscribed clients over its own WebSocket fan-out channel.
3. WHEN a client calls any public read endpoint THEN the system SHALL apply unified rate limiting and validate input parameters.
4. WHEN a client accesses user-scoped resources (watchlist, alerts) THEN the system SHALL require authentication.

### Requirement 10: Normalized Data Model and Storage

**User Story:** As the system, I want a platform-agnostic normalized schema with relational metadata and time-series prices, so that cross-platform comparison and signals are computed on consistent data.

#### Acceptance Criteria

1. WHEN any entity is persisted THEN it SHALL conform to the normalized model (Source, Event, Market, Outcome, PricePoint, CanonicalEvent) with (source_id, external_id) uniqueness for ingested entities.
2. WHEN price time-series are stored THEN they SHALL be persisted in a TimescaleDB hypertable keyed by (market_id, outcome_id, ts).
3. WHEN raw resolution criteria are received THEN the system SHALL preserve them for auditability even when structured fields cannot be parsed.
4. WHEN latest prices are read on hot paths THEN the system SHALL serve them from the Redis hot cache.

### Requirement 11: Same-Question Matching Engine

**User Story:** As the system, I want to link markets representing the same real-world question across platforms while flagging resolution-criteria mismatches, so that comparison and signals are accurate and never falsely arbitraged.

#### Acceptance Criteria

1. WHEN a market is ingested or updated THEN the matching engine SHALL evaluate it via a rules/metadata pre-filter (category, time window, subject entity, threshold) followed by semantic similarity on question text.
2. WHEN a candidate pair's similarity is below the auto-confirm threshold OR the pair is high-value THEN the system SHALL route it to a human calibration queue rather than auto-linking.
3. WHEN a pair is matched THEN the system SHALL check resolution-criteria alignment and SHALL set resolutionMismatch = true when data source, cutoff time, or rounding materially differ.
4. WHEN a human calibration decision is made THEN the system SHALL store it as labeled data for improving future matching.

### Requirement 12: Compliance and Data Use (v1 Read-Only)

**User Story:** As an operator publishing this open-source project, I want v1 to remain within low-risk read-only boundaries and to reserve future regulated seams, so that the product is compliance-safe at launch.

#### Acceptance Criteria

1. WHEN the system operates in v1 THEN it SHALL expose no trading, order-placement, fund-routing, or execution capability.
2. WHERE per-source data redistribution policy must be respected THEN the system SHALL be able to record and gate exposure per source for future commercial/B2B use.
3. WHERE future regulated phases require user geo-partitioning THEN the data model SHALL reserve a user-region dimension without implementing routing logic in v1.

---

## Glossary

- **Adapter / MarketSource**: A per-platform module implementing a single interface (`fetchEvents`, `fetchMarkets`, `fetchPriceSnapshot`, `fetchPriceHistory`, optional `subscribePrices`, `capabilities`) that maps a platform's raw data into the normalized model. Adding a platform = adding one adapter.
- **Source**: A registered prediction-market platform (e.g., Polymarket, Manifold), typed as onchain, cex, or regulated.
- **Event**: A platform-native grouping of related markets.
- **Market**: The smallest unit of aggregation — a single question (on Polymarket, a binary Yes/No question backed by two outcome tokens). Identified cross-system by (source_id, external_id).
- **Outcome**: A possible result of a market (e.g., Yes/No), carrying an implied probability (0..1) and last price.
- **PricePoint**: A time-series price observation for a market outcome, stored in a TimescaleDB hypertable keyed by (market_id, outcome_id, ts).
- **CanonicalEvent**: A cross-platform grouping that links different platforms' markets representing the same real-world question. Basis for the comparison view and spread signals.
- **Implied Probability**: The market-derived probability of an outcome, equal to the price of the Yes token (0..1) for a binary market.
- **Spread / Price Gap**: The difference between the maximum and minimum implied probability for the same canonical event across platforms.
- **Spread Signal**: A display-only ranked indicator of cross-platform price gaps. Always non-executable in v1; computed only over markets with aligned resolution criteria.
- **Resolution Criteria**: How a market settles (data source, cutoff time, rounding). Used by matching to detect mismatches.
- **Resolution Mismatch**: A flag set when two linked markets settle by materially different criteria; mismatched markets are excluded from spread signals to avoid false arbitrage.
- **Same-Question Matching Engine**: The layered system (rules/metadata → semantic similarity → human calibration → resolution-criteria alignment) that links markets to a canonical event.
- **Ingestion Pipeline**: The orchestrator that polls metadata (keyset pagination) and streams/polls prices, performing idempotent upserts with rate limiting, backoff, and reconnect-with-backfill.
- **Keyset Cursor**: An opaque pagination marker used for incremental, crash-safe metadata sync; never regresses across successful syncs.
- **Idempotent Upsert**: A write keyed on a stable identifier such that repeating it produces no duplicate rows and no net change.
- **Tiering**: Classification of markets as active (streamed via WebSocket where supported) or long-tail (polled on a slower cadence).
- **API Gateway**: The system's own REST/GraphQL + WebSocket fan-out surface; the only interface clients use, shielding upstream differences and unifying rate limiting.
- **Hot Cache**: Redis store of latest prices for fast hot-path reads, plus pub/sub for WebSocket fan-out.
- **Trade Deep-Link**: An outbound navigation link to the source platform for a market; in v1 it is navigation only and reserves the slot for a future "one-click participate" execution flow.
- **One-Click Participate (future)**: The deferred, regulated execution flow (operator's own wallet/exchange) that will replace the outbound deep-link in a later phase; out of scope for v1.
