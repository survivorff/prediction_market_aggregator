-- packages/storage/migrations/001_core.sql
--
-- Core relational + time-series schema for the Prediction Market Aggregator.
--
-- Postgres holds relational metadata; `price_point` is a TimescaleDB hypertable
-- for time-series prices. Redis (separate) holds the hot latest-price cache and
-- pub/sub. See design.md "Storage Schemas" and Requirement 10 (Normalized Data
-- Model and Storage).
--
-- Conventions:
--   * (source_id, external_id) is the idempotency key for ingested entities
--     (Requirement 10.1).
--   * price_point is keyed (market_id, outcome_id, ts) for idempotent writes
--     (Requirement 10.2).
--   * `category` uses the normalized Category union from @pma/core
--     (politics | crypto | sports | economics | tech | other); anything that
--     does not fit maps to 'other'.
--
-- This migration is idempotent at the extension/level statements but assumes a
-- fresh schema for the table DDL (the runner tracks applied files; see README).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

-- gen_random_uuid() for UUID primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- TimescaleDB for the price_point hypertable (bundled in the
-- timescale/timescaledb image used by docker-compose.yml).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- source — a registered prediction-market platform.
-- ---------------------------------------------------------------------------
CREATE TABLE source (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT NOT NULL UNIQUE, -- "polymarket" | "manifold"
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('onchain', 'cex', 'regulated')),
  base_currency TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- canonical_event — a cross-platform real-world question the matching engine
-- links platform events/markets onto.
-- ---------------------------------------------------------------------------
CREATE TABLE canonical_event (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  category        TEXT NOT NULL
                    CHECK (category IN ('politics', 'crypto', 'sports', 'economics', 'tech', 'other')),
  subject_entity  TEXT,
  threshold_value NUMERIC,
  target_date     TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- event — a platform-native grouping of related markets.
-- ---------------------------------------------------------------------------
CREATE TABLE event (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id          UUID NOT NULL REFERENCES source(id),
  external_id        TEXT NOT NULL,
  canonical_event_id UUID REFERENCES canonical_event(id),
  title              TEXT NOT NULL,
  category           TEXT NOT NULL
                       CHECK (category IN ('politics', 'crypto', 'sports', 'economics', 'tech', 'other')),
  end_date           TIMESTAMPTZ,
  UNIQUE (source_id, external_id) -- idempotency key
);

-- ---------------------------------------------------------------------------
-- market — the smallest unit of aggregation (a single question).
--
-- `category` is denormalized from event/canonical_event for fast discovery
-- filtering (see the idx_market_category_status index below).
-- `resolution_mismatch` is set by matching Layer 4 when resolution criteria
-- materially diverge.
-- ---------------------------------------------------------------------------
CREATE TABLE market (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           UUID NOT NULL REFERENCES source(id),
  event_id            UUID REFERENCES event(id),
  canonical_event_id  UUID REFERENCES canonical_event(id),
  external_id         TEXT NOT NULL,
  question            TEXT NOT NULL,
  category            TEXT NOT NULL
                        CHECK (category IN ('politics', 'crypto', 'sports', 'economics', 'tech', 'other')),
  status              TEXT NOT NULL CHECK (status IN ('open', 'closed', 'resolved')),
  volume_24h          NUMERIC,
  liquidity           NUMERIC,
  spread              NUMERIC CHECK (spread >= 0),
  resolution_criteria JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolution_mismatch BOOLEAN NOT NULL DEFAULT FALSE, -- set by matching Layer 4
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id) -- idempotency key
);
CREATE INDEX idx_market_canonical ON market(canonical_event_id);
-- Discovery filter index: category is denormalized onto market so this is valid.
CREATE INDEX idx_market_category_status ON market(category, status);
-- Full-text search over the question text for discovery search.
CREATE INDEX idx_market_question_fts ON market USING GIN (to_tsvector('english', question));

-- ---------------------------------------------------------------------------
-- outcome — a single outcome token/leg of a market (e.g. Yes/No).
-- ---------------------------------------------------------------------------
CREATE TABLE outcome (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  token_id     TEXT, -- on-chain outcome token; null off-chain
  implied_prob NUMERIC CHECK (implied_prob BETWEEN 0 AND 1),
  last_price   NUMERIC CHECK (last_price BETWEEN 0 AND 1),
  UNIQUE (market_id, label)
);

-- ---------------------------------------------------------------------------
-- price_point — TimescaleDB hypertable for time-series prices.
--
-- Keyed (market_id, outcome_id, ts) so overlapping live ticks and reconnect
-- backfill collapse to exactly one row (Requirement 10.2, Property 2).
-- ---------------------------------------------------------------------------
CREATE TABLE price_point (
  market_id  UUID NOT NULL REFERENCES market(id) ON DELETE CASCADE,
  outcome_id UUID NOT NULL REFERENCES outcome(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  price      NUMERIC NOT NULL CHECK (price BETWEEN 0 AND 1),
  volume     NUMERIC,
  PRIMARY KEY (market_id, outcome_id, ts) -- idempotent price writes
);
SELECT create_hypertable('price_point', 'ts');

-- ---------------------------------------------------------------------------
-- sync_cursor — ingestion cursors for crash-safe keyset pagination.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_cursor (
  source_id  UUID NOT NULL REFERENCES source(id),
  entity     TEXT NOT NULL CHECK (entity IN ('event', 'market')),
  cursor     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, entity)
);

-- ---------------------------------------------------------------------------
-- watchlist_item — user-scoped watched market/canonical event.
-- ---------------------------------------------------------------------------
CREATE TABLE watchlist_item (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('market', 'canonicalEvent')),
  target_id   UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_type, target_id) -- duplicate prevention
);

-- ---------------------------------------------------------------------------
-- alert_rule — user-defined threshold/spread alert rules.
-- ---------------------------------------------------------------------------
CREATE TABLE alert_rule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('market', 'canonicalEvent')),
  target_id   UUID NOT NULL,
  rule_type   TEXT NOT NULL CHECK (rule_type IN ('thresholdCross', 'spreadWiden')),
  params      JSONB NOT NULL, -- { threshold: 0.5 } | { minGap: 0.05 }
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- match_label — human/auto calibration decisions used as labeled training data
-- for the matching engine (Requirement 11.4, matching Layer 3).
-- ---------------------------------------------------------------------------
CREATE TABLE match_label (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_a_id  UUID NOT NULL REFERENCES market(id),
  market_b_id  UUID NOT NULL REFERENCES market(id),
  decision     TEXT NOT NULL CHECK (decision IN ('same', 'different')),
  similarity   NUMERIC CHECK (similarity BETWEEN 0 AND 1),
  labeled_by   TEXT NOT NULL CHECK (labeled_by IN ('human', 'auto')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (market_a_id, market_b_id)
);
