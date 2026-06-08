/**
 * Polymarket adapter — a {@link MarketSource} implementation over Polymarket's
 * public APIs (design "Polymarket adapter notes"):
 *
 * - **Gamma API** (`gamma-api.polymarket.com`, no auth) → events/markets
 *   metadata with keyset pagination ({@link PolymarketAdapter.fetchEvents} /
 *   {@link PolymarketAdapter.fetchMarkets}).
 * - **CLOB API** (`clob.polymarket.com`) → price snapshot, history, and
 *   order-book depth ({@link PolymarketAdapter.fetchPriceSnapshot} /
 *   {@link PolymarketAdapter.fetchPriceHistory}).
 * - **WebSocket market channel** → live ticks
 *   ({@link PolymarketAdapter.subscribePrices}).
 *
 * The smallest unit is a binary Yes/No market backed by two Polygon outcome
 * tokens; the **Yes-token price is the implied probability**. All capabilities
 * are declared `true`.
 *
 * Testability: the HTTP client and WebSocket factory are injected (constructor
 * options) so the adapter runs WITHOUT real network access. Production defaults
 * to global `fetch` and a real WS client; tests inject fakes (tasks 4.4, 4.5).
 *
 * All upstream payloads are treated as untrusted and validated/normalized in
 * the pure {@link file://./mapper.ts | mapper} before returning; the adapter
 * never throws on missing optional fields (Requirement 1.5).
 *
 * Requirements: 8.2, 8.3 (conform + declare capabilities, gated optionals),
 * 1.1 (unified discovery shape), 4.2 (price history), 4.3 (order-book depth),
 * 10.3 (preserve raw resolution criteria).
 */

import type {
  MarketSource,
  NormalizedEvent,
  NormalizedMarket,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
  Page,
  PageRequest,
  PriceTickHandler,
  SourceCapabilities,
  SourceMeta,
  Subscription,
  TimeRange,
} from "@pma/core";

import {
  createFetchHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpResponse,
} from "./http.js";
import type { WebSocketFactory, WebSocketLike, WebSocketMessageEvent } from "./socket.js";
import { computeNextCursor, cursorToQuery, decodeCursor } from "./cursor.js";
import {
  mapEvent,
  mapMarket,
  mapOrderBookDepth,
  mapPriceHistory,
  mapPriceSnapshot,
  YES_LABEL,
  type NormalizedDepth,
} from "./mapper.js";
import { asArray, asStringOrNull, getField, getFirstField } from "./safe.js";

/** The stable source slug for Polymarket. */
export const POLYMARKET_KEY = "polymarket" as const;

/** Default Gamma API base (events/markets metadata; no auth). */
export const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
/** Default CLOB API base (price snapshot/history/depth). */
export const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";
/** Default WebSocket market-channel URL. */
export const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/** Placeholder source UUID; the registry resolves the real id at registration. */
const PLACEHOLDER_SOURCE_ID = "00000000-0000-0000-0000-000000000000";

/** Default page size when a caller does not specify a positive `limit`. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * Constructor options for {@link PolymarketAdapter}. Everything is optional and
 * defaults to a production configuration; tests override the transports.
 */
export interface PolymarketAdapterOptions {
  /** Resolved internal source UUID (otherwise a placeholder; registry resolves). */
  sourceId?: string;
  /** Gamma API base URL. */
  gammaBaseUrl?: string;
  /** CLOB API base URL. */
  clobBaseUrl?: string;
  /** WebSocket market-channel URL. */
  wsUrl?: string;
  /** Injected HTTP client. Defaults to a wrapper over `fetch` (or `fetchImpl`). */
  http?: HttpClient;
  /** Injected `fetch` implementation (used only when `http` is not provided). */
  fetchImpl?: FetchLike;
  /** Injected WebSocket factory. Required to use {@link PolymarketAdapter.subscribePrices}. */
  webSocketFactory?: WebSocketFactory;
  /** Clock for capture timestamps (injectable for deterministic tests). */
  now?: () => Date;
}

