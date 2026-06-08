-- packages/storage/migrations/002_compliance_seams.sql
--
-- Future-phase COMPLIANCE SEAMS (reserved, NOT implemented in v1).
--
-- This migration only RESERVES schema seams for later regulated phases. v1 is
-- strictly read-only: there is NO trade routing, geofencing, order placement,
-- fund routing, or execution anywhere in the system (Requirement 12.1). The
-- columns/tables added here are inert placeholders — nothing in v1 reads or
-- gates on them. See docs/compliance-and-future-seams.md and design.md
-- "Compliance Considerations".
--
-- What this reserves:
--   1. source.redistribution_policy — a per-source recorded data-redistribution
--      policy, so future commercial/B2B use can gate exposure per source
--      (Requirement 12.2). RECORDED ONLY; v1 never enforces it.
--   2. user_profile.region — a reserved user-region dimension for future
--      regulated geo-partitioning (Requirement 12.3). RESERVED ONLY; v1
--      implements NO routing/geofencing logic against it.
--
-- Per the migrations README, this is a new file with a higher number; the
-- already-applied 001_core.sql is never edited.

-- ---------------------------------------------------------------------------
-- 1. source.redistribution_policy — per-source data-redistribution policy.
--
-- Reserved for future commercial/B2B exposure gating (Requirement 12.2).
-- JSONB so a policy can be RECORDED without committing the schema to any
-- particular shape or to any enforcement logic. Defaults to '{}'::jsonb
-- ("no policy recorded"). Example future contents (NOT interpreted in v1):
--   {"b2b": "restricted", "attribution_required": true, "notes": "see ToS"}
--
-- v1 BEHAVIOUR: this column is never read and never gates any response. It is
-- a recorded placeholder only.
-- ---------------------------------------------------------------------------
ALTER TABLE source
  ADD COLUMN redistribution_policy JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN source.redistribution_policy IS
  'RESERVED future-phase seam (Req 12.2): per-source data-redistribution policy, '
  'recorded for future commercial/B2B exposure gating. NOT enforced in v1 — no '
  'code reads or gates on this column.';

-- ---------------------------------------------------------------------------
-- 2. user_profile — reserved user-region dimension.
--
-- Reserves a user-region dimension (Requirement 12.3) for future regulated
-- geo-partitioning (e.g. routing US users down a CFTC-compliant path and other
-- regions down the crypto-native path). A standalone table is the LEAST-
-- INVASIVE reservation: it touches no existing user-scoped table
-- (watchlist_item / alert_rule keep their shape) and adds no foreign keys (v1
-- has no users table — user_id is an opaque UUID supplied by auth).
--
-- `region` is NULLABLE and uninterpreted: v1 implements NO routing, geofencing,
-- or region-based gating of any kind. The column exists solely so a later
-- regulated phase can populate and partition on it without a schema rewrite.
-- ---------------------------------------------------------------------------
CREATE TABLE user_profile (
  user_id    UUID PRIMARY KEY,                 -- opaque auth-provided id (no FK in v1)
  region     TEXT,                             -- RESERVED: ISO-ish region code; NULL = unset
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_profile IS
  'RESERVED future-phase seam (Req 12.3): reserves a user-region dimension for '
  'future regulated geo-partitioning. v1 implements NO routing/geofencing logic.';

COMMENT ON COLUMN user_profile.region IS
  'RESERVED future-phase seam (Req 12.3): user region for future geo-partitioning. '
  'NULLABLE and uninterpreted — v1 has no region routing or geofencing logic.';
