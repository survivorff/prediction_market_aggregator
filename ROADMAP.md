# Roadmap

> Status of the codebase: a clean, well-tested **read-only v1** (unified
> discovery, same-question comparison, display-only spread signals, watchlist +
> alerts, a live ingestion runner for Polymarket / Manifold / Predict.fun). This
> document tracks what remains to reach a production-grade first release and the
> longer-term direction of the aggregator.

See [`docs/zh/system-design.md`](docs/zh/system-design.md) for the integrated
technical + business design, and
[`docs/architecture.md`](docs/architecture.md) for the English overview.

## Where v1 stands today

- **Adapters**: Polymarket (Gamma + CLOB + WebSocket), Manifold (REST), and
  Predict.fun (BNB-Chain CLOB, REST) behind one `MarketSource` port.
- **Ingestion runner** (`@pma/ingestion`): periodic idempotent metadata sync +
  resilient price streaming (WebSocket for Polymarket, polling for the rest) +
  a bounded same-question matching pass that forms cross-platform
  `CanonicalEvent`s — all proven against the real upstream APIs.
- **API gateway** (`@pma/api`): REST + WebSocket fan-out, unified rate limiting,
  input validation, injectable auth, CORS.
- **Web** (`apps/web`): Next.js discovery / comparison / signals / watchlist.
- **Quality**: layered architecture, 848 tests incl. the P1–P9 property tests.

## Production-readiness backlog (first release)

Priority order toward a usable, production-grade v1.

### P0 — release blockers

1. **~~Wire the matching engine into the runner.~~** ✅ Done. The runner now runs
   a bounded same-question matching pass each cycle (`runMatchingPass` →
   `matchMarket`: prefilter → similarity → calibration → alignment → link),
   forming cross-platform `CanonicalEvent`s from live data. **Remaining quality
   work**: the default embedding provider is a deterministic offline
   bag-of-words model (`BagOfWordsEmbeddingProvider`) — swap in a real model
   (hosted or local sentence-embeddings) behind the `EmbeddingProvider` port for
   production-grade match recall/precision. Matching is restricted to
   cross-source pairs (an aggregator links across venues); the calibration queue
   + label store are in-memory (auto-confirmed links persist; durable
   queue/`match_label` wiring is a follow-up).
2. **~~Category enrichment.~~** ✅ Done. Adapters now derive a category hint
   (`inferCategory` over platform tags / group slugs / category slug + the
   question text) onto the optional `NormalizedMarket.category`, which the
   ingestion upsert projects onto the denormalized `market.category` column.
   Discovery category filtering and the matching candidate pre-filter now work
   on live data (e.g. World Cup → `sports`, elections → `politics`). **Remaining
   quality work**: a keyword classifier leaves niche questions as `'other'`;
   improve recall with platform category-tag mapping or a learned classifier.
3. **Real authentication + secrets.** Replace the dev bearer token with a real
   identity provider behind the existing `authenticate` port; move all
   credentials (DB, Redis, upstream API keys) into a secrets manager. Remove the
   insecure `dev-token` default in production.
4. **Deployment & CI/CD.** Dockerfiles + `docker-compose.prod.yml` and a CI
   workflow are in place; still needed: a real registry/release pipeline,
   environment promotion, and infra-as-code for the target platform.

### P1 — important

5. **Observability**: structured logging, metrics (Prometheus), tracing, error
   tracking (e.g. Sentry), dashboards + alerting.
6. **Shared rate limiting**: the gateway limiter is per-instance/in-memory;
   move to a Redis-backed limiter for multi-instance deployments.
7. **Incremental sync**: the runner full-resyncs every cycle and rebuilds
   WebSocket subscriptions each cycle. Add `updatedSince` incremental sync,
   per-source cadence, and stream-lifecycle diffing.
8. **Datastore scaling**: TimescaleDB retention + compression policies for
   `price_point`, index review at scale, connection-pool tuning, backups/DR.
9. **Discovery UX**: source filter, pagination UI, and search relevance for a
   catalog of tens of thousands of markets.

### P2 — hardening

10. Readiness/liveness probes that check DB + Redis; TLS termination; security
    headers; request size limits; DoS protection.
11. Non-binary outcome handling in the price path (Predict.fun markets use
    labels like `Over/Over2` / team names, not just `Yes/No`).
12. Compliance: per-source data-redistribution ToS (the reserved
    `redistribution_policy` seam) and upstream rate-limit etiquette.

## Longer-term direction (beyond v1)

The aggregator's north star is a full cross-platform prediction-market hub. Each
of these is a significant initiative to be planned on its own:

- **Real-time, precise market data.** Order-book depth and trade feeds across
  venues, normalized; sub-second price/spread updates; historical backfill and
  candle aggregation; data-quality SLAs.
- **Wallet & trading integration.** This is where the reserved trade-link seam
  becomes executable. Support custodial and self-custodial flows:
  self-custodial signing (EOA / smart wallets on Polygon, BNB Chain, …) and, for
  regulated venues, a compliant custodial path. Order placement, fund routing,
  and cross-platform execution are all **regulated** — each needs a dedicated
  compliance/geofencing design (the reserved `user_profile.region` seam).
- **Personalized subscriptions & copy-trading.** User-defined watch/alert rules
  at scale, push/email/webhook delivery, follow-a-trader and copy-trade
  strategies, portfolio tracking, and the execution plumbing they imply.
- **More venues.** Kalshi, Limitless, Metaculus, and others — each a localized
  `adapters/*` addition (Requirement 8 / Property P8 keep this isolated).

> v1 is deliberately read-only: no order placement, fund routing, or execution.
> The architecture reserves the seams for the above without requiring a rewrite —
> see [`docs/compliance-and-future-seams.md`](docs/compliance-and-future-seams.md).
