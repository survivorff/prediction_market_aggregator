/**
 * Adapter registry — the ingestion pipeline's single source of truth for the
 * set of registered platform adapters (design.md "Adapter registration").
 *
 * Adding a platform is `registry.register(new XAdapter())` with **zero changes
 * to call sites elsewhere** (Requirement 8.4): the orchestrator iterates
 * {@link AdapterRegistry.all | all()} and resolves a specific adapter via
 * {@link AdapterRegistry.byKey | byKey()}.
 *
 * `SourceMeta.id` is the internal source UUID and is "resolved at registration"
 * (design.md `SourceMeta`). Adapters are authored knowing only their stable
 * `key`; the registry stamps the resolved internal id onto each registered
 * source via an injected {@link SourceIdResolver}. The resolver keeps the
 * registry free of storage I/O and fully unit-testable without a database:
 * production wires it to a source-row lookup/insert pre-resolved into a map at
 * startup, while tests pass a small fake.
 */

import type { MarketSource, SourceMeta } from "@pma/core";

/**
 * Resolves the internal source UUID for an adapter at registration time, keyed
 * off its stable {@link SourceMeta.key}.
 *
 * Registration is synchronous (the {@link AdapterRegistry.register} contract
 * returns `void`), so production resolves source rows once at startup into a
 * `key → uuid` map and adapts it to this synchronous shape. Tests pass a
 * deterministic stub (e.g. a map lookup).
 */
export type SourceIdResolver = (meta: SourceMeta) => string;

/**
 * The adapter registry contract (design.md "Adapter registration").
 *
 * - {@link register} adds an adapter, resolving its internal `meta.id`.
 * - {@link all} returns every registered adapter (registration order).
 * - {@link byKey} resolves a single adapter by its stable slug.
 */
export interface AdapterRegistry {
  register(source: MarketSource): void;
  all(): MarketSource[];
  byKey(key: string): MarketSource | undefined;
}

/**
 * Thrown by {@link InMemoryAdapterRegistry.register} when a source with the
 * same {@link SourceMeta.key} is already registered. Keeping it a distinct
 * error type lets callers/tests assert duplicate handling precisely.
 */
export class DuplicateSourceError extends Error {
  constructor(public readonly key: string) {
    super(`A source with key "${key}" is already registered`);
    this.name = "DuplicateSourceError";
  }
}

/**
 * In-memory {@link AdapterRegistry}. Holds adapters in an insertion-ordered map
 * keyed by their stable slug so {@link all} preserves registration order and
 * {@link byKey} is O(1).
 *
 * At {@link register} time the registry resolves the source's internal UUID via
 * the injected {@link SourceIdResolver} and stores a view of the adapter whose
 * `meta.id` carries the resolved value — without mutating the original adapter.
 */
export class InMemoryAdapterRegistry implements AdapterRegistry {
  /** Stable-key → registered (id-resolved) adapter. Insertion-ordered. */
  private readonly sources = new Map<string, MarketSource>();

  private readonly resolveId: SourceIdResolver;

  /**
   * @param resolveId Resolves an adapter's internal source UUID at
   *   registration. Defaults to trusting the adapter's own (already-resolved)
   *   `meta.id`, which is convenient for tests and pre-resolved adapters.
   */
  constructor(resolveId?: SourceIdResolver) {
    this.resolveId = resolveId ?? ((meta) => meta.id);
  }

  register(source: MarketSource): void {
    const { key } = source.meta;
    if (typeof key !== "string" || key.trim() === "") {
      throw new Error("Cannot register a source with an empty meta.key");
    }
    if (this.sources.has(key)) {
      throw new DuplicateSourceError(key);
    }

    const id = this.resolveId(source.meta);
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`Source id resolver returned an empty id for source "${key}"`);
    }

    this.sources.set(key, withResolvedId(source, id));
  }

  all(): MarketSource[] {
    return [...this.sources.values()];
  }

  byKey(key: string): MarketSource | undefined {
    return this.sources.get(key);
  }
}

/**
 * Return a view of `source` whose `meta.id` is the resolved internal UUID.
 *
 * When the adapter's `meta.id` already equals `id` the original is returned
 * unchanged. Otherwise a thin delegating wrapper is built: `meta` carries the
 * resolved id while every method is bound to the original adapter, so behavior
 * is preserved and the original object is left untouched (Requirement 8.4).
 * The optional `subscribePrices` is forwarded only when the adapter implements
 * it, keeping capability gating intact (Requirement 8.3).
 */
function withResolvedId(source: MarketSource, id: string): MarketSource {
  if (source.meta.id === id) {
    return source;
  }
  const meta: SourceMeta = { ...source.meta, id };
  const wrapped: MarketSource = {
    meta,
    fetchEvents: (opts) => source.fetchEvents(opts),
    fetchMarkets: (opts) => source.fetchMarkets(opts),
    fetchPriceSnapshot: (marketIds) => source.fetchPriceSnapshot(marketIds),
    fetchPriceHistory: (marketId, range) => source.fetchPriceHistory(marketId, range),
    capabilities: () => source.capabilities(),
  };
  // Preserve the optional method's presence so capability gating still works:
  // the orchestrator checks `typeof source.subscribePrices === "function"`.
  if (source.subscribePrices) {
    wrapped.subscribePrices = (marketIds, handler) => source.subscribePrices!(marketIds, handler);
  }
  return wrapped;
}
