/**
 * Unit tests for the outbound trade deep-link slot (task 7.3):
 *   - the default registry resolver builds the correct per-source deep-link
 *     (Req 6.1), falls back to the source base site when no slug/id is usable,
 *     and returns null for an unknown source key;
 *   - every resolved link is navigation-only: `executable === false` with only
 *     a `url` and no execution fields (Req 6.2, 12.1);
 *   - the registry is pluggable (a new source builder needs no route change);
 *   - the handler looks up the market (404 unknown, Req 9.1), and the resolver
 *     is injectable/replaceable via GatewayDeps.tradeLink (Req 6.3).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type { GatewayDeps, TradeLink, TradeLinkMarket, TradeLinkResolver } from "./dto.js";
import { handleGetTradeLink } from "./handlers.js";
import { NotFoundError } from "./errors.js";
import {
  createTradeLinkResolver,
  defaultTradeLinkResolver,
  DEFAULT_SOURCE_URL_BUILDERS,
} from "./trade-link.js";
import { FakeDiscoveryReader, makeFakeMarket, type FakeMarket } from "./test-support.js";

const MARKET_ID = "11111111-1111-1111-1111-111111111111";

/** Build minimal GatewayDeps for the trade-link handler (only discovery is read). */
function buildDeps(markets: FakeMarket[], tradeLink?: TradeLinkResolver): GatewayDeps {
  return {
    discovery: new FakeDiscoveryReader(markets),
    outcomes: { listByMarket: async () => [] },
    prices: { history: async () => [] },
    sources: { list: async () => [] },
    ...(tradeLink ? { tradeLink } : {}),
  };
}

describe("defaultTradeLinkResolver", () => {
  it("builds a Polymarket event deep-link from the external id (Req 6.1)", () => {
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "polymarket",
      sourceName: "Polymarket",
      externalId: "will-btc-100k",
    });
    expect(link.url).toBe("https://polymarket.com/event/will-btc-100k");
    expect(link.source).toEqual({ key: "polymarket", name: "Polymarket" });
    expect(link.marketId).toBe(MARKET_ID);
  });

  it("prefers an explicit slug over the external id for Polymarket", () => {
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "polymarket",
      sourceName: "Polymarket",
      externalId: "0xabc123",
      slug: "us-election-2028",
    });
    expect(link.url).toBe("https://polymarket.com/event/us-election-2028");
  });

  it("builds a Manifold deep-link from a known slug", () => {
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "manifold",
      sourceName: "Manifold",
      externalId: "contract-abc",
      slug: "creator/will-it-rain",
    });
    expect(link.url).toBe("https://manifold.markets/creator/will-it-rain");
  });

  it("falls back to the Manifold base site when only the contract id is known", () => {
    // Manifold's canonical URL needs creator/slug; the contract id alone can't
    // build it, so we fall back to the base site rather than a broken link.
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "manifold",
      sourceName: "Manifold",
      externalId: "contract-abc",
    });
    expect(link.url).toBe("https://manifold.markets");
  });

  it("falls back to the Polymarket base site when no slug/id is usable", () => {
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "polymarket",
      sourceName: "Polymarket",
      externalId: "   ",
    });
    expect(link.url).toBe("https://polymarket.com");
  });

  it("returns a null url for an unknown source key (no builder registered)", () => {
    const link = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "kalshi",
      sourceName: "Kalshi",
      externalId: "evt-1",
    });
    expect(link.url).toBeNull();
    expect(link.source).toEqual({ key: "kalshi", name: "Kalshi" });
  });

  it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "treats inherited Object.prototype key %p as an unknown source (url null, never executable)",
    (sourceKey) => {
      // Regression: a bare `builders[sourceKey]` would resolve an inherited
      // member from Object.prototype (an object for "__proto__"; a function for
      // "constructor"/"toString"), throwing or invoking a built-in. Only OWN,
      // function-typed builders may be used; everything else yields url: null.
      const link = defaultTradeLinkResolver({
        id: MARKET_ID,
        sourceKey,
        sourceName: sourceKey,
        externalId: "evt-1",
      });
      expect(link.url).toBeNull();
      expect(link.executable).toBe(false);
      expect(Object.keys(link).sort()).toEqual(["executable", "marketId", "source", "url"]);
    },
  );

  it("always marks the link non-executable with no execution fields (Req 6.2, 12.1)", () => {
    const link: TradeLink = defaultTradeLinkResolver({
      id: MARKET_ID,
      sourceKey: "polymarket",
      sourceName: "Polymarket",
      externalId: "x",
    });
    expect(link.executable).toBe(false);
    // The DTO surface is navigation-only: marketId, source, url, executable.
    expect(Object.keys(link).sort()).toEqual(["executable", "marketId", "source", "url"]);
  });
});

