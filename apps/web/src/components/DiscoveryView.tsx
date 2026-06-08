"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getApiClient, type ApiClient, type MarketListFilters } from "../lib/api-client";
import type { Category, MarketStatus, MarketSortKey, MarketSummary } from "../lib/dto";
import { DiscoveryControls, type DiscoveryControlValue } from "./DiscoveryControls";
import { MarketList } from "./MarketList";

/** Loading lifecycle for the discovery fetch. */
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; markets: MarketSummary[] };

/** Read the control value out of the URL search params. */
function valueFromParams(params: URLSearchParams): DiscoveryControlValue {
  return {
    q: params.get("q") ?? "",
    category: (params.get("category") as Category | null) ?? "",
    status: (params.get("status") as MarketStatus | null) ?? "",
    sort: (params.get("sort") as MarketSortKey | null) ?? "",
  };
}

/** Serialize the control value back into a URL query string (omitting empties). */
function paramsFromValue(value: DiscoveryControlValue): string {
  const search = new URLSearchParams();
  if (value.q) search.set("q", value.q);
  if (value.category) search.set("category", value.category);
  if (value.status) search.set("status", value.status);
  if (value.sort) search.set("sort", value.sort);
  const qs = search.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

/** Map the control value onto the API client's filter object. */
function filtersFromValue(value: DiscoveryControlValue): MarketListFilters {
  const filters: MarketListFilters = {};
  if (value.q) filters.q = value.q;
  if (value.category) filters.category = value.category;
  if (value.status) filters.status = value.status;
  if (value.sort) {
    filters.sort = value.sort;
    // Sort metrics read best high→low; time-remaining ascending (soonest first).
    filters.order = value.sort === "timeRemaining" ? "asc" : "desc";
  }
  return filters;
}

export interface DiscoveryViewProps {
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
}

/**
 * The discovery page body (Requirements 1.1, 1.2, 1.4, 1.5, 9.1). Owns the
 * filter/search/sort state (synced to the URL so views are shareable),
 * fetches `GET /api/markets` through the project API client, and renders
 * loading / error / empty / ready states.
 */
export function DiscoveryView({ client }: DiscoveryViewProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const api = useMemo(() => client ?? getApiClient(), [client]);

  // Derive the canonical control value from the URL each render.
  const value = useMemo(
    () => valueFromParams(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // Push a new control value into the URL (shallow client navigation).
  const handleChange = useCallback(
    (next: DiscoveryControlValue) => {
      router.push(`/${paramsFromValue(next)}`);
    },
    [router],
  );

  // Fetch whenever the effective filters change.
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .listMarkets(filtersFromValue(value), controller.signal)
      .then((res) => setState({ kind: "ready", markets: res.markets }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to load markets";
        setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [api, value]);

  return (
    <section aria-labelledby="discovery-heading">
      <h2 id="discovery-heading">Discover markets</h2>
      <p className="subtle">
        Unified across platforms — implied probability, volume, liquidity, and time remaining, side
        by side.
      </p>

      <DiscoveryControls value={value} onChange={handleChange} />

      {state.kind === "loading" && (
        <p className="state" role="status">
          Loading markets…
        </p>
      )}
      {state.kind === "error" && (
        <p className="state error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && <MarketList markets={state.markets} />}
    </section>
  );
}
