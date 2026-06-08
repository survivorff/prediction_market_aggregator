/**
 * Injectable HTTP transport for the Predict.fun adapter.
 *
 * The adapter never closes over the global `fetch` directly; it depends on the
 * narrow {@link HttpClient} below. Production defaults to a thin wrapper over
 * global `fetch`, while tests inject a fake that returns recorded payloads —
 * so the adapter is fully unit-testable WITHOUT real network calls.
 *
 * This mirrors the Polymarket/Manifold adapters' `http.ts` so each adapter
 * folder stays self-contained (Requirement 8.1 — adding a platform is a
 * localized change). Predict.fun's mainnet API requires an `x-api-key` header;
 * the testnet API is public, so the key is optional and supplied per request by
 * the adapter (see index.ts).
 */

/** A minimal HTTP response surface the adapter relies on. */
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** Options for a single GET request. */
export interface HttpGetOptions {
  /** Query parameters; `undefined`/`null` values are omitted. */
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Extra request headers (e.g. `x-api-key` for Predict.fun mainnet). */
  headers?: Record<string, string>;
  /** Optional abort signal for cancellation/timeout. */
  signal?: AbortSignal;
}

/**
 * The narrow HTTP contract used by the adapter. Only GET is needed: v1 is
 * strictly read-only (Requirement 12.1) — the adapter performs no writes (it
 * never touches Predict.fun's authenticated order-placement endpoints).
 */
export interface HttpClient {
  get(url: string, options?: HttpGetOptions): Promise<HttpResponse>;
}

/** The `fetch` shape we depend on (subset of the DOM/Node `fetch`). */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<HttpResponse>;

/**
 * Build an {@link HttpClient} over a `fetch`-like function. Defaults to the
 * global `fetch`; pass a fake in tests.
 */
export function createFetchHttpClient(fetchImpl?: FetchLike): HttpClient {
  const doFetch: FetchLike = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  if (typeof doFetch !== "function") {
    throw new Error(
      "No fetch implementation available; pass one via PredictFunAdapter options.http",
    );
  }

  return {
    async get(url, options) {
      const finalUrl = appendQuery(url, options?.query);
      return doFetch(finalUrl, {
        method: "GET",
        headers: { accept: "application/json", ...options?.headers },
        signal: options?.signal,
      });
    },
  };
}

/** Append a query object to a URL, skipping `undefined`/`null` values. */
export function appendQuery(
  url: string,
  query?: Record<string, string | number | boolean | undefined | null>,
): string {
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  if (qs === "") return url;
  return url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
}
