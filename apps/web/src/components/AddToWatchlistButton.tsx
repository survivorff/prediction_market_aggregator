"use client";

import { useCallback, useMemo, useState } from "react";
import { getApiClient, MissingTokenError, type ApiClient } from "../lib/api-client";
import type { WatchlistTargetType } from "../lib/dto";

/** Per-action UI status for the add control. */
type AddStatus =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "added" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

export interface AddToWatchlistButtonProps {
  targetType: WatchlistTargetType;
  targetId: string;
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
  /** Optional label override. */
  label?: string;
}

/**
 * A self-contained "add to watchlist" control (Requirement 5.1) for embedding
 * on the market-detail and comparison views. Adds the given target via the
 * project API (idempotent: re-adding returns the existing item, no duplicate).
 *
 * Gracefully handles the unauthenticated state: when no token is configured the
 * client throws {@link MissingTokenError}, surfaced inline as a "sign in" hint
 * rather than a crash (Requirement 9.4). Reads/writes ONLY the project API
 * (Requirement 9.1).
 */
export function AddToWatchlistButton({
  targetType,
  targetId,
  client,
  label = "+ Watch",
}: AddToWatchlistButtonProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [status, setStatus] = useState<AddStatus>({ kind: "idle" });

  const handleClick = useCallback(async () => {
    setStatus({ kind: "busy" });
    try {
      await api.addWatchlist({ targetType, targetId });
      setStatus({ kind: "added" });
    } catch (err: unknown) {
      if (err instanceof MissingTokenError) {
        setStatus({ kind: "unauthenticated" });
        return;
      }
      if (
        typeof err === "object" &&
        err !== null &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        setStatus({ kind: "unauthenticated" });
        return;
      }
      const message = err instanceof Error ? err.message : "Failed to add to watchlist";
      setStatus({ kind: "error", message });
    }
  }, [api, targetType, targetId]);

  if (status.kind === "added") {
    return (
      <span className="badge" data-watchlist="added" role="status">
        ✓ On your watchlist
      </span>
    );
  }

  if (status.kind === "unauthenticated") {
    return (
      <span className="subtle" role="status">
        Sign in to add to your watchlist.
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="badge"
        style={{ cursor: "pointer" }}
        disabled={status.kind === "busy"}
        onClick={handleClick}
      >
        {status.kind === "busy" ? "Adding…" : label}
      </button>
      {status.kind === "error" && (
        <span className="state error" role="alert" style={{ padding: "4px 8px" }}>
          {status.message}
        </span>
      )}
    </span>
  );
}