/**
 * Polymarket {@link MarketSource}. Stateless aside from injected transports;
 * safe to share across the ingestion orchestrator.
 */
export class PolymarketAdapter implements MarketSource {
  readonly meta: SourceMeta;

  private readonly gammaBaseUrl: string;
  private readonly clobBaseUrl: string;
  private readonly wsUrl: string;
  private readonly http: HttpClient;
  private readonly webSocketFactory?: WebSocketFactory;
  private readonly now: () => Date;

  constructor(options: PolymarketAdapterOptions = {}) {
    this.meta = {
      id: options.sourceId ?? PLACEHOLDER_SOURCE_ID,
      key: POLYMARKET_KEY,
      name: "Polymarket",
      type: "onchain",
      baseCurrency: "USDC",
    };
    this.gammaBaseUrl = trimTrailingSlash(options.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL);
    this.clobBaseUrl = trimTrailingSlash(options.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL);
    this.wsUrl = options.wsUrl ?? DEFAULT_WS_URL;
    this.http = options.http ?? createFetchHttpClient(options.fetchImpl);
    this.webSocketFactory = options.webSocketFactory;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Polymarket supports every optional capability: WebSocket prices, price
   * history, order-book depth (CLOB), and keyset pagination (Requirement 8.2).
   */
  capabilities(): SourceCapabilities {
    return {
      websocketPrices: true,
      priceHistory: true,
      orderBookDepth: true,
      keysetPagination: true,
    };
  }

  /** Fetch a page of events from the Gamma `/events` endpoint (keyset paginated). */
  async fetchEvents(opts: PageRequest): Promise<Page<NormalizedEvent>> {
    const limit = positiveLimit(opts.limit);
    const decoded = decodeCursor(opts.cursor);
    const response = await this.http.get(`${this.gammaBaseUrl}/events`, {
      query: {
        ...cursorToQuery(decoded, limit),
        ...incrementalQuery(opts.updatedSince),
        order: "id",
        ascending: true,
      },
    });

    const { items: rawItems, nativeToken } = await readGammaPage(response);
    const items: NormalizedEvent[] = [];
    for (const raw of rawItems) {
      const mapped = mapEvent(raw);
      if (mapped !== null) items.push(mapped);
    }

    return {
      items,
      nextCursor: computeNextCursor({
        current: decoded,
        nativeToken,
        pageSize: rawItems.length,
        limit,
      }),
    };
  }

  /** Fetch a page of markets from the Gamma `/markets` endpoint (keyset paginated). */
  async fetchMarkets(opts: PageRequest): Promise<Page<NormalizedMarket>> {
    const limit = positiveLimit(opts.limit);
    const decoded = decodeCursor(opts.cursor);
    const response = await this.http.get(`${this.gammaBaseUrl}/markets`, {
      query: {
        ...cursorToQuery(decoded, limit),
        ...incrementalQuery(opts.updatedSince),
        order: "id",
        ascending: true,
      },
    });

    const { items: rawItems, nativeToken } = await readGammaPage(response);
    const items: NormalizedMarket[] = [];
    for (const raw of rawItems) {
      const mapped = mapMarket(raw);
      if (mapped !== null) items.push(mapped);
    }

    return {
      items,
      nextCursor: computeNextCursor({
        current: decoded,
        nativeToken,
        pageSize: rawItems.length,
        limit,
      }),
    };
  }

  /**
   * Fetch latest price snapshots for the given markets from the CLOB `/price`
   * endpoint. `marketIds` are CLOB token ids (the Yes token for the Yes
   * probability). Unreadable entries are skipped (Requirement 1.5).
   */
  async fetchPriceSnapshot(marketIds: string[]): Promise<NormalizedPriceSnapshot[]> {
    const ts = this.now().toISOString();
    const snapshots: NormalizedPriceSnapshot[] = [];

    for (const tokenId of marketIds) {
      if (typeof tokenId !== "string" || tokenId.trim() === "") continue;
      let raw: unknown;
      try {
        const response = await this.http.get(`${this.clobBaseUrl}/price`, {
          query: { token_id: tokenId, side: "buy" },
        });
        if (!response.ok) continue;
        raw = await response.json();
      } catch {
        // Network/parse failure for one token must not fail the whole batch.
        continue;
      }
      const snapshot = mapPriceSnapshot({
        marketExternalId: tokenId,
        outcomeLabel: YES_LABEL,
        rawPrice: getFirstField(raw, ["price", "mid", "value"]),
        ts,
      });
      if (snapshot !== null) snapshots.push(snapshot);
    }

    return snapshots;
  }

  /**
   * Fetch price history for a market (token) from the CLOB `/prices-history`
   * endpoint, mapping each point's Yes-token price to an implied probability
   * (Requirement 4.2).
   */
  async fetchPriceHistory(marketId: string, range: TimeRange): Promise<NormalizedPricePoint[]> {
    let raw: unknown;
    try {
      const response = await this.http.get(`${this.clobBaseUrl}/prices-history`, {
        query: {
          market: marketId,
          startTs: toEpochSeconds(range.from),
          endTs: toEpochSeconds(range.to),
          fidelity: intervalToFidelity(range.interval),
        },
      });
      if (!response.ok) return [];
      raw = await response.json();
    } catch {
      return [];
    }

    return mapPriceHistory({
      marketExternalId: marketId,
      outcomeLabel: YES_LABEL,
      rawHistory: raw,
    });
  }

  /**
   * Fetch order-book depth for a token from the CLOB `/book` endpoint
   * (Requirement 4.3). Not part of the {@link MarketSource} port, but exposed
   * because Polymarket declares `orderBookDepth: true`; the API layer surfaces
   * it in market detail.
   */
  async fetchOrderBookDepth(tokenId: string): Promise<NormalizedDepth | null> {
    let raw: unknown;
    try {
      const response = await this.http.get(`${this.clobBaseUrl}/book`, {
        query: { token_id: tokenId },
      });
      if (!response.ok) return null;
      raw = await response.json();
    } catch {
      return null;
    }
    return mapOrderBookDepth(raw);
  }

  /**
   * Subscribe to live price ticks over the WebSocket market channel
   * (Requirement 8.3 — present because `websocketPrices === true`).
   *
   * `marketIds` are CLOB token (asset) ids. The returned {@link Subscription}
   * exposes `close()` and `isOpen`; the orchestrator drives reconnect-with-
   * backoff on top of it. Inbound frames are normalized in the pure mapper and
   * dispatched to `handler`; malformed frames are ignored, never thrown.
   */
  subscribePrices(marketIds: string[], handler: PriceTickHandler): Subscription {
    if (!this.webSocketFactory) {
      throw new Error("PolymarketAdapter.subscribePrices requires options.webSocketFactory");
    }

    const assetIds = marketIds.filter(
      (id): id is string => typeof id === "string" && id.trim() !== "",
    );

    const socket: WebSocketLike = this.webSocketFactory(this.wsUrl);
    const subscription = new PolymarketSubscription(socket);

    socket.addEventListener("open", () => {
      subscription.markOpen();
      // The market channel expects the list of asset (token) ids to watch.
      socket.send(JSON.stringify({ type: "market", assets_ids: assetIds }));
    });

    socket.addEventListener("message", (event: unknown) => {
      const ts = this.now().toISOString();
      for (const tick of parseTickFrame(event, ts)) {
        try {
          handler(tick);
        } catch {
          // A faulty handler must not tear down the stream.
        }
      }
    });

    socket.addEventListener("close", () => subscription.markClosed());
    socket.addEventListener("error", () => subscription.markClosed());

    return subscription;
  }
}

/**
 * {@link Subscription} backed by a {@link WebSocketLike}. Tracks open state and
 * tears the socket down on {@link close}.
 */
class PolymarketSubscription implements Subscription {
  private open = false;
  private disposed = false;

