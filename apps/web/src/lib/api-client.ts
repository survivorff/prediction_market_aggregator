/**
 * Typed client for the project's OWN API gateway (`@pma/api`).
 *
 * Requirement 9.1: the frontend reads discovery / detail / history / sources
 * data EXCLUSIVELY from the system's own REST endpoints — never from an
 * upstream platform API. This module is the single chokepoint that enforces
 * that: every request is built against one configured base URL, and there is no
 * code path that constructs an upstream (polymarket.com / manifold) URL.
 *
 * The client is a factory over an injectable config (`baseUrl` + `fetch`) so it
 * is trivially unit-testable: tests pass a fake `fetch` and assert the exact
 * URL + query string, proving the request targets only the configured base
 * (see `api-client.test.ts`). In the app, `getApiClient()` reads
 * `NEXT_PUBLIC_API_BASE_URL` and uses the global `fetch`.
 */

import type {
  MarketDetail,
  MarketListResponse,
  MarketSortKey,
  MarketStatus,
  Category,
  CanonicalEventListResponse,
  ComparisonView,
  PriceHistoryResponse,
  SignalListResponse,
  SortOrder,
  SourceListResponse,
  TradeLink,
  AddWatchlistBody,
  WatchlistItem,
  WatchlistListResponse,
} from "./dto";

