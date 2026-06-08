# Architecture Overview

> Status: living document. This is the high-level orientation for contributors.
> The authoritative, detailed design lives in
> [`.kiro/specs/prediction-market-aggregator/design.md`](../.kiro/specs/prediction-market-aggregator/design.md).

## What this is

The Prediction Market Aggregator is an independent, **read-only** comparison
dashboard and data service. It unifies prediction markets across multiple
platforms (v1: Polymarket, Manifold, and Predict.fun) into a single normalized
data model so
users can:

- discover the same real-world question across venues,
- compare implied probabilities side by side, and
- see the largest cross-platform price gaps as **display-only** signals.

v1 deliberately stops short of any regulated activity: there is **no order
placement, no fund routing, and no execution**. The "Go trade" action is an
outbound deep-link to the source platform. The architecture reserves that exact
slot for a future "one-click participate" flow without requiring a rewrite.

## Layered architecture

Dependencies point inward toward the core domain. The adapter layer and the API
gateway are the replaceable edges.

```
Replaceable edges        Core domain                 Infrastructure
-----------------        -----------                 --------------
Adapter Layer  ───────▶  Ingestion Orchestrator
(per-platform)           Normalized Model  ────────▶ Postgres + TimescaleDB
API Gateway    ───────▶  Matching Engine             Redis
(REST/GraphQL/WS)        Alert Engine                Search (Postgres FTS)
```

**The dependency rule:** `adapters/*` and `api/` depend on `core/`; `core/`
depends on nothing external. This keeps the domain pure and makes adding a
platform a localized change (one new folder under `adapters/`).

## Module / repository layout

```text
prediction-market-aggregator/
├── packages/
│   ├── core/        # Normalized domain model, types, value objects (no I/O)
│   │   ├── src/model/    # Source, Event, Market, Outcome, PricePoint, CanonicalEvent
│   │   ├── src/ports/    # MarketSource interface + repository interfaces
│   │   └── src/services/ # Domain services (spread calc, normalization helpers)
│   ├── adapters/    # One folder per platform; depends only on core/ports
│   │   ├── polymarket/
│   │   └── manifold/
│   ├── ingestion/   # Orchestrator, schedulers, pollers, WS managers, upsert writers
│   ├── matching/    # Same-question matching engine (rules → embeddings → calibration)
│   ├── storage/     # Postgres/TimescaleDB repos, Redis cache, migrations
│   ├── api/         # REST + GraphQL + WebSocket fan-out gateway
│   └── alerts/      # Watchlist + movement alert engine
├── apps/
│   └── web/         # Next.js frontend (Recharts / lightweight-charts)
├── docs/            # Architecture docs, adapter authoring guide, data model
└── docker-compose.yml # Postgres+TimescaleDB, Redis for local dev
```

## Core components

| Component                      | Package      | Responsibility                                                                                                                               |
| ------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Adapter Layer (`MarketSource`) | `adapters/*` | Isolate every platform-specific concern (auth, endpoints, pagination, rate limits, payload shape, WS protocol) behind one uniform interface. |
| Ingestion Pipeline             | `ingestion`  | Orchestrate polling + streaming across adapters, write idempotently, stay resilient under upstream failure.                                  |
| Same-Question Matching Engine  | `matching`   | Group markets representing the same real-world question into a `CanonicalEvent`; flag resolution-criteria mismatches.                        |
| Storage Layer                  | `storage`    | Postgres relational metadata, TimescaleDB `price_point` hypertable, Redis hot cache + pub/sub.                                               |
| Outbound API Gateway           | `api`        | The system's own REST/GraphQL + WebSocket fan-out. The only surface clients use.                                                             |
| Alert / Watchlist Service      | `alerts`     | Track markets/canonical events; notify on threshold crossings and spread widening.                                                           |

## Data flow (summary)

1. **Metadata ingestion** — the orchestrator (`syncMarkets`) polls each adapter
   with keyset pagination, normalizes + validates payloads, and performs
   idempotent upserts keyed on `(source_id, external_id)`. A resilient fetch
   wrapper (`withRetry`) applies per-source token-bucket rate limiting and
   jittered exponential backoff; the cursor advances only after a page is
   durably written and never regresses on failure.
2. **Price streaming** — `classifyTier` splits markets into active vs. long-tail.
   Active markets stream over WebSocket (where the adapter declares
   `websocketPrices`); long-tail markets are polled on a slower cadence.
   `onTick` updates the Redis hot cache, appends to the TimescaleDB hypertable
   (idempotent on `(market_id, outcome_id, ts)`), and publishes to the fan-out.
   On WebSocket drop the manager reconnects with backoff and backfills the gap
   via `fetchPriceHistory` so curves have no holes.
