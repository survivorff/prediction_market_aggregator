"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getApiClient, type ApiClient } from "../lib/api-client";
import type { ComparisonView as ComparisonViewDto } from "../lib/dto";
import { ComparisonTable } from "./ComparisonTable";

/** Combined comparison load lifecycle. */
type LoadState =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: ComparisonViewDto };

export interface ComparisonViewProps {
  canonicalEventId: string;
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
}

/**
 * The same-question comparison page body (Requirements 2.1, 2.3, 2.4, 6.1,
 * 9.1). Fetches `GET /api/canonical-events/{id}` through the project API client
 * and renders loading / not-found / error / ready states. The side-by-side
 * table (with mismatch flags and outbound "Go trade" links) lives in
 * {@link ComparisonTable}.
 */
export function ComparisonView({ canonicalEventId, client }: ComparisonViewProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    api
      .getCanonicalEvent(canonicalEventId, controller.signal)
      .then((view) => setState({ kind: "ready", view }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (
          typeof err === "object" &&
          err !== null &&
          "status" in err &&
          (err as { status: number }).status === 404
        ) {
          setState({ kind: "notFound" });
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load comparison";
        setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [api, canonicalEventId]);

  if (state.kind === "loading") {
    return (
      <p className="state" role="status">
        Loading comparison…
      </p>
    );
  }
  if (state.kind === "notFound") {
    return (
      <div className="state" role="alert">
        <p>Canonical event not found.</p>
        <Link href="/canonical-events" className="back-link">
          ← Back to comparisons
        </Link>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="state error" role="alert">
        {state.message}
      </p>
    );
  }

  return (
    <article>
      <Link href="/canonical-events" className="back-link">
        ← Back to comparisons
      </Link>
      <ComparisonTable view={state.view} />
      <p className="subtle" style={{ marginTop: 12 }}>
        "Go trade" opens the source platform. This dashboard is read-only and never places orders.
      </p>
    </article>
  );
}