/** Discovery filters mapped onto `GET /api/markets` query params. */
export interface MarketListFilters {
  category?: Category;
  status?: MarketStatus;
  q?: string;
  sort?: MarketSortKey;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

/** Filters mapped onto `GET /api/canonical-events` query params. */
export interface CanonicalEventListFilters {
  category?: Category;
}

/** Query mapped onto `GET /api/signals` params. */
export interface SignalListQuery {
  limit?: number;
}

/** Price-history query mapped onto `GET /api/markets/{id}/history` params. */
export interface HistoryQuery {
  from?: string;
  to?: string;
  interval?: "1m" | "5m" | "1h" | "1d";
}

/** Minimal `fetch` shape the client depends on (the global `fetch` satisfies it). */
export type FetchLike = (
  input: string,
  init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}>;

/** Client configuration. */
export interface ApiClientConfig {
  /** Base URL of the project's API gateway, e.g. `http://localhost:4000`. */
  baseUrl: string;
  /** Injectable fetch (defaults to the global `fetch`). */
  fetch?: FetchLike;
  /**
   * Resolver for the bearer token sent on user-scoped requests (watchlist).
   * Returns the current token, or `undefined`/empty when the user is not
   * authenticated. Kept as a function so the token can be read lazily per
   * request (e.g. after a token is acquired) rather than frozen at construction.
   *
   * NOTE: login / token acquisition is intentionally OUT OF SCOPE for this
   * client — it accepts a token that is provided to it. In the app the default
   * resolver reads `NEXT_PUBLIC_API_TOKEN` (see {@link resolveDevToken}); a real
   * deployment would inject a resolver backed by its own auth/session.
   */
  getToken?: () => string | undefined;
}

/** Thrown when the gateway returns a non-2xx response. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly path: string,
  ) {
    super(`API request failed: ${status} ${statusText} (${path})`);
    this.name = "ApiError";
  }
}

/**
 * Thrown when a user-scoped request is attempted without a configured token.
 * The watchlist endpoints require authentication (Requirement 9.4); rather than
 * issuing a request we know will be rejected with 401, the client fails fast
 * with this typed error so the UI can render a friendly "sign in" state instead
 * of crashing.
 */
export class MissingTokenError extends Error {
  constructor(readonly path: string) {
    super(`Authentication required for ${path} but no token is configured`);
    this.name = "MissingTokenError";
  }
}

/** Public surface of the API client. */
export interface ApiClient {
  /** `GET /api/markets` — unified discovery (Requirements 1.1, 1.2, 1.4). */
  listMarkets(filters?: MarketListFilters, signal?: AbortSignal): Promise<MarketListResponse>;
  /** `GET /api/markets/{id}` — market detail (Requirement 4.1). */
  getMarket(id: string, signal?: AbortSignal): Promise<MarketDetail>;
  /** `GET /api/markets/{id}/history` — price-history curve (Requirement 4.2). */
  getMarketHistory(
    id: string,
    query?: HistoryQuery,
    signal?: AbortSignal,
  ): Promise<PriceHistoryResponse>;
  /** `GET /api/sources` — registered platforms + capabilities. */
  listSources(signal?: AbortSignal): Promise<SourceListResponse>;
  /** `GET /api/markets/{id}/trade-link` — outbound deep-link (navigation only). */
  getTradeLink(id: string, signal?: AbortSignal): Promise<TradeLink>;
  /** `GET /api/canonical-events` — cross-platform groupings (Requirement 2.1). */
  listCanonicalEvents(
    filters?: CanonicalEventListFilters,
    signal?: AbortSignal,
  ): Promise<CanonicalEventListResponse>;
  /** `GET /api/canonical-events/{id}` — same-question comparison view (Req 2.1, 2.3). */
  getCanonicalEvent(id: string, signal?: AbortSignal): Promise<ComparisonView>;
  /** `GET /api/signals` — display-only spread signals ranked by gap (Req 3.1, 3.3). */
  listSignals(query?: SignalListQuery, signal?: AbortSignal): Promise<SignalListResponse>;
  /**
   * `GET /api/watchlist` — the authenticated user's watchlist (Requirement
   * 9.4). Requires a configured token; throws {@link MissingTokenError} when
   * none is available.
   */
  listWatchlist(signal?: AbortSignal): Promise<WatchlistListResponse>;
  /**
   * `POST /api/watchlist` — add a market/canonical event to the watchlist
   * (Requirement 5.1). Idempotent: re-adding the same target returns the
   * existing item. Requires a configured token.
   */
  addWatchlist(body: AddWatchlistBody, signal?: AbortSignal): Promise<WatchlistItem>;
  /**
   * `DELETE /api/watchlist/{itemId}` — remove a watchlist entry (Requirement
   * 5.4). Resolves on 204; throws {@link ApiError} (404) for an unknown/un-owned
   * item. Requires a configured token.
   */
  deleteWatchlist(itemId: string, signal?: AbortSignal): Promise<void>;
  /** True when a non-empty auth token is currently configured (UI gating). */
  hasToken(): boolean;
}

/** Strip a single trailing slash so we can join paths predictably. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Append defined params to a `URLSearchParams`. `undefined`/empty values are
 * omitted so the gateway applies its own defaults (e.g. no `sort` → stored
 * order). Numbers are stringified; everything else is passed through as a
 * string. The ordering is deterministic for stable, testable URLs.
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/**
 * Create an {@link ApiClient} bound to one gateway base URL. Every method
 * builds its URL from `config.baseUrl` and nothing else — the structural
 * guarantee behind Requirement 9.1.
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const doFetch: FetchLike =
    config.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));

  /** Read + trim the configured token; `undefined` when absent/blank. */
  function currentToken(): string | undefined {
    const raw = config.getToken?.();
    if (raw === undefined || raw === null) return undefined;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  /** Build request init, attaching `Authorization: Bearer <token>` when authed. */
  function buildInit(opts: {
    signal?: AbortSignal;
    method?: string;
    body?: unknown;
    authed?: boolean;
    path: string;
  }): { signal?: AbortSignal; method?: string; body?: string; headers?: Record<string, string> } {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.authed) {
      const token = currentToken();
      if (token === undefined) throw new MissingTokenError(opts.path);
      headers["Authorization"] = `Bearer ${token}`;
    }
    const init: {
      signal?: AbortSignal;
      method?: string;
      body?: string;
      headers?: Record<string, string>;
    } = {};
    if (opts.signal) init.signal = opts.signal;
    if (opts.method) init.method = opts.method;
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (Object.keys(headers).length > 0) init.headers = headers;
    return init;
  }