3. **Same-question matching** — new/updated markets pass through a layered
   matcher (rules → semantic similarity → calibration → resolution alignment).
   Mismatched resolution criteria are flagged and excluded from signals.
4. **Serving** — the API gateway serves discovery, comparison, detail, and
   display-only signals over REST, and pushes live updates over its own
   WebSocket fan-out. The frontend talks only to this gateway.

See [`data-model.md`](./data-model.md) for the normalized schema (entities,
tables, idempotency keys, indexes, validation rules) that all of this is
computed on.

## Matching engine layers

The same-question matching engine (`packages/matching`) is layered easy→hard;
each layer narrows candidates for the next. Layer 4 is mandatory before any pair
contributes to a spread signal.

| Layer | What it does                                                                                                                                 | Module                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1     | Rules/metadata pre-filter: category, time window, subject-entity + threshold extraction.                                                     | `layer1-prefilter.ts`   |
| 2     | Semantic similarity: provider-agnostic embeddings + cosine scoring against a configurable threshold.                                         | `layer2-similarity.ts`  |
| 3     | Calibration gate: below-threshold/high-value pairs go to a human queue; decisions persist as labeled data (`match_label`).                   | `layer3-calibration.ts` |
| 4     | Resolution-criteria alignment: compares data source, cutoff (within tolerance), rounding; material divergence → `resolutionMismatch = true`. | `layer4-alignment.ts`   |

`computeSignals` (`signals.ts`) then ranks canonical events by their largest
cross-platform implied-probability gap, over **open, non-mismatched** markets
only, and tags every signal `executable: false` (display-only, Requirement 3.3).

## API surface

The outbound gateway (`packages/api`, Fastify) is the only surface clients use.
All upstream differences are hidden here and rate limiting is unified
(Requirement 9.1).

```text
GET  /api/markets                  discovery (category / q / status filter, sort)
GET  /api/markets/:id              detail (metadata + outcomes + latest price)
GET  /api/markets/:id/history      price-history time-series (range, interval)
GET  /api/markets/:id/trade-link   outbound source deep-link (navigation only)
GET  /api/sources                  registered platforms + capabilities
GET  /api/canonical-events         cross-platform groupings (optional category)
GET  /api/canonical-events/:id     same-question comparison view (mismatch flags)
GET  /api/signals                  display-only spread signals (ranked by gap)
GET  /healthz                      liveness probe

# User-scoped, authenticated (mounted only when the store is injected):
GET    /api/watchlist              POST /api/watchlist     DELETE /api/watchlist/:itemId
GET    /api/alerts                 POST /api/alerts        DELETE /api/alerts/:alertId

WS  /ws                            Redis-pub/sub-fed fan-out (market/canonical/alerts)
```

Latest prices on hot paths are served from the Redis hot cache. The trade-link
endpoint returns `{ url, executable: false }` and is the replaceable future
"one-click participate" slot (see
[`compliance-and-future-seams.md`](./compliance-and-future-seams.md)).

### WebSocket fan-out

`WS /ws` exposes `market`, `canonical`, and `alerts` channels. It is fed by
Redis pub/sub from the ingestion `onTick` path (and the alert engine), so
clients receive live price/spread/alert updates without ever connecting to an
upstream platform (Requirement 9.2). The fan-out is mounted only when a Redis
subscriber factory is injected.

### Gateway hardening (auth + rate limiting)

- **Unified rate limiting** (Requirement 9.3): one global per-client (IP) policy
  via `@fastify/rate-limit` applies across every public read endpoint; exceeding
  it yields `429` with the standard `x-ratelimit-*` / `retry-after` headers. The
  liveness probe opts out.
- **Input validation** (Requirement 9.3): every endpoint parses its query/path
  params through pure parsers at the edge; a `ValidationError` maps to `400`.
- **Authentication** (Requirement 9.4): user-scoped resources (watchlist,
  alerts) require auth via a `requireAuth` preHandler backed by an injectable
  `authenticate` port. Safe-by-default: when no authenticator is configured,
  user-scoped routes are **closed** (`401`), and each operation is scoped to the
  authenticated `userId` so a user only ever touches their own data.

## Alert / watchlist service

`packages/alerts` evaluates user alert rules against incoming price/spread
updates and dispatches notifications over the gateway's `alerts` WebSocket
channel. Two rule types are supported: `thresholdCross` (a market's probability
crosses a threshold) and `spreadWiden` (a canonical event's spread widens beyond
a minimum gap). Watchlist and alert-rule persistence (with duplicate prevention
for watchlist items) lives in `packages/storage`.

