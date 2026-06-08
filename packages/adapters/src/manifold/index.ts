/**
 * Manifold adapter — a {@link MarketSource} implementation over Manifold's
 * public REST API (design "Manifold adapter notes"):
 *
 * - **REST only** (`api.manifold.markets/v0`, no auth). Manifold "markets" are
 *   called *contracts*. `fetchMarkets` reads `/v0/markets` with keyset
 *   pagination via the `before=<contractId>` parameter and `limit`.
 * - A binary contract's **`probability` field is the Yes implied probability**;
 *   `fetchPriceSnapshot` derives the latest price from it.
 * - `fetchPriceHistory` maps the `/v0/bets` endpoint (each bet carries
 *   `probAfter` + `createdTime`) into a Yes-outcome price series for
 *   backfill/curves (Requirement 4.2).
 *
 * Capabilities: `websocketPrices = false` (Manifold has **no** native
 * WebSocket) → the orchestrator routes all Manifold markets through tiered
 * polling and MUST NOT call a subscription (Requirement 8.3). Accordingly this
 * class deliberately implements **no** `subscribePrices` method. `priceHistory`
 * and `keysetPagination` are `true`; `orderBookDepth` is `false` (Manifold uses
 * an AMM, not an order book).
 *
 * SourceType choice: Manifold is a **play-money** platform (MANA), not a
 * regulated venue and not a centralized cash exchange. Given the
 * `"onchain" | "cex" | "regulated"` union, none is a perfect fit; `"onchain"`
 * is the closest and the design's recommended default (Manifold groups with
 * Polymarket as a non-regulated, crypto-adjacent venue), so we use `"onchain"`
 * with `baseCurrency: "MANA"`.
 *
 * Testability: the HTTP client is injected (constructor options) so the adapter
 * runs WITHOUT real network access. Production defaults to global `fetch`;
 * tests inject a fake. All upstream payloads are treated as untrusted and
 * validated/normalized in the pure {@link file://./mapper.ts | mapper} before
 * returning; the adapter never throws on missing optional fields (Requirement
 * 1.5).
 *
 * Requirements: 8.2, 8.3 (conform + declare capabilities, gated optionals),
 * 1.1 (unified discovery shape), 4.2 (price history), 10.3 (preserve raw
 * resolution criteria).
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

import { createFetchHttpClient, type FetchLike, type HttpClient } from "./http.js";
import { computeNextCursor, cursorToQuery, decodeCursor } from "./cursor.js";
import { mapBetsToPriceHistory, mapMarket, mapPriceSnapshot } from "./mapper.js";
import { asArray, asStringOrNull, getField } from "./safe.js";

/** The stable source slug for Manifold. */
export const MANIFOLD_KEY = "manifold" as const;

/** Default Manifold REST API base (no auth). */
export const DEFAULT_REST_BASE_URL = "https://api.manifold.markets";

/** Placeholder source UUID; the registry resolves the real id at registration. */
const PLACEHOLDER_SOURCE_ID = "00000000-0000-0000-0000-000000000000";

/** Default page size when a caller does not specify a positive `limit`. */
const DEFAULT_PAGE_SIZE = 100;

/** Default number of bets fetched per price-history request. */
const DEFAULT_BETS_LIMIT = 1000;

/**
 * Constructor options for {@link ManifoldAdapter}. Everything is optional and
 * defaults to a production configuration; tests override the transport.
 */
export interface ManifoldAdapterOptions {
  /** Resolved internal source UUID (otherwise a placeholder; registry resolves). */
  sourceId?: string;
  /** Manifold REST API base URL. */
  restBaseUrl?: string;
  /** Injected HTTP client. Defaults to a wrapper over `fetch` (or `fetchImpl`). */
  http?: HttpClient;
  /** Injected `fetch` implementation (used only when `http` is not provided). */
  fetchImpl?: FetchLike;
  /** Number of bets fetched per price-history request. */
  betsLimit?: number;
  /** Clock for capture timestamps (injectable for deterministic tests). */
  now?: () => Date;
}

/**
 * Manifold {@link MarketSource}. REST-only and stateless aside from the
 * injected HTTP client; safe to share across the ingestion orchestrator.
 *
 * Note the **absence** of `subscribePrices`: Manifold declares
 * `websocketPrices: false`, and the orchestrator only calls optional methods a
 * source's capabilities permit (Requirement 8.3).
 */
export class ManifoldAdapter implements MarketSource {
  readonly meta: SourceMeta;