  async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = `${baseUrl}${path}`;
    const init = buildInit({ signal, path });
    const response = await doFetch(url, Object.keys(init).length > 0 ? init : undefined);
    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, path);
    }
    return (await response.json()) as T;
  }

  /**
   * Issue a user-scoped request with a bearer token (Requirement 9.4). Fails
   * fast with {@link MissingTokenError} when no token is configured instead of
   * sending a request that the gateway would reject with 401.
   */
  async function authedRequest<T>(
    path: string,
    opts: { method?: string; body?: unknown; signal?: AbortSignal; expectNoContent?: boolean } = {},
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const init = buildInit({
      signal: opts.signal,
      method: opts.method,
      body: opts.body,
      authed: true,
      path,
    });
    const response = await doFetch(url, init);
    if (!response.ok) {
      throw new ApiError(response.status, response.statusText, path);
    }
    if (opts.expectNoContent) return undefined as T;
    return (await response.json()) as T;
  }

  return {
    listMarkets(filters: MarketListFilters = {}, signal?: AbortSignal) {
      const query = buildQuery({
        category: filters.category,
        status: filters.status,
        q: filters.q,
        sort: filters.sort,
        order: filters.order,
        limit: filters.limit,
        offset: filters.offset,
      });
      return request<MarketListResponse>(`/api/markets${query}`, signal);
    },

    getMarket(id: string, signal?: AbortSignal) {
      return request<MarketDetail>(`/api/markets/${encodeURIComponent(id)}`, signal);
    },

    getMarketHistory(id: string, query: HistoryQuery = {}, signal?: AbortSignal) {
      const qs = buildQuery({
        from: query.from,
        to: query.to,
        interval: query.interval,
      });
      return request<PriceHistoryResponse>(
        `/api/markets/${encodeURIComponent(id)}/history${qs}`,
        signal,
      );
    },

    listSources(signal?: AbortSignal) {
      return request<SourceListResponse>(`/api/sources`, signal);
    },

    getTradeLink(id: string, signal?: AbortSignal) {
      return request<TradeLink>(`/api/markets/${encodeURIComponent(id)}/trade-link`, signal);
    },

    listCanonicalEvents(filters: CanonicalEventListFilters = {}, signal?: AbortSignal) {
      const query = buildQuery({ category: filters.category });
      return request<CanonicalEventListResponse>(`/api/canonical-events${query}`, signal);
    },

    getCanonicalEvent(id: string, signal?: AbortSignal) {
      return request<ComparisonView>(`/api/canonical-events/${encodeURIComponent(id)}`, signal);
    },

    listSignals(query: SignalListQuery = {}, signal?: AbortSignal) {
      const qs = buildQuery({ limit: query.limit });
      return request<SignalListResponse>(`/api/signals${qs}`, signal);
    },

    listWatchlist(signal?: AbortSignal) {
      return authedRequest<WatchlistListResponse>(`/api/watchlist`, { signal });
    },

    addWatchlist(body: AddWatchlistBody, signal?: AbortSignal) {
      return authedRequest<WatchlistItem>(`/api/watchlist`, {
        method: "POST",
        body,
        signal,
      });
    },

    deleteWatchlist(itemId: string, signal?: AbortSignal) {
      return authedRequest<void>(`/api/watchlist/${encodeURIComponent(itemId)}`, {
        method: "DELETE",
        signal,
        expectNoContent: true,
      });
    },

    hasToken() {
      return currentToken() !== undefined;
    },
  };
}

/**
 * Default API base URL when `NEXT_PUBLIC_API_BASE_URL` is unset (local dev:
 * the gateway's `API_PORT` default of 4000).
 */
export const DEFAULT_API_BASE_URL = "http://localhost:4000";

/**
 * Resolve the configured gateway base URL from the environment. Centralized so
 * the "talk only to our API" base is defined in exactly one place
 * (Requirement 9.1).
 */
export function resolveApiBaseUrl(): string {
  const fromEnv = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_BASE_URL : undefined;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_API_BASE_URL;
}

/**
 * Build an absolute, outbound href for a gateway-provided relative trade-link
 * path (e.g. `/api/markets/{id}/trade-link`). The deep-link endpoint is the
 * single outbound "Go trade" seam (Requirement 6.1); resolving it through the
 * configured gateway base keeps the Requirement 9.1 chokepoint intact (the UI
 * never hardcodes an upstream platform URL).
 */
export function tradeLinkHref(path: string): string {
  return `${normalizeBaseUrl(resolveApiBaseUrl())}${path}`;
}

let singleton: ApiClient | undefined;

/**
 * Resolve the dev/bearer token for user-scoped requests (watchlist) from the
 * environment. Login / token acquisition is OUT OF SCOPE for v1 (Requirement
 * 9.4 only requires that user-scoped resources are authenticated); this reads a
 * provided token from `NEXT_PUBLIC_API_TOKEN` so a local/dev deployment can
 * exercise the watchlist without a full auth flow. Returns `undefined` when
 * unset, which the UI surfaces as a friendly "sign in" state rather than a
 * crash. A real deployment injects its own token resolver into
 * {@link createApiClient}.
 */
export function resolveDevToken(): string | undefined {
  const fromEnv = typeof process !== "undefined" ? process.env.NEXT_PUBLIC_API_TOKEN : undefined;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : undefined;
}

/**
 * The app-wide {@link ApiClient}, bound to `NEXT_PUBLIC_API_BASE_URL` and the
 * global `fetch`. Memoized so repeated calls share one instance.
 */
export function getApiClient(): ApiClient {
  if (singleton === undefined) {
    singleton = createApiClient({
      baseUrl: resolveApiBaseUrl(),
      getToken: resolveDevToken,
    });
  }
  return singleton;
}
