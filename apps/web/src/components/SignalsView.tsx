"use client";

import { useEffect, useMemo, useState } from "react";
import { getApiClient, type ApiClient } from "../lib/api-client";
import type { SignalDto } from "../lib/dto";
import { SignalsList } from "./SignalsList";

/** Loading lifecycle for the signals fetch. */
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; signals: SignalDto[] };

export interface SignalsViewProps {
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
  /** Optional cap on the ranked list (passed through to `GET /api/signals`). */
  limit?: number;
}

/**
 * The spread-signals page body (Requirements 3.1, 3.3, 9.1). Fetches
 * `GET /api/signals` through the project API client (which returns the list
 * already ranked by largest gap) and renders loading / error / empty / ready
 * states.
 *
 * This view is strictly DISPLAY-ONLY: it reads signals and renders them; it
 * exposes no execution/order path (Req 3.3). The non-executable framing lives
 * in {@link SignalsList}.
 */
export function SignalsView({ client, limit }: SignalsViewProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .listSignals(limit === undefined ? {} : { limit }, controller.signal)
      .then((res) => setState({ kind: "ready", signals: res.signals }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Failed to load signals";
        setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [api, limit]);

  return (
    <section aria-labelledby="signals-heading">
      <h2 id="signals-heading">Spread signals</h2>
      <p className="subtle">
        Largest cross-platform implied-probability gaps, ranked. These are display-only indicators
        computed over markets with aligned resolution criteria — this dashboard is read-only and
        never places trades.
      </p>

      {state.kind === "loading" && (
        <p className="state" role="status">
          Loading signals…
        </p>
      )}
      {state.kind === "error" && (
        <p className="state error" role="alert">
          {state.message}
        </p>
      )}
      {state.kind === "ready" && <SignalsList signals={state.signals} />}
    </section>
  );
}
