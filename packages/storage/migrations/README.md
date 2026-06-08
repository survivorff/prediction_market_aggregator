# Database migrations

SQL schema migrations for `@pma/storage` (Postgres 16 + TimescaleDB). These
define the normalized data model from design.md "Storage Schemas" and
Requirement 10 (Normalized Data Model and Storage).

## Files

- `001_core.sql` — core schema: `source`, `canonical_event`, `event`, `market`
  (with denormalized `category` + `resolution_mismatch`), `outcome`, the
  `price_point` TimescaleDB hypertable, `sync_cursor`, `watchlist_item`,
  `alert_rule`, and `match_label`. Creates the `(category, status)` discovery
  index and the full-text-search GIN index on `market.question`.
- `002_compliance_seams.sql` — RESERVED future-phase compliance seams (no v1
  logic). Adds `source.redistribution_policy` (JSONB, default `'{}'`) to
  **record** a per-source data-redistribution policy for future commercial/B2B
  exposure gating (Req 12.2), and a `user_profile` table with a nullable
  `region` column to **reserve** a user-region dimension for future regulated
  geo-partitioning (Req 12.3). Both are inert placeholders: v1 implements no
  trade routing, geofencing, or gating against them (Req 12.1). See
  [`docs/compliance-and-future-seams.md`](../../../docs/compliance-and-future-seams.md).
- `apply.sh` — dependency-free runner (uses the standard `psql` client).

Migrations are plain SQL applied in lexicographic filename order. New
migrations should be added as `NNN_description.sql` with a higher number; never
edit an already-applied migration.

## Idempotency keys

- Ingested entities (`event`, `market`) are unique on `(source_id, external_id)`.
- `price_point` is keyed `(market_id, outcome_id, ts)` so duplicate/overlapping
  ticks collapse to one row.

## Applying migrations

### 1. Start the datastores

From the repo root:

```bash
docker compose up -d
```

This brings up `timescale/timescaledb:2.17.2-pg16` on port 5432
(`POSTGRES_USER=pma`, `POSTGRES_PASSWORD=pma`, `POSTGRES_DB=pma`) and Redis 7.

### 2. Run the migrations

The runner reads `DATABASE_URL` (defaults to the docker-compose dev value
`postgres://pma:pma@localhost:5432/pma`). From the repo root:

```bash
npm run migrate --workspace @pma/storage
```

or directly:

```bash
DATABASE_URL=postgres://pma:pma@localhost:5432/pma \
  packages/storage/migrations/apply.sh
```

The runner creates a `schema_migrations` bookkeeping table and skips files that
have already been applied, so it is safe to re-run. Each migration runs inside a
single transaction; if it fails, nothing is committed.

### Applying without a local `psql`

If you do not have the `psql` client installed locally, run it inside the
Postgres container instead:

```bash
docker compose exec -T postgres \
  psql -U pma -d pma -v ON_ERROR_STOP=1 \
  < packages/storage/migrations/001_core.sql
```

## Notes

- The `timescaledb` extension is bundled in the docker image; `001_core.sql`
  runs `CREATE EXTENSION IF NOT EXISTS timescaledb;` and `pgcrypto` (for
  `gen_random_uuid()`).
- Redis holds the hot latest-price cache and pub/sub channels; there are no SQL
  migrations for Redis.