describe("createTradeLinkResolver (pluggable registry, Req 6.3)", () => {
  it("registers a new source builder without changing the route/handler", () => {
    const resolver = createTradeLinkResolver({
      builders: {
        ...DEFAULT_SOURCE_URL_BUILDERS,
        kalshi: (m) => `https://kalshi.com/markets/${m.externalId}`,
      },
    });
    const link = resolver({
      id: MARKET_ID,
      sourceKey: "kalshi",
      sourceName: "Kalshi",
      externalId: "PRES-2028",
    });
    expect(link.url).toBe("https://kalshi.com/markets/PRES-2028");
    expect(link.executable).toBe(false);
  });

  it("a custom registry still never yields an executable link", () => {
    const resolver = createTradeLinkResolver({
      builders: { foo: () => "https://foo.example/m" },
    });
    const m: TradeLinkMarket = {
      id: MARKET_ID,
      sourceKey: "foo",
      sourceName: "Foo",
      externalId: "1",
    };
    expect(resolver(m).executable).toBe(false);
  });
});

describe("trade-link execution-safety invariant (property-based, Req 6.2/12.1)", () => {
  /** Arbitrary market projections, including odd/empty slugs and unknown sources. */
  const marketArb: fc.Arbitrary<TradeLinkMarket> = fc.record({
    id: fc.uuid(),
    sourceKey: fc.oneof(
      fc.constantFrom("polymarket", "manifold", "kalshi", "metaculus"),
      fc.string(),
    ),
    sourceName: fc.string(),
    externalId: fc.string(),
    slug: fc.option(fc.string(), { nil: null }),
  });

  it("the default resolver always returns executable:false with only navigation fields", () => {
    fc.assert(
      fc.property(marketArb, (market) => {
        const link = defaultTradeLinkResolver(market);
        // Never executable, and the shape exposes no execution surface.
        expect(link.executable).toBe(false);
        expect(Object.keys(link).sort()).toEqual(["executable", "marketId", "source", "url"]);
        // url is either a string or explicitly null (never an object/path with side effects).
        expect(link.url === null || typeof link.url === "string").toBe(true);
        expect(link.marketId).toBe(market.id);
      }),
    );
  });
});

describe("handleGetTradeLink", () => {
  it("returns the deep-link for a known market via the default resolver (Req 6.1)", async () => {
    const market = makeFakeMarket({
      id: MARKET_ID,
      externalId: "btc-100k",
      sourceKey: "polymarket",
      sourceName: "Polymarket",
    });
    const deps = buildDeps([market]);

    const link = await handleGetTradeLink(deps, MARKET_ID);
    expect(link).toEqual({
      marketId: MARKET_ID,
      source: { key: "polymarket", name: "Polymarket" },
      url: "https://polymarket.com/event/btc-100k",
      executable: false,
    });
  });

  it("throws NotFoundError for an unknown market id (Req 9.1)", async () => {
    const deps = buildDeps([makeFakeMarket({ id: MARKET_ID })]);
    await expect(
      handleGetTradeLink(deps, "99999999-9999-9999-9999-999999999999"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("uses an injected resolver when provided, proving the slot is replaceable (Req 6.3)", async () => {
    const market = makeFakeMarket({
      id: MARKET_ID,
      sourceKey: "polymarket",
      sourceName: "Polymarket",
    });
    let calledWith: TradeLinkMarket | null = null;
    const fakeResolver: TradeLinkResolver = (m) => {
      calledWith = m;
      return {
        marketId: m.id,
        source: { key: m.sourceKey, name: m.sourceName },
        url: "https://example.test/custom-slot",
        executable: false,
      };
    };
    const deps = buildDeps([market], fakeResolver);

    const link = await handleGetTradeLink(deps, MARKET_ID);
    expect(link.url).toBe("https://example.test/custom-slot");
    expect(link.executable).toBe(false);
    expect(calledWith).not.toBeNull();
    expect(calledWith!.id).toBe(MARKET_ID);
  });
});
