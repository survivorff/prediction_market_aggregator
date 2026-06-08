# @pma/adapters

Per-platform `MarketSource` implementations. **One folder per platform.** Each
adapter depends only on `@pma/core` ports and is invisible to the rest of the
system — adding or removing a platform changes only its own folder (Requirement
8: Adapter Extensibility).

```text
src/
├── polymarket/   # Gamma + CLOB + WebSocket; full capabilities
└── manifold/     # REST only; websocketPrices = false (tiered polling)
```

## How to write a new adapter

See the full guide:
[`docs/adapter-authoring-guide.md`](../../docs/adapter-authoring-guide.md).

Short version:

1. Create `src/<platform>/`.
2. Implement the `MarketSource` interface from `@pma/core`.
3. Declare your `capabilities()` honestly (`websocketPrices`, `priceHistory`,
   `orderBookDepth`, `keysetPagination`).
4. Register the adapter: `registry.register(new YourAdapter())`.
5. Add fixture-based normalization tests.

No changes to `core`, `matching`, or `api` are required.
