# Adapter Authoring Guide

> Status: complete. This guide walks an open-source contributor through adding a
> new prediction-market platform by implementing the `MarketSource` interface in
> **one** new folder under `packages/adapters/src/<platform>/`, with **zero**
> changes to `core`, `matching`, or `api` (Requirements 8.1, 8.2). The
> authoritative interface lives in
> [`packages/core/src/ports/market-source.ts`](../packages/core/src/ports/market-source.ts);
> the two reference adapters are
> [`polymarket/`](../packages/adapters/src/polymarket) and
> [`manifold/`](../packages/adapters/src/manifold).

## The goal: adapter isolation

Adding a platform is a **localized change**. You create one folder, implement a
single interface, declare your capabilities, and register the adapter. Nothing
else in the system imports your code or knows it exists:

- the normalized model (`@pma/core`),
- the matching engine (`@pma/matching`),
- and the API contracts (`@pma/api`)

are all unaffected (Requirement 8.1 — _adapter isolation_; design Property 8).
The dependency rule is enforced by the layout: `adapters/*` depends only on
`@pma/core` ports, and `core/` depends on nothing.

## The contract: `MarketSource`

Your adapter implements the `MarketSource` port from `@pma/core`. This is the
**real, implemented** interface (abridged — see the source for full JSDoc):

```typescript
// packages/core/src/ports/market-source.ts
interface MarketSource {
  readonly meta: SourceMeta;

  // Metadata sync (keyset pagination, incremental via `updatedSince`).
  fetchEvents(opts: PageRequest): Promise<Page<NormalizedEvent>>;
  fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>>;

  // Prices — pull.
  fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]>;
  fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]>;

  // Prices — push (present ONLY when capabilities().websocketPrices === true).
  subscribePrices?(marketIds: string[], handler: PriceTickHandler): Subscription;

  capabilities(): SourceCapabilities;
}
```

### `meta: SourceMeta`