  constructor(private readonly socket: WebSocketLike) {}

  get isOpen(): boolean {
    return this.open && !this.disposed;
  }

  /** @internal */ markOpen(): void {
    if (!this.disposed) this.open = true;
  }

  /** @internal */ markClosed(): void {
    this.open = false;
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.open = false;
    try {
      this.socket.close();
    } catch {
      // Closing an already-closed socket must be safe.
    }
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
  return updatedSince ? { start_date_min: updatedSince } : {};
}

/**
 * Read a Gamma page response, supporting both shapes:
 * - newer keyset: `{ data: [...], next_cursor: "..." }`
 * - legacy/offset: a bare `[...]` array (no native token).
 * Never throws on a non-OK or malformed body — yields an empty page.
 */
async function readGammaPage(
  response: HttpResponse,
): Promise<{ items: unknown[]; nativeToken: string | null }> {
  if (!response.ok) return { items: [], nativeToken: null };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { items: [], nativeToken: null };
  }

  if (Array.isArray(body)) {
    return { items: body, nativeToken: null };
  }

  const data = getFirstField(body, ["data", "results", "events", "markets"]);
  const items = asArray(data);
  const nativeToken = asStringOrNull(getFirstField(body, ["next_cursor", "nextCursor"]));
  return { items, nativeToken };
}

/** Convert an ISO timestamp to epoch seconds for CLOB history queries. */
function toEpochSeconds(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/** Map a normalized interval to the CLOB `fidelity` (minutes-per-point). */
function intervalToFidelity(interval: TimeRange["interval"]): number {
  switch (interval) {
    case "1m":
      return 1;
    case "5m":
      return 5;
    case "1h":
      return 60;
    case "1d":
      return 1440;
    default:
      return 60;
  }
}

/**
 * Parse an inbound WS frame into zero or more normalized ticks. The market
 * channel delivers either a single event object or an array of them; each
 * carries `asset_id` and `price`. Unparseable frames yield `[]`.
 */
function parseTickFrame(event: unknown, ts: string): NormalizedPriceSnapshot[] {
  const data = extractFrameData(event);
  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      return [];
    }
  }

