"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getApiClient, type ApiClient, type CanonicalEventListFilters } from "../lib/api-client";
import { CATEGORIES, type Category, type CanonicalEventSummary } from "../lib/dto";
import { titleCase } from "../lib/format";
import { CanonicalEventList } from "./CanonicalEventList";

/** Loading lifecycle for the canonical-events fetch. */
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; events: CanonicalEventSummary[] };

export interface CanonicalEventsViewProps {
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
}

/**
 * The comparison index page body (Requirement 2.1, 9.1): the list of
 * cross-platform groupings with an optional category filter (synced to the URL
 * so views are shareable). Fetches `GET /api/canonical-events` through the
 * project API client and renders loading / error / empty / ready states.
 */
export function CanonicalEventsView({ client }: CanonicalEventsViewProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const categoryId = useId();

  const category = (searchParams.get("category") as Category | null) ?? "";

  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const handleCategoryChange = useCallback(
    (next: Category | "") => {
      const search = new URLSearchParams();
      if (next) search.set("category", next);
      const qs = search.toString();
      router.push(`/canonical-events${qs.length > 0 ? `?${qs}` : ""}`);
    },
    [router],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    const filters: CanonicalEventListFilters = category ? { category } : {};
    api
      .listCanonicalEvents(filters, controller.signal)
      .then((res) => setState({ kind: "ready", events: res.canonicalEvents }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to load canonical events";
        setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [api, category]);

  return (
    <section aria-labelledby="comparisons-heading">
      <h2 id="comparisons-heading">Compare across platforms</h2>
      <p className="subtle">
        Same real-world question, grouped across venues. Open one to compare implied probabilities
        side by side.
      </p>

      <form className="controls" aria-label="Canonical event filters">
        <div className="field">
          <label htmlFor={categoryId}>Category</label>
          <select
            id={categoryId}
            value={category}
            onChange={(e) => handleCategoryChange(e.target.value as Category | "")}
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </select>
        </div>
      </form>

      {state.kind === "loading" && (
        <p className="state" role="status">
          Loading canonical events…
        </p>
      )}
      {state.kind === "error" && (
        <p className="state error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && <CanonicalEventList events={state.events} />}
    </section>
  );
}
