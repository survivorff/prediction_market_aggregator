import { describe, it, expect, vi } from "vitest";
import type {
  MarketSource,
  SourceMeta,
  SourceCapabilities,
  Page,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  Subscription,
} from "@pma/core";
import { InMemoryAdapterRegistry, DuplicateSourceError } from "./registry.js";

/**
 * Unit tests for the {@link InMemoryAdapterRegistry} (task 4.1 / Requirement
 * 8.4). They use small in-memory fake adapters — no database, no network — so
 * the registry's behavior is exercised in isolation: register / all / byKey,
 * duplicate-key rejection, internal-id resolution at registration, and
 * preservation of capability-gated optional methods.
 */

const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Build a minimal fake {@link MarketSource}. `subscribePrices` is included only
 * when `websocketPrices` is true, mirroring real adapters' capability gating.
 */
function makeFakeSource(
  key: string,
  overrides: {
    id?: string;
    name?: string;
    capabilities?: Partial<SourceCapabilities>;
    websocket?: boolean;
  } = {},
): MarketSource {
  const websocket = overrides.websocket ?? false;
  const meta: SourceMeta = {
    id: overrides.id ?? PLACEHOLDER_ID,
    key,
    name: overrides.name ?? `Fake ${key}`,
    type: "onchain",
    baseCurrency: "USDC",
  };
  const capabilities: SourceCapabilities = {
    websocketPrices: websocket,
    priceHistory: true,
    orderBookDepth: false,
    keysetPagination: true,
    ...overrides.capabilities,
  };

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (): Promise<Page<NormalizedMarket>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
    fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
    capabilities: () => capabilities,
  };

  if (websocket) {
    source.subscribePrices = (): Subscription => ({
      close: () => undefined,
      isOpen: true,
    });
  }

  return source;
}

describe("InMemoryAdapterRegistry", () => {
  it("registers a source and exposes it via byKey and all", () => {
    const registry = new InMemoryAdapterRegistry();
    const manifold = makeFakeSource("manifold");

    registry.register(manifold);

    expect(registry.byKey("manifold")?.meta.key).toBe("manifold");
    expect(registry.all()).toHaveLength(1);
    expect(registry.all().map((s) => s.meta.key)).toEqual(["manifold"]);
  });

  it("returns undefined from byKey for an unregistered source", () => {
    const registry = new InMemoryAdapterRegistry();
    expect(registry.byKey("polymarket")).toBeUndefined();
  });

  it("returns an empty array from all() when nothing is registered", () => {
    const registry = new InMemoryAdapterRegistry();
    expect(registry.all()).toEqual([]);
  });

  it("preserves registration order in all()", () => {
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeFakeSource("polymarket"));
    registry.register(makeFakeSource("manifold"));
    registry.register(makeFakeSource("kalshi"));

    expect(registry.all().map((s) => s.meta.key)).toEqual(["polymarket", "manifold", "kalshi"]);
  });

  it("rejects a duplicate key with DuplicateSourceError", () => {
    const registry = new InMemoryAdapterRegistry();
    registry.register(makeFakeSource("manifold"));

    expect(() => registry.register(makeFakeSource("manifold"))).toThrow(DuplicateSourceError);
    // The original registration is unaffected by the rejected duplicate.
    expect(registry.all()).toHaveLength(1);
  });

  it("rejects a source with an empty meta.key", () => {
    const registry = new InMemoryAdapterRegistry();
    expect(() => registry.register(makeFakeSource("   "))).toThrow(/empty meta\.key/);
    expect(registry.all()).toEqual([]);
  });

  it("resolves meta.id at registration via the injected resolver", () => {
    const idsByKey: Record<string, string> = {
      polymarket: "11111111-1111-1111-1111-111111111111",
      manifold: "22222222-2222-2222-2222-222222222222",
    };
    const resolveId = vi.fn((meta: SourceMeta) => idsByKey[meta.key] ?? meta.id);
    const registry = new InMemoryAdapterRegistry(resolveId);

    // Adapters are authored knowing only their key — meta.id is a placeholder.
    registry.register(makeFakeSource("polymarket", { id: PLACEHOLDER_ID }));
    registry.register(makeFakeSource("manifold", { id: PLACEHOLDER_ID }));

    expect(resolveId).toHaveBeenCalledTimes(2);
    expect(registry.byKey("polymarket")?.meta.id).toBe(idsByKey.polymarket);
    expect(registry.byKey("manifold")?.meta.id).toBe(idsByKey.manifold);
  });

  it("stamps the resolved id without mutating the original adapter", () => {
    const original = makeFakeSource("polymarket", { id: PLACEHOLDER_ID });
    const resolved = "33333333-3333-3333-3333-333333333333";
    const registry = new InMemoryAdapterRegistry(() => resolved);

    registry.register(original);

    expect(registry.byKey("polymarket")?.meta.id).toBe(resolved);
    // Original object is untouched (Requirement 8.4: zero side effects).
    expect(original.meta.id).toBe(PLACEHOLDER_ID);
  });

  it("preserves other meta fields when resolving the id", () => {
    const registry = new InMemoryAdapterRegistry(() => "resolved-uuid");
    registry.register(makeFakeSource("manifold", { id: PLACEHOLDER_ID, name: "Manifold" }));

    const meta = registry.byKey("manifold")?.meta;
    expect(meta).toMatchObject({
      id: "resolved-uuid",
      key: "manifold",
      name: "Manifold",
      type: "onchain",
      baseCurrency: "USDC",
    });
  });

  it("defaults to trusting the adapter's own meta.id when no resolver is given", () => {
    const registry = new InMemoryAdapterRegistry();
    const preResolved = "44444444-4444-4444-4444-444444444444";
    registry.register(makeFakeSource("polymarket", { id: preResolved }));

    expect(registry.byKey("polymarket")?.meta.id).toBe(preResolved);
  });

  it("rejects registration when the resolver returns an empty id", () => {
    const registry = new InMemoryAdapterRegistry(() => "");
    expect(() => registry.register(makeFakeSource("manifold"))).toThrow(/empty id/);
    expect(registry.all()).toEqual([]);
  });

  it("keeps subscribePrices present for ws-capable adapters after id resolution", () => {
    const registry = new InMemoryAdapterRegistry(() => "resolved-uuid");
    registry.register(makeFakeSource("polymarket", { websocket: true }));

    const adapter = registry.byKey("polymarket");
    expect(adapter?.capabilities().websocketPrices).toBe(true);
    expect(typeof adapter?.subscribePrices).toBe("function");
  });

  it("keeps subscribePrices absent for non-ws adapters after id resolution", () => {
    const registry = new InMemoryAdapterRegistry(() => "resolved-uuid");
    registry.register(makeFakeSource("manifold", { websocket: false }));

    const adapter = registry.byKey("manifold");
    expect(adapter?.capabilities().websocketPrices).toBe(false);
    expect(adapter?.subscribePrices).toBeUndefined();
  });

  it("forwards adapter method calls through the id-resolved view", async () => {
    const registry = new InMemoryAdapterRegistry(() => "resolved-uuid");
    const base = makeFakeSource("manifold");
    const spy = vi.spyOn(base, "fetchMarkets").mockResolvedValue({ items: [], nextCursor: "next" });
    registry.register(base);

    const page = await registry.byKey("manifold")!.fetchMarkets({ limit: 10 });

    expect(spy).toHaveBeenCalledWith({ limit: 10 });
    expect(page.nextCursor).toBe("next");
  });
});
