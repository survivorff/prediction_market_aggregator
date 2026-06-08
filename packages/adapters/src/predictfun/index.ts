/**
 * Predict.fun adapter — a {@link MarketSource} implementation over Predict.fun's
 * public REST API (the BNB-Chain prediction market that is the official
 * predictions provider integrated into Binance Wallet).
 *
 * - **REST only** (`api.predict.fun` mainnet / `api-testnet.predict.fun`
 *   testnet). Testnet is public; mainnet requires an `x-api-key` header
 *   (supplied via {@link PredictFunAdapterOptions.apiKey}).
 * - `GET /v1/markets?limit&cursor` → cursor-paginated metadata envelope
 *   `{ data, cursor }` ({@link PredictFunAdapter.fetchMarkets}).
 * - `GET /v1/markets/{id}/orderbook` → CLOB `asks`/`bids` ladders; the **mid of
 *   the best bid/ask is the Yes implied probability**
 *   ({@link PredictFunAdapter.fetchPriceSnapshot} /
 *   {@link PredictFunAdapter.fetchOrderBookDepth}).
 * - `GET /v1/markets/{id}/timeseries?interval` → price history
 *   ({@link PredictFunAdapter.fetchPriceHistory}).
 *
 * Binary Yes/No markets back two ERC-1155 conditional-token outcomes; share
 * prices read directly as implied probability (the Polymarket mental model).
 *
 * Capabilities: `websocketPrices = false` (the public read API exposes no price
 * WebSocket) → the orchestrator routes Predict.fun through tiered polling and
 * MUST NOT call a subscription (Requirement 8.3); accordingly this class
 * deliberately implements **no** `subscribePrices` method. `priceHistory`,
 * `orderBookDepth`, and `keysetPagination` are `true`.
 *
 * SourceType choice: Predict.fun is an on-chain (BNB Chain) venue settling into
 * conditional tokens, so `"onchain"` with `baseCurrency: "USDB"` (its stablecoin
 * collateral).
 *
 * Testability: the HTTP client is injected (constructor options) so the adapter
 * runs WITHOUT real network access. Production defaults to global `fetch`; tests
 * inject a fake. All upstream payloads are treated as untrusted and
 * validated/normalized in the pure {@link file://./mapper.ts | mapper} before
 * returning; the adapter never throws on missing optional fields (Requirement
 * 1.5).
 *
 * Requirements: 8.2, 8.3 (conform + declare capabilities, gated optionals),
 * 1.1 (unified discovery shape), 4.2 (price history), 4.3 (order-book depth),
 * 10.3 (preserve raw resolution criteria), 12.1 (read-only — no order placement).
 */

import type {
  MarketSource,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  Page,
  PageRequest,
  SourceCapabilities,
  SourceMeta,
  TimeRange,
} from "@pma/core";

import {
  createFetchHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpGetOptions,
} from "./http.js";
import { computeNextCursor, cursorToQuery, decodeCursor, readResponseCursor } from "./cursor.js";
import {
  mapMarket,
  mapOrderBookDepth,
  mapPriceHistory,
  mapPriceSnapshot,
  midImpliedProbability,
  YES_LABEL,
  type NormalizedDepth,
} from "./mapper.js";
import { asArray, getFirstField } from "./safe.js";

/** The stable source slug for Predict.fun. */
export const PREDICTFUN_KEY = "predictfun" as const;

/** Default Predict.fun mainnet REST base (requires `x-api-key`). */
export const DEFAULT_BASE_URL = "https://api.predict.fun";
/** Public Predict.fun testnet REST base (no auth). */
export const TESTNET_BASE_URL = "https://api-testnet.predict.fun";

/** Placeholder source UUID; the registry resolves the real id at registration. */
const PLACEHOLDER_SOURCE_ID = "00000000-0000-0000-0000-000000000000";

