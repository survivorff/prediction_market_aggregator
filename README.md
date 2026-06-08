# Prediction Market Aggregator

> 中文版本：[`README.zh-CN.md`](./README.zh-CN.md) · 中文文档：[`docs/zh/`](./docs/zh/README.md)

An independent, **read-only** comparison dashboard and data service that unifies
prediction markets across multiple platforms (v1: Polymarket, Manifold, and
Predict.fun). It
normalizes cross-platform market data into a single schema, lets users discover
the same real-world question across venues, compares implied probabilities side
by side, and surfaces the largest cross-platform price gaps as **display-only**
signals.

> v1 is strictly read-only: **no order placement, fund routing, or execution.**
> The outbound "Go trade" deep-link reserves the slot for a future "one-click
> participate" flow without a rewrite.

## Repository layout

This is a TypeScript monorepo using **npm workspaces**.

```text
packages/
  core/        # Normalized domain model, types, ports (no I/O)
  adapters/    # Per-platform MarketSource implementations (polymarket, manifold, predictfun)
  ingestion/   # Orchestrator, schedulers, pollers, WS managers, upsert writers + the runner
  matching/    # Same-question matching engine
  storage/     # Postgres/TimescaleDB repos, Redis cache, migrations
  api/         # REST + WebSocket fan-out gateway
  alerts/      # Watchlist + movement alert engine
apps/
  web/         # Next.js frontend
docs/          # Architecture + adapter authoring guides
```

See [`docs/architecture.md`](docs/architecture.md) for the full picture and
[`docs/adapter-authoring-guide.md`](docs/adapter-authoring-guide.md) to add a
platform.

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — system orientation: layers,
  data flow, ingestion, matching, API surface, hardening, frontend.
- [`docs/data-model.md`](docs/data-model.md) — the normalized domain model,
  validation rules, storage schema (migrations, idempotency keys, the
  TimescaleDB hypertable, indexes/FTS), and the Redis hot cache + pub/sub.
- [`docs/adapter-authoring-guide.md`](docs/adapter-authoring-guide.md) — add a
  new platform by implementing the `MarketSource` interface in one folder.
- [`docs/correctness-properties.md`](docs/correctness-properties.md) — the P1–P9
  property-based guarantees mapped to their test files and requirements.
- [`docs/compliance-and-future-seams.md`](docs/compliance-and-future-seams.md) —
  v1 read-only posture and the reserved future-phase compliance seams.
- [`ROADMAP.md`](ROADMAP.md) — production-readiness backlog and the longer-term
  direction (real-time data, wallet/trading, copy-trading).
- [`docs/zh/system-design.md`](docs/zh/system-design.md) — 中文「技术 + 业务」
  整合系统设计总览（mermaid 全景图）。

## Getting started

Requires Node.js >= 20 and Docker (for local datastores).

```bash
# Install workspace dependencies
npm install

# Start Postgres + TimescaleDB and Redis
docker compose up -d

# Apply database migrations (version-tracked, idempotent)
npm run migrate --workspace @pma/storage

# Build all packages
npm run build

# Lint and run the test suite (unit + property-based via fast-check)
npm run lint
npm test
```

### Run the services

```bash
# Seed a small demo dataset (idempotent) — gives the gateway something to serve
npm run seed --workspace @pma/api

# API gateway (REST + WebSocket fan-out) on :4000
npm run start --workspace @pma/api

# Web frontend on :3000 (talks only to the gateway)
npm run dev --workspace @pma/web

# OR: the ingestion runner — pulls REAL data from the upstream adapters
# (Polymarket / Manifold / Predict.fun). Needs outbound network.
npm run start --workspace @pma/ingestion
```

See [`.env.example`](.env.example) for all configuration (connection strings,
ports, CORS origin, ingestion cadences, the Predict.fun API key).

### Deploy with Docker

A multi-stage [`Dockerfile`](Dockerfile) builds the backend services and
[`apps/web/Dockerfile`](apps/web/Dockerfile) builds the frontend.
[`docker-compose.prod.yml`](docker-compose.prod.yml) wires the datastores, a
one-shot migration job, the API gateway, the ingestion runner, and the web app:

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## Tooling

- **Language:** TypeScript (project references across workspaces)
- **Tests:** [Vitest](https://vitest.dev) + [fast-check](https://fast-check.dev) for property-based testing
- **Lint / format:** ESLint (flat config) + Prettier
- **Datastores:** Postgres + TimescaleDB, Redis (via `docker-compose.yml`)

## Frontend (`apps/web`)

The web app is a [Next.js](https://nextjs.org) (App Router) + React 18 +
[Recharts](https://recharts.org) project. It renders the unified discovery list
(filters, full-text search, sort) and the market detail page with a
price-history curve.

It talks **only** to the project's own API gateway (`@pma/api`) over HTTP, never
to an upstream platform (Requirement 9.1). The single chokepoint is the typed
client in `apps/web/src/lib/api-client.ts`, configured via
`NEXT_PUBLIC_API_BASE_URL` (default `http://localhost:4000`).

```bash
cd apps/web
npm run dev        # local dev server (http://localhost:3000)
npm run build      # next build (production)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint (React Hooks + Next core-web-vitals rules)
```

### Monorepo integration decision

`apps/web` is **intentionally isolated** from the backend's
`tsc --build` project-reference graph:

- It is **removed from the root `tsconfig.json` `references`**, and its
  `tsconfig.json` does **not** extend `tsconfig.base.json`. A Next.js app needs
  DOM libs, JSX, and bundler module resolution, which are incompatible with the
  backend packages' strict `NodeNext`/`composite` build. The root
  `npm run build` (`tsc --build`) therefore compiles only the `packages/*`
  backend; the web app is type-checked on its own via `npm run typecheck`
  (`tsc --noEmit`) and `next build`.
- It is **excluded from the root `eslint .`** (`apps/web/**` is ignored) and has
  its own flat ESLint config layering the React Hooks + Next.js rules. Run it
  with `npm --workspace @pma/web run lint`.
- Tests run under the **root `npm test`** via `vitest.workspace.ts`, which
  defines a `node` project (the `packages/*` backend) and a `web` project
  (jsdom + Testing Library for `apps/web`), so a single command exercises both.
- The frontend has **no workspace dependency** on any server package; it mirrors
  the gateway's DTO shapes locally (`apps/web/src/lib/dto.ts`) so the only
  coupling is the HTTP contract.

## License

MIT