## Frontend (`apps/web`)

A Next.js (App Router) + React 18 app. It talks **only** to the project's own
API gateway through the single typed client in `apps/web/src/lib/api-client.ts`
(configured via `NEXT_PUBLIC_API_BASE_URL`), never to an upstream platform
(Requirement 9.1). It mirrors the gateway's DTO shapes locally
(`apps/web/src/lib/dto.ts`), so the only coupling is the HTTP contract.

Pages: discovery list (filters, full-text search, sort), market detail with a
price-history curve, the side-by-side comparison view (with mismatch flags), the
display-only signals list (with a "Go trade" deep-link button), and watchlist
management. A WebSocket fan-out client (`apps/web/src/lib/fanout-client.ts` +
`useFanout.ts`) subscribes for live price/spread/alert updates.

The app is intentionally isolated from the backend's `tsc --build`
project-reference graph (it needs DOM/JSX/bundler resolution): it is type-checked
on its own via `npm run typecheck` (`tsc --noEmit`) and built with `next build`.
Its tests run under the root `npm test` via the `web` Vitest project (jsdom +
Testing Library). See the [README](../README.md#frontend-appsweb) for the full
monorepo-integration decision.

## Correctness properties (P1–P9)

The design's correctness properties are encoded as `fast-check` property-based
tests, each mapped to a requirement. They run as part of `npm test`. See
[`correctness-properties.md`](./correctness-properties.md) for the full
property → test-file → requirement mapping and what each guarantees.

| #   | Property                | Where                                                                   |
| --- | ----------------------- | ----------------------------------------------------------------------- |
| P1  | Idempotent ingestion    | `storage/.../idempotent-ingestion.property.test.ts`                     |
| P2  | Idempotent price writes | `storage/.../idempotent-price-writes.property.test.ts`                  |
| P3  | Probability bounds      | `core/src/model/normalization.property.test.ts`                         |
| P4  | No false arbitrage      | `matching/src/no-false-arbitrage.property.test.ts`                      |
| P5  | Display-only invariant  | `matching/src/display-only.property.test.ts`                            |
| P6  | Cursor monotonicity     | `ingestion/src/cursor-monotonicity.property.test.ts`                    |
| P7  | Capability gating       | `ingestion/src/capability-gating.property.test.ts`                      |
| P8  | Adapter isolation       | structural — one folder per adapter; verified by the layout + P7 gating |
| P9  | Comparison symmetry     | `matching/src/comparison-symmetry.property.test.ts`                     |

## Local development

```bash
# 1. Install workspace dependencies
npm install

# 2. Start datastores (Postgres + TimescaleDB, Redis)
docker compose up -d

# 3. Build, lint, and test
npm run build
npm run lint
npm test
```

See [`.env.example`](../.env.example) for the connection strings that match the
`docker-compose.yml` defaults. Migrations are applied with
`npm run migrate --workspace @pma/storage` (see
[`packages/storage/migrations/README.md`](../packages/storage/migrations/README.md)).

## Documentation map

- [`architecture.md`](./architecture.md) — this document: system orientation,
  layers, data flow, matching layers, API surface, hardening, correctness
  properties.
- [`data-model.md`](./data-model.md) — the normalized schema: entities, storage
  tables, idempotency keys, indexes, validation rules.
- [`adapter-authoring-guide.md`](./adapter-authoring-guide.md) — how to add a
  new platform by implementing the `MarketSource` interface.
- [`correctness-properties.md`](./correctness-properties.md) — the P1–P9
  property-based guarantees mapped to their test files and requirements.
- [`compliance-and-future-seams.md`](./compliance-and-future-seams.md) — v1
  read-only posture and the reserved future-phase compliance seams.
- [`zh/`](./zh/README.md) — 中文文档（Chinese translation of this documentation set）.
- [`.kiro/specs/prediction-market-aggregator/design.md`](../.kiro/specs/prediction-market-aggregator/design.md)
  — the authoritative detailed design.

## Read-only guarantee (v1)

Spread/arbitrage output is informational only. Every signal carries
`executable: false`, and no execution or order-placement path exists in v1. See
the design's "Compliance Considerations" for the reserved future seams, and
[`docs/compliance-and-future-seams.md`](./compliance-and-future-seams.md) for
how v1's read-only posture and the reserved compliance seams (per-source
redistribution policy, user-region dimension, and the replaceable trade-link
slot) are recorded without implementing any regulated logic.