/** Default page size when a caller does not specify a positive `limit`. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Constructor options for {@link PredictFunAdapter}. Everything is optional and
 * defaults to a production (mainnet) configuration; tests override the transport.
 */
export interface PredictFunAdapterOptions {
  /** Resolved internal source UUID (otherwise a placeholder; registry resolves). */
  sourceId?: string;
  /** REST API base URL (default mainnet; pass {@link TESTNET_BASE_URL} for testnet). */
  baseUrl?: string;
  /** Mainnet API key sent as the `x-api-key` header. Omit for the public testnet. */
  apiKey?: string;
  /** Injected HTTP client. Defaults to a wrapper over `fetch` (or `fetchImpl`). */
  http?: HttpClient;
  /** Injected `fetch` implementation (used only when `http` is not provided). */
  fetchImpl?: FetchLike;
  /** Clock for capture timestamps (injectable for deterministic tests). */
  now?: () => Date;
}

/**
 * Predict.fun {@link MarketSource}. REST-only and stateless aside from the
 * injected HTTP client; safe to share across the ingestion orchestrator.
 *
 * Note the **absence** of `subscribePrices`: Predict.fun declares
 * `websocketPrices: false`, and the orchestrator only calls optional methods a
 * source's capabilities permit (Requirement 8.3).
 */
export class PredictFunAdapter implements MarketSource {
  readonly meta: SourceMeta;

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly http: HttpClient;
  private readonly now: () => Date;

  constructor(options: PredictFunAdapterOptions = {}) {
    this.meta = {
      id: options.sourceId ?? PLACEHOLDER_SOURCE_ID,
      key: PREDICTFUN_KEY,
      name: "Predict.fun",
      type: "onchain",
      baseCurrency: "USDB",
    };
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.apiKey = options.apiKey;
    this.http = options.http ?? createFetchHttpClient(options.fetchImpl);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Predict.fun is REST-only: no price WebSocket (Requirement 8.3). It supports
   * price history (`/timeseries`), order-book depth (`/orderbook`), and
   * cursor-based keyset pagination (Requirement 8.2).
   */
  capabilities(): SourceCapabilities {
    return {
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: true,
      keysetPagination: true,
    };
  }

  /**
   * Predict.fun has no separate cross-market "event" resource over REST — its
   * `categorySlug` groups markets for one real-world event, carried on each
   * market as {@link NormalizedMarket.eventExternalId}. Return an empty,
   * terminal page so the orchestrator groups markets directly (mirrors the
   * Manifold adapter).
   */
  fetchEvents(_opts: PageRequest): Promise<Page<NormalizedEvent>> {
    return Promise.resolve({ items: [], nextCursor: null });
  }

  /** Fetch a page of markets from `/v1/markets` (cursor-paginated). */
  async fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>> {
    const limit = positiveLimit(opts.limit);
    const decoded = decodeCursor(opts.cursor);

    let body: unknown;
    try {
      const response = await this.http.get(`${this.baseUrl}/v1/markets`, this.withAuth({
        query: {
          ...cursorToQuery(decoded, limit),
          ...incrementalQuery(opts.updatedSince),
        },
      }));
      if (!response.ok) return { items: [], nextCursor: null };
      body = await response.json();
    } catch {
      // Network/parse failure yields an empty, terminal page (never throws).
      return { items: [], nextCursor: null };
    }

    // Envelope `{ data: [...], cursor }` or a bare array (defensive).
    const rawItems = asArray(getFirstField(body, ["data", "markets", "results"]) ?? body);
    const items: NormalizedMarket[] = [];
    for (const raw of rawItems) {
      const mapped = mapMarket(raw);
      if (mapped !== null) items.push(mapped);
    }

    return {
      items,
      nextCursor: computeNextCursor({
        serverCursor: readResponseCursor(body),
        pageSize: rawItems.length,
      }),
    };
  }

  /**
   * Fetch latest price snapshots for the given markets by reading each market's
   * order book and taking the best-bid/ask mid as the Yes implied probability.
   * `marketIds` are Predict.fun market ids. Unreadable entries are skipped
   * rather than failing the batch (Requirement 1.5).
   */
  async fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]> {
    const ts = this.now().toISOString();
    const snapshots: NormalizedPriceSnapshot[] = [];

    for (const marketId of marketIds) {
      if (typeof marketId !== "string" || marketId.trim() === "") continue;
      const depth = await this.fetchOrderBookDepth(marketId);
      if (depth === null) continue;
      const snapshot = mapPriceSnapshot({
        marketExternalId: marketId,
        outcomeLabel: YES_LABEL,
        price: midImpliedProbability(depth),
        ts,
      });
      if (snapshot !== null) snapshots.push(snapshot);
    }

    return snapshots;
  }

