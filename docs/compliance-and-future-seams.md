# Compliance and Future-Phase Seams

> Status: living document. The authoritative design lives in
> [`.kiro/specs/prediction-market-aggregator/design.md`](../.kiro/specs/prediction-market-aggregator/design.md)
> ("Compliance Considerations" and "Future Evolution").

This document records the compliance posture of **v1** and the seams the
architecture **reserves** for later regulated phases. The guiding principle:
v1 is structurally read-only, and every future-regulated capability is a
_reserved seam_ — designed-for, but **not implemented** and **not reachable**.

## v1 is strictly read-only (Requirement 12.1)

v1 exposes **no** trading, order-placement, fund-routing, or execution
capability. Concretely:

- The system holds no trading credentials and opens no custody/execution code
  path. The largest class of risk (custody/execution) is structurally absent.
- Spread / arbitrage output is **display-only**: every signal carries
  `executable: false`, enforced in the API contract.
- The only outbound action is a **navigation** deep-link to the source platform
  (see [the trade-link seam](#trade-link-replacement-seam-requirement-63)).

Nothing in this document changes that. The seams below are inert placeholders:
no v1 code reads or gates on them.

## Per-source redistribution policy seam (Requirement 12.2)

Before commercial/B2B use, each platform's Terms of Service for data
redistribution must be respected, and exposure may need to be gated per source.

**Reserved seam:** `source.redistribution_policy` — a `JSONB` column
(migration [`002_compliance_seams.sql`](../packages/storage/migrations/002_compliance_seams.sql),
default `'{}'::jsonb`). It lets a policy be **recorded** per source without
committing the schema to any particular shape or to any enforcement logic.
Example future contents (not interpreted in v1):

```json
{ "b2b": "restricted", "attribution_required": true, "notes": "see ToS" }
```

**v1 behaviour:** the column is **recorded only**. No code reads it and no
response is gated on it. A later commercial/B2B phase adds the gating layer; the
column is already there so that change needs no schema rewrite.

It is optionally surfaced as a read-only field on the source repository record
(`SourceRecord.redistributionPolicy`) for inspection/admin tooling — still never
used to gate any response in v1.

## User-region dimension seam (Requirement 12.3)

Some future regulated phases require user **geo-partitioning** (e.g. Polymarket
has US geo-restrictions; a later phase might route US users down a
CFTC-compliant path and other regions down the crypto-native path).

**Reserved seam:** a `user_profile` table with a nullable `region` column
(migration [`002_compliance_seams.sql`](../packages/storage/migrations/002_compliance_seams.sql)).
A standalone table is the least-invasive reservation: it leaves the existing
user-scoped tables (`watchlist_item`, `alert_rule`) untouched and adds no
foreign keys (v1 has no users table — `user_id` is an opaque auth-provided
UUID).

**v1 behaviour:** the `region` column is **reserved and uninterpreted**. v1
implements **no** routing, geofencing, or region-based gating of any kind. The
dimension exists purely so a later regulated phase can populate and partition on
it without a schema rewrite.

## Trade-link replacement seam (Requirement 6.3)

The "Go trade" action is the future **one-click participate** slot. In v1 it is
a navigation deep-link; the architecture reserves the exact slot so a later
execution phase can plug in **without changing the discovery, comparison, or
signals contracts**.

**How the seam works today:**

- `GET /api/markets/{id}/trade-link` returns `{ url, executable: false }`.
- The handler depends on an injected `TradeLinkResolver` port
  (`GatewayDeps.tradeLink`). The default registry-backed resolver lives in
  [`packages/api/src/trade-link.ts`](../packages/api/src/trade-link.ts) and is
  **pure** (no I/O): it maps a market's stored `(sourceKey, externalId, slug?)`
  to a public source URL and **always** sets `executable: false`
  (Requirements 6.2, 12.1).
- Adding a platform's deep-link = adding one builder entry in the resolver's
  registry. The route, handler, and DTO never change.

**How a future phase replaces it:**

- A future "one-click participate" flow swaps in a **different**
  `TradeLinkResolver` via `GatewayDeps.tradeLink` — e.g. one that returns an
  executable action backed by the operator's own wallet/exchange.
- Because discovery, comparison, and signals never depend on the trade-link
  resolver, that swap touches **only** the injected resolver. The other
  contracts are unaffected (Requirement 6.3).
- That execution phase is where regulated business begins; it requires a
  dedicated compliance/geofencing design (using the
  [region seam](#user-region-dimension-seam-requirement-123) above) and is
  explicitly **out of scope** for v1. The seam exists; the logic does not.

## Summary

| Seam                    | Where                               | v1 status                       | Reserved for                          |
| ----------------------- | ----------------------------------- | ------------------------------- | ------------------------------------- |
| Read-only invariant     | API contracts (`executable: false`) | Enforced                        | — (Req 12.1)                          |
| `redistribution_policy` | `source` column (JSONB)             | Recorded only, never gated      | B2B/commercial gating (Req 12.2)      |
| User `region`           | `user_profile.region` (nullable)    | Reserved, uninterpreted         | Regulated geo-partitioning (Req 12.3) |
| Trade-link resolver     | `GatewayDeps.tradeLink` port        | Navigation only, non-executable | One-click participate (Req 6.3)       |
