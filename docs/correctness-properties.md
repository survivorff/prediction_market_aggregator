# Correctness Properties (P1–P9)

> Status: living document. The authoritative definitions live in
> [`.kiro/specs/prediction-market-aggregator/design.md`](../.kiro/specs/prediction-market-aggregator/design.md)
> ("Correctness Properties"). This document maps each property to the test that
> encodes it so the property-based guarantees are discoverable.

The design states nine properties that should hold for all valid inputs. Eight
of them are encoded as **property-based tests** using
[`fast-check`](https://fast-check.dev); the ninth (adapter isolation, P8) is a
structural guarantee verified by the architecture + the capability-gating test
rather than a standalone PBT. Every property test is annotated in-source with a
`**Validates: Requirements X.Y**` link back to the acceptance criteria.

## Property → test mapping

| #   | Property                | Validates | Encoded by                                                                                                                                                    | Kind       |
| --- | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| P1  | Idempotent ingestion    | Req 7.1   | [`packages/storage/src/repositories/idempotent-ingestion.property.test.ts`](../packages/storage/src/repositories/idempotent-ingestion.property.test.ts)       | PBT        |
| P2  | Idempotent price writes | Req 7.2   | [`packages/storage/src/repositories/idempotent-price-writes.property.test.ts`](../packages/storage/src/repositories/idempotent-price-writes.property.test.ts) | PBT        |
| P3  | Probability bounds      | Req 1.3   | [`packages/core/src/model/normalization.property.test.ts`](../packages/core/src/model/normalization.property.test.ts)                                         | PBT        |
| P4  | No false arbitrage      | Req 3.2   | [`packages/matching/src/no-false-arbitrage.property.test.ts`](../packages/matching/src/no-false-arbitrage.property.test.ts)                                   | PBT        |
| P5  | Display-only invariant  | Req 3.3   | [`packages/matching/src/display-only.property.test.ts`](../packages/matching/src/display-only.property.test.ts)                                               | PBT        |
| P6  | Cursor monotonicity     | Req 7.3   | [`packages/ingestion/src/cursor-monotonicity.property.test.ts`](../packages/ingestion/src/cursor-monotonicity.property.test.ts)                               | PBT        |
| P7  | Capability gating       | Req 7.4   | [`packages/ingestion/src/capability-gating.property.test.ts`](../packages/ingestion/src/capability-gating.property.test.ts)                                   | PBT        |
| P8  | Adapter isolation       | Req 8.1   | structural (module boundaries) + reinforced by P7's capability-gating test                                                                                    | structural |
| P9  | Comparison symmetry     | Req 2.2   | [`packages/matching/src/comparison-symmetry.property.test.ts`](../packages/matching/src/comparison-symmetry.property.test.ts)                                 | PBT        |

The eight PBT files correspond to spec tasks 2.3 (P3), 3.4 (P1), 3.5 (P2), 4.5
(P7), 5.5 (P6), 6.6 (P4), 6.7 (P5), and 6.8 (P9).

## What each property guarantees

- **P1 — Idempotent ingestion.** Repeating a sync over the same upstream state
  leaves row count and content unchanged: `upsert(m) ∘ upsert(m) ≡ upsert(m)`.
  Keyed on `(source_id, external_id)`.
- **P2 — Idempotent price writes.** Writing a price point more than once (e.g.
  reconnect backfill overlapping live ticks) yields exactly one row per
  `(market_id, outcome_id, ts)`, even under duplicates and reorderings.
- **P3 — Probability bounds.** For all outcomes, `0 ≤ impliedProb ≤ 1` and
  `0 ≤ lastPrice ≤ 1`; binary-market outcome probabilities sum to within
  tolerance `ε` of 1.
- **P4 — No false arbitrage.** Every market contributing to a spread signal has
  `resolutionMismatch = false`; a mismatched-criteria pair never appears in
  `/api/signals`, and signals are absent below two aligned markets.
- **P5 — Display-only invariant.** Every signal returned carries
  `executable === false`. The field is typed as the literal `false`, so a `true`
  cannot even be constructed (v1 has no execution path).
- **P6 — Cursor monotonicity.** For a given source, persisted cursors never
  regress across successful syncs and are saved only after a page is durably
  written (crash-safe resume).
- **P7 — Capability gating.** `subscribePrices` is invoked only when
  `capabilities().websocketPrices === true`; otherwise the market is served by
  polling with no missing price history.
- **P8 — Adapter isolation.** Adding or removing an adapter changes only that
  adapter's module; the normalized model, matching engine, and API contracts are
  unaffected. This is enforced by the dependency rule (`adapters/*` and `api/`
  depend on `core/`; `core/` depends on nothing) and the one-folder-per-platform
  layout, and is exercised at runtime by the capability-gating test (P7).
- **P9 — Comparison symmetry.** Canonical-event membership is symmetric (if A
  links to B, B links to A), and `maxSpread` is computed identically regardless
  of row order.

## Running just the property tests

```bash
# All property tests across the workspace:
npx vitest run -t "Property"

# Or by file, e.g. the no-false-arbitrage property:
npx vitest run packages/matching/src/no-false-arbitrage.property.test.ts
```

The full suite (`npm test`) runs these alongside the unit and integration tests.