  const events = Array.isArray(parsed) ? parsed : [parsed];
  const ticks: NormalizedPriceSnapshot[] = [];
  for (const item of events) {
    const tokenId = asStringOrNull(
      getFirstField(item, ["asset_id", "assetId", "token_id", "tokenId"]),
    );
    if (tokenId === null) continue;
    const frameTs =
      asStringOrNull(getField(item, "timestamp")) !== null
        ? (isoFromUnknown(getField(item, "timestamp")) ?? ts)
        : ts;
    const tick = mapPriceSnapshot({
      marketExternalId: tokenId,
      outcomeLabel: YES_LABEL,
      rawPrice: getFirstField(item, ["price", "value", "p"]),
      ts: frameTs,
    });
    if (tick !== null) ticks.push(tick);
  }
  return ticks;
}

/** Pull the `data` field from a WS message event (or the event itself). */
function extractFrameData(event: unknown): unknown {
  if (event && typeof event === "object" && "data" in event) {
    return (event as WebSocketMessageEvent).data;
  }
  return event;
}

/** Best-effort ISO conversion of a WS frame timestamp (epoch ms/s or ISO). */
function isoFromUnknown(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const ms = n < 1e12 ? n * 1000 : n;
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  return null;
}

/** Remove a single trailing slash from a base URL. */
function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Re-export transport contracts and the test fake so consumers/tests can wire
// fakes without reaching into submodules.
export {
  createFetchHttpClient,
  type FetchLike,
  type HttpClient,
  type HttpResponse,
} from "./http.js";
export { FakeWebSocket, type WebSocketFactory, type WebSocketLike } from "./socket.js";
export { type NormalizedDepth, type OrderBookLevel } from "./mapper.js";