  /**
   * Fetch price history for a market from `/v1/markets/{id}/timeseries`, mapping
   * each point's Yes share price to an implied probability (Requirement 4.2).
   * Returns an empty series on failure (never throws).
   */
  async fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]> {
    let raw: unknown;
    try {
      const response = await this.http.get(
        `${this.baseUrl}/v1/markets/${encodeURIComponent(marketId)}/timeseries`,
        this.withAuth({ query: { interval: range.interval ?? "1h" } }),
      );
      if (!response.ok) return [];
      raw = await response.json();
    } catch {
      return [];
    }

    const series = mapPriceHistory({
      marketExternalId: marketId,
      outcomeLabel: YES_LABEL,
      rawHistory: raw,
    });
    return filterToRange(series, range);
  }

  /**
   * Fetch order-book depth for a market from `/v1/markets/{id}/orderbook`
   * (Requirement 4.3). Not part of the {@link MarketSource} port, but exposed
   * because Predict.fun declares `orderBookDepth: true`; the API layer surfaces
   * it in market detail. Returns `null` on failure (never throws).
   */
  async fetchOrderBookDepth(marketId: string): Promise<NormalizedDepth | null> {
    let raw: unknown;
    try {
      const response = await this.http.get(
        `${this.baseUrl}/v1/markets/${encodeURIComponent(marketId)}/orderbook`,
        this.withAuth(),
      );
      if (!response.ok) return null;
      raw = await response.json();
    } catch {
      return null;
    }
    // The orderbook is nested under `data` in the documented envelope.
    const book = getFirstField(raw, ["data"]) ?? raw;
    return mapOrderBookDepth(book);
  }

  /**
   * Merge the `x-api-key` header into request options when an API key is
   * configured (mainnet). On the public testnet the key is omitted.
   */
  private withAuth(options: HttpGetOptions = {}): HttpGetOptions {
    if (this.apiKey === undefined) return options;
    return { ...options, headers: { "x-api-key": this.apiKey, ...options.headers } };
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Normalize a requested page size to a positive integer. */
function positiveLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
}

/** Build the incremental-sync query fragment from an optional `updatedSince`. */
function incrementalQuery(updatedSince: string | undefined): Record<string, string> {
  return updatedSince ? { updatedSince } : {};
}

/**
 * Keep only the points whose timestamp falls within `[from, to]`. Unparseable
 * range bounds are treated as unbounded so a malformed range never drops data.
 */
function filterToRange(
  series: NormalizedPriceSnapshot[],
  range: TimeRange,
): NormalizedPriceSnapshot[] {
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const lower = Number.isNaN(fromMs) ? -Infinity : fromMs;
  const upper = Number.isNaN(toMs) ? Infinity : toMs;
  return series.filter((point) => {
    const ms = Date.parse(point.ts);
    if (Number.isNaN(ms)) return false;
    return ms >= lower && ms <= upper;
  });
}

/** Remove a single trailing slash from a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Re-export transport contracts so consumers/tests can wire fakes without
// reaching into submodules.
export {
  createFetchHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpResponse,
} from "./http.js";
export { type NormalizedDepth, type OrderBookLevel } from "./mapper.js";
