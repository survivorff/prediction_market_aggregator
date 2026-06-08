"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { getApiClient, MissingTokenError, type ApiClient } from "../lib/api-client";
import { WATCHLIST_TARGET_TYPES, type WatchlistItem, type WatchlistTargetType } from "../lib/dto";
import { titleCase } from "../lib/format";
import { AlertsNotifications } from "./AlertsNotifications";

/** Loading lifecycle for the watchlist fetch. */
type LoadState =
  | { kind: "loading" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string }
  | { kind: "ready"; items: WatchlistItem[] };

export interface WatchlistViewProps {
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
}

/** The in-app route for a watchlist target (market / canonical event). */
function targetHref(item: WatchlistItem): string {
  return item.targetType === "market"
    ? `/markets/${item.targetId}`
    : `/canonical-events/${item.targetId}`;
}

/**
 * The watchlist page body (Requirements 5.1, 5.4, 9.4, 9.1). Lists the
 * authenticated user's watched markets / canonical events and lets them add
 * (idempotent via the API — duplicates are prevented server-side, Req 5.1) and
 * remove entries. Reads/writes exclusively through the project API client
 * (Requirement 9.1).
 *
 * Authentication (Requirement 9.4) is required: when no token is configured the
 * client throws {@link MissingTokenError}, which we render as a friendly
 * "auth required" state rather than crashing on a 401. Login/token acquisition
 * is out of scope (the client reads a provided `NEXT_PUBLIC_API_TOKEN` in dev).
 */
export function WatchlistView({ client }: WatchlistViewProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) => {
      setState({ kind: "loading" });
      api
        .listWatchlist(signal)
        .then((res) => setState({ kind: "ready", items: res.items }))
        .catch((err: unknown) => {
          if (signal?.aborted) return;
          if (isAuthError(err)) {
            setState({ kind: "unauthenticated" });
            return;
          }
          const message = err instanceof Error ? err.message : "Failed to load watchlist";
          setState({ kind: "error", message });
        });
    },
    [api],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleAdd = useCallback(
    async (targetType: WatchlistTargetType, targetId: string) => {
      setBusy(true);
      setAddError(null);
      try {
        // Idempotent on the server: re-adding an existing target returns the
        // existing item (Requirement 5.1). Reload to reflect the canonical list.
        await api.addWatchlist({ targetType, targetId });
        load();
      } catch (err: unknown) {
        if (err instanceof MissingTokenError) {
          setState({ kind: "unauthenticated" });
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to add to watchlist";
        setAddError(message);
      } finally {
        setBusy(false);
      }
    },
    [api, load],
  );

  const handleRemove = useCallback(
    async (itemId: string) => {
      setBusy(true);
      try {
        await api.deleteWatchlist(itemId);
        load();
      } catch (err: unknown) {
        if (err instanceof MissingTokenError) {
          setState({ kind: "unauthenticated" });
          return;
        }
        // Reload regardless: a 404 means it is already gone.
        load();
      } finally {
        setBusy(false);
      }
    },
    [api, load],
  );

  return (
    <section aria-labelledby="watchlist-heading">
      <h2 id="watchlist-heading">Your watchlist</h2>
      <p className="subtle">
        Track markets and cross-platform events. Live price, spread, and alert updates are pushed
        over the platform&apos;s own channel — this dashboard is read-only and never places orders.
      </p>

      {state.kind === "unauthenticated" && <UnauthenticatedNotice />}

      {state.kind === "loading" && (
        <p className="state" role="status">
          Loading watchlist…
        </p>
      )}

      {state.kind === "error" && (
        <p className="state error" role="alert">
          {state.message}
        </p>
      )}

      {state.kind === "ready" && (
        <>
          <AddWatchlistForm onAdd={handleAdd} busy={busy} error={addError} />
          <WatchlistItems items={state.items} onRemove={handleRemove} busy={busy} />
          {/* Live alert notifications for the user (Req 5.3, 9.2): subscribes to
              the alerts fan-out channel and surfaces incoming notifications. */}
          <AlertsNotifications />
        </>
      )}
    </section>
  );
}

/** True when an error means the user must authenticate (missing token or 401). */
function isAuthError(err: unknown): boolean {
  if (err instanceof MissingTokenError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 401
  );
}

/** Friendly "auth required" state when no token is configured (Req 9.4). */
function UnauthenticatedNotice() {
  return (
    <div className="state" role="status">
      <p>Sign in to build a watchlist.</p>
      <p className="subtle">
        The watchlist is a user-scoped feature and requires authentication. In local development,
        set <code>NEXT_PUBLIC_API_TOKEN</code> to a valid token to enable it. Full login is out of
        scope for v1.
      </p>
    </div>
  );
}

/** Add-to-watchlist form: pick a target type and paste a target id. */
function AddWatchlistForm({
  onAdd,
  busy,
  error,
}: {
  onAdd: (targetType: WatchlistTargetType, targetId: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const typeId = useId();
  const idId = useId();
  const [targetType, setTargetType] = useState<WatchlistTargetType>("market");
  const [targetId, setTargetId] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = targetId.trim();
    if (trimmed.length === 0) return;
    onAdd(targetType, trimmed);
    setTargetId("");
  };

  return (
    <form className="controls" aria-label="Add to watchlist" onSubmit={submit}>
      <div className="field">
        <label htmlFor={typeId}>Type</label>
        <select
          id={typeId}
          value={targetType}
          onChange={(e) => setTargetType(e.target.value as WatchlistTargetType)}
        >
          {WATCHLIST_TARGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t === "canonicalEvent" ? "Canonical event" : titleCase(t)}
            </option>
          ))}
        </select>
      </div>
      <div className="field grow">
        <label htmlFor={idId}>Target id</label>
        <input
          id={idId}
          type="text"
          value={targetId}
          placeholder="market or canonical-event UUID"
          onChange={(e) => setTargetId(e.target.value)}
        />
      </div>
      <button type="submit" className="trade-link" disabled={busy || targetId.trim().length === 0}>
        Add to watchlist
      </button>
      {error && (
        <p className="state error" role="alert" style={{ flexBasis: "100%" }}>
          {error}
        </p>
      )}
    </form>
  );
}

/** The list of watched items with per-row remove controls. */
function WatchlistItems({
  items,
  onRemove,
  busy,
}: {
  items: WatchlistItem[];
  onRemove: (itemId: string) => void;
  busy: boolean;
}) {
  if (items.length === 0) {
    return (
      <p className="state" role="status">
        Your watchlist is empty. Add a market or canonical event to start tracking it.
      </p>
    );
  }

  return (
    <table className="market-table" aria-label="Watched markets and events">
      <thead>
        <tr>
          <th scope="col">Type</th>
          <th scope="col">Target</th>
          <th scope="col">Added</th>
          <th scope="col">Remove</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            <td>
              <span className="badge">
                {item.targetType === "canonicalEvent" ? "Canonical event" : "Market"}
              </span>
            </td>
            <td>
              <Link href={targetHref(item)}>{item.targetId}</Link>
            </td>
            <td className="subtle">{item.createdAt}</td>
            <td>
              <button
                type="button"
                className="badge"
                style={{ cursor: "pointer" }}
                aria-label={`Remove ${item.targetId} from watchlist`}
                disabled={busy}
                onClick={() => onRemove(item.id)}
              >
                Remove
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
