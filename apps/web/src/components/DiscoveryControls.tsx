"use client";

import { useEffect, useId, useState } from "react";
import {
  CATEGORIES,
  MARKET_STATUSES,
  type Category,
  type MarketSortKey,
  type MarketStatus,
} from "../lib/dto";
import { titleCase } from "../lib/format";

/** The discovery control state, mirroring the `GET /api/markets` query params. */
export interface DiscoveryControlValue {
  q: string;
  category: Category | "";
  status: MarketStatus | "";
  sort: MarketSortKey | "";
}

/** Sortable keys exposed in the UI (Requirement 1.4). */
const SORT_OPTIONS: ReadonlyArray<{ key: MarketSortKey; label: string }> = [
  { key: "volume", label: "Volume" },
  { key: "liquidity", label: "Liquidity" },
  { key: "timeRemaining", label: "Time remaining" },
];

export interface DiscoveryControlsProps {
  /** Current control value (controlled by the parent / URL). */
  value: DiscoveryControlValue;
  /**
   * Fired with the next value whenever a control changes. The search box is
   * debounced internally so typing fires `onChange` only after a pause.
   */
  onChange: (next: DiscoveryControlValue) => void;
  /** Debounce for the search box in ms (default 300; set 0 in tests). */
  searchDebounceMs?: number;
}

/**
 * Discovery filter/search/sort controls (Requirements 1.2, 1.4). Accessible:
 * every control has an associated `<label>`; the search box is a `search`-type
 * input. The category/status/sort selects fire `onChange` immediately; the
 * free-text search is debounced so we don't refetch on every keystroke.
 *
 * Controlled component — it owns only the transient text-input buffer; the
 * canonical state lives in the parent (which syncs it to the URL).
 */
export function DiscoveryControls({
  value,
  onChange,
  searchDebounceMs = 300,
}: DiscoveryControlsProps) {
  const ids = {
    q: useId(),
    category: useId(),
    status: useId(),
    sort: useId(),
  };

  // Local buffer for the debounced search box so typing stays responsive.
  const [qBuffer, setQBuffer] = useState(value.q);

  // Keep the buffer in sync if the parent value changes externally (e.g. back
  // navigation restoring URL state).
  useEffect(() => {
    setQBuffer(value.q);
  }, [value.q]);

  // Debounce the search buffer → onChange.
  useEffect(() => {
    if (qBuffer === value.q) return;
    const handle = setTimeout(() => {
      onChange({ ...value, q: qBuffer });
    }, searchDebounceMs);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qBuffer, searchDebounceMs]);

  return (
    <form
      className="controls"
      role="search"
      aria-label="Market discovery filters"
      onSubmit={(e) => {
        e.preventDefault();
        onChange({ ...value, q: qBuffer });
      }}
    >
      <div className="field grow">
        <label htmlFor={ids.q}>Search</label>
        <input
          id={ids.q}
          type="search"
          placeholder="Search questions…"
          value={qBuffer}
          onChange={(e) => setQBuffer(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor={ids.category}>Category</label>
        <select
          id={ids.category}
          value={value.category}
          onChange={(e) => onChange({ ...value, category: e.target.value as Category | "" })}
        >
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.status}>Status</label>
        <select
          id={ids.status}
          value={value.status}
          onChange={(e) => onChange({ ...value, status: e.target.value as MarketStatus | "" })}
        >
          <option value="">All statuses</option>
          {MARKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={ids.sort}>Sort by</label>
        <select
          id={ids.sort}
          value={value.sort}
          onChange={(e) => onChange({ ...value, sort: e.target.value as MarketSortKey | "" })}
        >
          <option value="">Default</option>
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}
