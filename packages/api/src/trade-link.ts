/**
 * The outbound "trade deep-link" slot (design glossary "Trade Deep-Link"; the
 * `GET /api/markets/{id}/trade-link` endpoint).
 *
 * In v1 this is a NAVIGATION link only: it maps a market to a public URL on its
 * source platform. There is deliberately NO order-placement, fund-routing, or
 * execution code path here — the response always carries `executable: false`
 * (Requirements 6.2, 12.1). The architecture reserves this exact slot for a
 * future "one-click participate" execution flow, which replaces the injected
 * {@link TradeLinkResolver} WITHOUT touching the discovery / comparison /
 * signals contracts (Requirement 6.3).
 *
 * Extensibility (open-source friendly): deep-link construction is a pluggable
 * registry of per-source-key URL builders. Adding a platform = adding one
 * builder entry; the route and handler never change. Each builder receives the
 * market's stored `(sourceKey, externalId, slug?)` and returns the best-known
 * public market URL, falling back to the platform's base site when a specific
 * market URL cannot be constructed from the available data.
 */

import type { TradeLink, TradeLinkMarket, TradeLinkResolver } from "./dto.js";

/**
 * Builds the public URL for a single market on one platform.
 *
 * Returns the best-known deep-link from the available stored data, or `null`
 * when not even a base site is known (the registry then leaves `url` null).
 * Builders are PURE (no I/O, no upstream calls) so the gateway keeps serving
 * only from stored data (Requirement 9.1).
 */
export type SourceUrlBuilder = (market: TradeLinkMarket) => string | null;

/** Strip leading/trailing slashes so URL segments join cleanly. */
function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/** Prefer an explicit slug, falling back to the platform-native external id. */
function slugOrExternalId(market: TradeLinkMarket): string | null {
  const slug = market.slug?.trim();
  if (slug !== undefined && slug.length > 0) return slug;
  const externalId = market.externalId.trim();
  return externalId.length > 0 ? externalId : null;
}

/**
 * Default per-source-key URL builders.
 *
 * Limitations (documented intentionally): the public URL slug a platform shows
 * in the browser is not always identical to the `externalId` we persist for
 * ingestion. We build the best-known link from available data — preferring an
 * explicit `slug` when present — and otherwise fall back to the source's base
 * site so the "Go trade" action always resolves somewhere sensible.
 *
 * - Polymarket: public markets live under `polymarket.com/event/{slug}`. We use
 *   the slug when known, else the external id, else the base site.
 * - Manifold: public questions live under `manifold.markets/{creator}/{slug}`;
 *   without the creator/slug we cannot construct the canonical path from the
 *   contract id alone, so we deep-link via the slug when known and otherwise
 *   fall back to the base site.
 */
export const DEFAULT_SOURCE_URL_BUILDERS: Readonly<Record<string, SourceUrlBuilder>> = {
  polymarket: (market) => {
    const segment = slugOrExternalId(market);
    return segment === null
      ? "https://polymarket.com"
      : `https://polymarket.com/event/${trimSlashes(segment)}`;
  },
  manifold: (market) => {
    const slug = market.slug?.trim();
    return slug !== undefined && slug.length > 0
      ? `https://manifold.markets/${trimSlashes(slug)}`
      : "https://manifold.markets";
  },
};

/** Options for {@link createTradeLinkResolver}. */
export interface TradeLinkRegistryOptions {
  /**
   * Per-source-key URL builders. Defaults to {@link DEFAULT_SOURCE_URL_BUILDERS}.
   * Pass a superset to register a new source's deep-link without changing the
   * route (open-source extensibility).
   */
  builders?: Record<string, SourceUrlBuilder>;
}

/**
 * Create a registry-backed {@link TradeLinkResolver}. The returned resolver is
 * pure and navigation-only: it builds a `url` from the matching source builder
 * (or `null` when the source key is unknown) and ALWAYS sets `executable:
 * false`. There is no execution path of any kind (Requirements 6.2, 12.1).
 *
 * This factory IS the replaceable seam (Requirement 6.3): callers inject the
 * result via `GatewayDeps.tradeLink`, and a future execution flow swaps in a
 * different resolver here with no change elsewhere.
 */
export function createTradeLinkResolver(options: TradeLinkRegistryOptions = {}): TradeLinkResolver {
  const builders = options.builders ?? DEFAULT_SOURCE_URL_BUILDERS;
  return (market: TradeLinkMarket): TradeLink => {
    // Look up only OWN builder entries: a bare `builders[sourceKey]` would
    // resolve inherited Object.prototype members for keys like "__proto__",
    // "constructor", or "toString" — yielding a truthy non-builder value that
    // either throws (an object is not callable) or wrongly invokes a built-in.
    // Treat any unknown/inherited key as an unknown source (`url: null`).
    const builder = Object.hasOwn(builders, market.sourceKey)
      ? builders[market.sourceKey]
      : undefined;
    const url = typeof builder === "function" ? builder(market) : null;
    return {
      marketId: market.id,
      source: { key: market.sourceKey, name: market.sourceName },
      url,
      // v1 is navigation-only: never executable (Requirements 6.2, 12.1).
      executable: false,
    };
  };
}

/**
 * The default resolver used when `GatewayDeps.tradeLink` is not supplied. Built
 * from {@link DEFAULT_SOURCE_URL_BUILDERS}; pure and execution-free.
 */
export const defaultTradeLinkResolver: TradeLinkResolver = createTradeLinkResolver();