  private readonly restBaseUrl: string;
  private readonly http: HttpClient;
  private readonly betsLimit: number;
  private readonly now: () => Date;

  constructor(options: ManifoldAdapterOptions = {}) {
    this.meta = {
      id: options.sourceId ?? PLACEHOLDER_SOURCE_ID,
      key: MANIFOLD_KEY,
      name: "Manifold",
      // Play-money (MANA) venue; "onchain" is the closest fit in the
      // SourceType union and the design's recommended default (see file header).
      type: "onchain",
      baseCurrency: "MANA",
    };
    this.restBaseUrl = trimTrailingSlash(options.restBaseUrl ?? DEFAULT_REST_BASE_URL);
    this.http = options.http ?? createFetchHttpClient(options.fetchImpl);
    this.betsLimit = positiveLimit(options.betsLimit ?? DEFAULT_BETS_LIMIT);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Manifold is REST-only: no WebSocket (Requirement 8.3) and no order book
   * (AMM). It does support price history (via `/v0/bets`) and keyset pagination
   * (via `before`) (Requirement 8.2).
   */
  capabilities(): SourceCapabilities {
    return {
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: false,
      keysetPagination: true,
    };
  }

  /**
   * Manifold has no first-class cross-market "event" resource, so there is
   * nothing to page over here: events are derived from group slugs on the
   * markets themselves ({@link NormalizedMarket.eventExternalId}). Return an
   * empty, terminal page so the orchestrator groups markets directly.
   */
  fetchEvents(_opts: PageRequest): Promise<Page<NormalizedEvent>> {
    return Promise.resolve({ items: [], nextCursor: null });
  }

  /** Fetch a page of markets from `/v0/markets` (keyset paginated via `before`). */
  async fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>> {
    const limit = positiveLimit(opts.limit);
    const decoded = decodeCursor(opts.cursor);
    const now = this.now();

    let rawItems: unknown[] = [];
    try {
      const response = await this.http.get(`${this.restBaseUrl}/v0/markets`, {
        query: cursorToQuery(decoded, limit),
      });
      if (response.ok) rawItems = asArray(await response.json());
    } catch {
      // Network/parse failure yields an empty, terminal page (never throws).
      return { items: [], nextCursor: null };
    }

    const items: NormalizedMarket[] = [];
    for (const raw of rawItems) {
      const mapped = mapMarket(raw, now);
      if (mapped !== null) items.push(mapped);
    }

    // The next page is everything *before* the last contract on this page.
    const lastId = asStringOrNull(getField(rawItems[rawItems.length - 1], "id"));
    return {
      items,
      nextCursor: computeNextCursor({
        lastId,
        pageSize: rawItems.length,
        limit,
      }),
    };
  }

  /**
   * Fetch latest price snapshots for the given contracts by reading each
   * contract's current Yes `probability` from `/v0/market/{id}`. Unreadable
   * entries are skipped rather than failing the batch (Requirement 1.5).
   */
  async fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]> {
    const ts = this.now().toISOString();
    const snapshots: NormalizedPriceSnapshot[] = [];

    for (const marketId of marketIds) {
      if (typeof marketId !== "string" || marketId.trim() === "") continue;
      let raw: unknown;
      try {
        const response = await this.http.get(
          `${this.restBaseUrl}/v0/market/${encodeURIComponent(marketId)}`,
        );
        if (!response.ok) continue;
        raw = await response.json();
      } catch {
        // One bad contract must not fail the whole batch.
        continue;
      }
      const snapshot = mapPriceSnapshot({
        marketExternalId: marketId,
        rawProbability: getField(raw, "probability"),
        volume: getField(raw, "volume"),
        ts,
      });
      if (snapshot !== null) snapshots.push(snapshot);
    }

    return snapshots;
  }

  /**
   * Fetch price history for a contract from the `/v0/bets` endpoint, mapping
   * each bet's `probAfter` (Yes probability after the bet) and `createdTime`
   * into an ascending Yes-outcome price series, then filtering to the requested
   * range (Requirement 4.2). Returns an empty series on failure (never throws).
   */
  async fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]> {
    let raw: unknown;
    try {
      const response = await this.http.get(`${this.restBaseUrl}/v0/bets`, {
        query: { contractId: marketId, limit: this.betsLimit },
      });
      if (!response.ok) return [];
      raw = await response.json();
    } catch {
      return [];
    }

    const series = mapBetsToPriceHistory({
      marketExternalId: marketId,
      rawBets: raw,
    });
    return filterToRange(series, range);
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Normalize a requested page size to a positive integer. */
function positiveLimit(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_SIZE;
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