Identity of your source. Author it with a stable `key` slug; the registry stamps
the resolved internal `id` at registration time (see
[Registering your adapter](#5-register-it)).

```typescript
interface SourceMeta {
  id: string; // internal UUID — resolved by the registry; use a placeholder
  key: string; // stable slug: "polymarket" | "manifold" | "<your-platform>"
  name: string; // "Polymarket"
  type: SourceType; // "onchain" | "cex" | "regulated"
  baseCurrency: string; // "USDC", "MANA", …
}
```

Both reference adapters set a placeholder id and let the registry resolve the
real one:

```typescript
// packages/adapters/src/polymarket/index.ts
const PLACEHOLDER_SOURCE_ID = "00000000-0000-0000-0000-000000000000";
this.meta = {
  id: options.sourceId ?? PLACEHOLDER_SOURCE_ID,
  key: POLYMARKET_KEY, // "polymarket"
  name: "Polymarket",
  type: "onchain",
  baseCurrency: "USDC",
};
```

> Picking a `type`: the union is `"onchain" | "cex" | "regulated"`. When none is
> a perfect fit, choose the closest and document why. Manifold is a play-money
> (MANA) venue; its adapter uses `"onchain"` with `baseCurrency: "MANA"` and
> explains the choice in a header comment.

### `capabilities()` and capability gating

Your adapter **declares what it supports**, and the orchestrator only ever calls
optional methods your capabilities permit (Requirement 8.3; design Property 7).
Declare honestly:

```typescript
interface SourceCapabilities {
  websocketPrices: boolean; // true → subscribePrices is implemented; orchestrator streams active markets
  priceHistory: boolean; // true → fetchPriceHistory returns real history (curves + reconnect backfill)
  orderBookDepth: boolean; // true → order-book depth available (e.g. Polymarket CLOB)
  keysetPagination: boolean; // true → cursor-based keyset pagination; false → offset fallback
}
```

The two reference adapters show both ends of the spectrum:

| Capability         | Polymarket | Manifold | Predict.fun | Effect when `false`                                                       |
| ------------------ | ---------- | -------- | ----------- | ------------------------------------------------------------------------- |
| `websocketPrices`  | `true`     | `false`  | `false`     | Orchestrator never calls `subscribePrices`; routes the source to polling. |
| `priceHistory`     | `true`     | `true`   | `true`      | Reconnect backfill / curves fall back to snapshots only.                  |
| `orderBookDepth`   | `true`     | `false`  | `true`      | Market detail omits depth.                                                |
| `keysetPagination` | `true`     | `true`   | `true`      | Offset pagination fallback is used.                                       |

Because Manifold declares `websocketPrices: false`, its adapter **does not even
define** a `subscribePrices` method — and the orchestrator never calls one. This
is the capability-gating guarantee (verified by
[`capability-gating.property.test.ts`](../packages/ingestion/src/capability-gating.property.test.ts)).

## Per-folder file layout

Both reference adapters use the same self-contained structure. Mirror it so each
platform stays isolated and testable:

```text
packages/adapters/src/<platform>/
├── index.ts        # the MarketSource implementation (I/O orchestration only)
├── http.ts         # injectable HTTP transport (HttpClient over fetch)
├── socket.ts       # injectable WebSocket transport (only if you stream prices)
├── cursor.ts       # opaque keyset-cursor encode/decode/advance
├── mapper.ts       # PURE raw-payload → normalized-entity mapping
├── safe.ts         # PURE safe accessors for untrusted payloads
├── __fixtures__/   # recorded upstream payloads for tests
└── *.test.ts       # mapper/cursor/index/fixtures tests
```

The separation matters: `index.ts` does I/O and delegates all shaping to the
**pure** `mapper.ts`, which uses **pure** `safe.ts` accessors. This keeps the
field-mapping logic unit-testable without any network access.

## Step-by-step

### 1. Create the folder

`packages/adapters/src/<platform>/`. Add an `index.ts` exporting a class that
`implements MarketSource`, plus a stable `KEY` constant.

### 2. Inject your transports (testability)

Never close over the global `fetch` directly. Depend on a narrow `HttpClient`
that defaults to `fetch` in production and is replaced by a fake in tests. This
is the pattern in both adapters' `http.ts`:

```typescript
export interface HttpClient {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>;
}
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient {
  /* … */
}
```

```typescript
// Your adapter constructor — everything optional, production defaults wired:
constructor(options: MyAdapterOptions = {}) {
  this.http = options.http ?? createFetchHttpClient(options.fetchImpl);
  this.now  = options.now  ?? (() => new Date());   // injectable clock for deterministic ts
}
```

If you stream prices, inject a `WebSocketFactory` too (see Polymarket's
[`socket.ts`](../packages/adapters/src/polymarket/socket.ts), which ships a
`FakeWebSocket` for tests). Only GET is needed — **v1 is strictly read-only**
(Requirement 12.1); adapters perform no writes.

### 3. Implement metadata sync with keyset pagination

`fetchEvents` / `fetchMarkets` take a `PageRequest` (`{ cursor?, limit, updatedSince? }`)
and return a `Page<T>` (`{ items, nextCursor }`). Treat `cursor`/`nextCursor` as
**opaque** strings; encapsulate the platform's pagination scheme in `cursor.ts`.

Manifold's cursor module is a compact example: it base64url-encodes
`{ before: <contractId> }`, decodes without ever throwing (malformed → start),
and computes `nextCursor` as `null` at end-of-stream:

```typescript
// packages/adapters/src/manifold/cursor.ts (abridged)
export function computeNextCursor(input: {
  lastId: string | null;
  pageSize: number;
  limit: number;
}) {
  if (input.pageSize < input.limit) return null; // short page → end of stream
  if (input.lastId === null) return null; // cannot advance safely → end
  return encodeCursor({ before: input.lastId });
}
```

If your platform has no first-class "event" resource, return an empty terminal
page from `fetchEvents` (as Manifold does) and derive grouping from the markets.

### 4. Normalize untrusted payloads (the most important pattern)

Every upstream response is **untrusted JSON of unknown shape**. Never index raw
objects directly. Route everything through pure `safe.ts` accessors so a missing
or malformed field becomes an explicit `null`/`[]` rather than a thrown error
(Requirement 1.5). The reference `safe.ts` provides:

- `isRecord`, `getField`, `getFirstField` — guarded property access,
- `asStringOrNull`, `asFiniteNumberOrNull`, `asBoolean`, `asArray` — coercions,
- `parseStringifiedArray` — for platforms that JSON-encode arrays as strings,
- `toIsoTimestampOrNull` — ISO / epoch-seconds / epoch-millis → ISO.

Then map in a pure `mapper.ts`, honoring the model's rules:

- **Probabilities → `[0, 1]`** via `normalizeProbability`, and reconcile binary
  outcomes to sum ≈ 1 via `normalizeBinaryProbabilities` (`@pma/core`).
- **Spread `>= 0`** via `normalizeSpread`.
- **Preserve `resolutionCriteria.raw`** _always_, even when the structured
  fields can't be parsed (Requirement 10.3) — use `normalizeResolutionCriteria`,
  which defaults `raw` to `{}` so it is never lost. Matching Layer 4 depends on
  this to flag resolution mismatches and avoid false arbitrage signals.
- **`externalId` is the platform-native id** — it forms the `(source_id, external_id)`
  idempotency key.
- **Map your category labels** onto the normalized `Category` taxonomy
  (`politics | crypto | sports | economics | tech | other`); unknown → `other`.

Worked example — how Polymarket derives the implied probability: a binary Yes/No
market is two Polygon outcome tokens, and the **Yes-token price is the implied
probability**. Manifold instead reads a binary contract's `probability` field
directly. Both end up as a normalized `Outcome` with `impliedProb ∈ [0, 1]`.

### 5. Implement prices

- `fetchPriceSnapshot(marketIds)` — latest prices (pull). Skip unreadable entries
  rather than failing the whole batch (Requirement 1.5).
- `fetchPriceHistory(marketId, range)` — a time-series for curves and reconnect
  backfill. Polymarket reads the CLOB `/prices-history`; Manifold maps `/v0/bets`
  (`probAfter` + `createdTime`) into an ascending Yes-price series.
- `subscribePrices(marketIds, handler)` — **only if** `websocketPrices: true`.
  Return a `Subscription` (`close()` + `isOpen`); the orchestrator drives
  reconnect-with-backoff and backfill on top of it. Normalize inbound frames in
  the pure mapper and **never throw** on a malformed frame or a faulty handler.

### 6. Register it

Adding a platform is one line at startup; **no other call site changes**
(Requirement 8.4). The registry resolves your `meta.id` from your stable `key`:

```typescript
// packages/ingestion/src/registry.ts
import { InMemoryAdapterRegistry } from "@pma/ingestion";

const registry = new InMemoryAdapterRegistry(resolveSourceId);
registry.register(new PolymarketAdapter());
registry.register(new ManifoldAdapter());
registry.register(new MyPlatformAdapter()); // ← the entire integration
```

Then export your adapter from the package barrel
[`packages/adapters/src/index.ts`](../packages/adapters/src/index.ts) alongside
the existing two.

### 7. Add fixture tests

Record real upstream payloads under `__fixtures__/` and assert your mapper
produces the correct normalized entities and that cursors round-trip. Both
reference adapters have `mapper.test.ts`, `cursor.test.ts`, `fixtures.test.ts`,
and `index.test.ts` (driven entirely by injected fake transports — no network).
Cover at minimum:

- a typical market → normalized `Market` + `Outcome[]` with `impliedProb ∈ [0,1]`,
- missing/optional fields → explicit `null` (never a throw),
- `resolutionCriteria.raw` preserved when structured fields are absent,
- cursor encode → decode → advance round-trip, including end-of-stream `null`.

## Normalization rules checklist

- [ ] `impliedProb` and binary `lastPrice` within `[0, 1]`.
- [ ] Binary outcome probabilities sum to ≈ 1 within tolerance (`0.01`).
- [ ] `spread >= 0` (or `null`).
- [ ] `resolutionCriteria.raw` always preserved.
- [ ] Missing values represented explicitly (`null`), never a thrown error.
- [ ] `externalId` is the platform-native id; `(source_id, external_id)` is the
      idempotency key.
- [ ] `capabilities()` is honest; optional methods exist iff declared.

## Reference adapters

- **Polymarket** ([`adapters/src/polymarket/`](../packages/adapters/src/polymarket)) —
  Gamma API (metadata, keyset pagination) + CLOB API (snapshot/history/depth) +
  WebSocket market channel. Declares **all** capabilities `true`. The full-fat
  example: pull + push prices, order-book depth, injected HTTP **and** WebSocket
  transports.
- **Manifold** ([`adapters/src/manifold/`](../packages/adapters/src/manifold)) —
  REST only; `websocketPrices = false` so the orchestrator routes it through
  tiered polling (and the adapter defines **no** `subscribePrices`). The minimal
  example, recommended reading first: it proves normalization + same-question
  matching work without relying on WebSocket.
- **Predict.fun** ([`adapters/src/predictfun/`](../packages/adapters/src/predictfun)) —
  the BNB-Chain CLOB venue integrated into Binance Wallet. REST only
  (`websocketPrices = false`), but `orderBookDepth = true`: the markets list
  carries no price, so the adapter derives the Yes implied probability from the
  `/orderbook` best-bid/ask **mid**. A good example of an order-book source
  without a price WebSocket, and of an optional mainnet `x-api-key` header.

See also [`packages/adapters/README.md`](../packages/adapters/README.md) for the
short version, and [`data-model.md`](./data-model.md) for the entities you map
into.
