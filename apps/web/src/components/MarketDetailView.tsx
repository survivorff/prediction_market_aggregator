"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getApiClient,
  resolveApiBaseUrl,
  type ApiClient,
  type HistoryQuery,
} from "../lib/api-client";
import type {
  FanoutMessage,
  FanoutPricePayload,
  HistoryRangePreset,
  MarketDetail,
  OutcomeDetail,
  PriceHistoryResponse,
} from "../lib/dto";
import {
  EMPTY,
  formatCurrency,
  formatProbability,
  formatTimeRemaining,
  titleCase,
} from "../lib/format";
import { useFanout } from "../lib/useFanout";
import type { WebSocketFactory } from "../lib/fanout-client";
import { PriceHistoryChart } from "./PriceHistoryChart";
import { AddToWatchlistButton } from "./AddToWatchlistButton";

/** Combined detail + history load lifecycle. */
type LoadState =
  | { kind: "loading" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; detail: MarketDetail; history: PriceHistoryResponse };

/** Translate a range preset to a `from` timestamp (relative to now). */
function rangeToQuery(preset: HistoryRangePreset, nowMs: number): HistoryQuery {
  const day = 24 * 60 * 60 * 1000;
  const spans: Record<HistoryRangePreset, number> = {
    "24h": day,
    "7d": 7 * day,
    "30d": 30 * day,
  };
  return {
    from: new Date(nowMs - spans[preset]).toISOString(),
    to: new Date(nowMs).toISOString(),
    interval: preset === "24h" ? "5m" : "1h",
  };
}

export interface MarketDetailViewProps {
  marketId: string;
  /** Injectable client for tests; defaults to the env-bound singleton. */
  client?: ApiClient;
  /**
   * Injectable WebSocket factory for the live-price subscription (tests pass a
   * fake; defaults to the global `WebSocket` via {@link useFanout}). When
   * `liveUpdates` is false no socket is opened.
   */
  socketFactory?: WebSocketFactory;
  /** Enable the live-price fan-out subscription. Default true. */
  liveUpdates?: boolean;
}

/** The latest live price seen for an outcome label, plus its capture time. */
interface LivePrice {
  price: number;
  ts: string;
}

/**
 * Market detail page body (Requirements 4.1, 4.2, 9.1): metadata, outcomes with
 * latest prices, a price-history curve, and an outbound link to the source
 * platform. Reads exclusively through the project API client.
 *
 * Live updates (Requirements 9.2, 5.3): once loaded, the view subscribes to the
 * market's fan-out channel (`WS /ws`, channel `market`) and live-updates the
 * displayed latest price / implied probability on incoming `price` ticks. The
 * subscription is torn down on unmount (or when the market changes).
 */
export function MarketDetailView({
  marketId,
  client,
  socketFactory,
  liveUpdates = true,
}: MarketDetailViewProps) {
  const api = useMemo(() => client ?? getApiClient(), [client]);
  const [range, setRange] = useState<HistoryRangePreset>("7d");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  /** Live prices keyed by outcome label, updated from fan-out `price` ticks. */
  const [livePrices, setLivePrices] = useState<Record<string, LivePrice>>({});

  // Reset any accumulated live prices whenever the market changes.
  useEffect(() => {
    setLivePrices({});
  }, [marketId]);

  const handleFanout = useCallback((message: FanoutMessage) => {
    if (message.type !== "price") return;
    const payload = message.payload as FanoutPricePayload;
    if (typeof payload?.outcomeLabel !== "string" || typeof payload.price !== "number") return;
    setLivePrices((prev) => ({
      ...prev,
      [payload.outcomeLabel]: { price: payload.price, ts: payload.ts },
    }));
  }, []);

  const subscriptions = useMemo(() => [{ channel: "market" as const, id: marketId }], [marketId]);

  useFanout({
    subscriptions,
    onMessage: handleFanout,
    enabled: liveUpdates,
    socketFactory,
  });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });

    const query = rangeToQuery(range, Date.now());
    Promise.all([
      api.getMarket(marketId, controller.signal),
      api.getMarketHistory(marketId, query, controller.signal),
    ])
      .then(([detail, history]) => setState({ kind: "ready", detail, history }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // 404 from the gateway → not-found state.
        if (
          typeof err === "object" &&
          err !== null &&
          "status" in err &&
          (err as { status: number }).status === 404
        ) {
          setState({ kind: "notFound" });
          return;
        }
        const message = err instanceof Error ? err.message : "Failed to load market";
        setState({ kind: "error", message });
      });
    return () => controller.abort();
  }, [api, marketId, range]);

  if (state.kind === "loading") {
    return (
      <p className="state" role="status">
        Loading market…
      </p>
    );
  }
  if (state.kind === "notFound") {
    return (
      <div className="state" role="alert">
        <p>Market not found.</p>
        <Link href="/" className="back-link">
          ← Back to discovery
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

  const { detail, history } = state;
  // Build an absolute trade-link URL from the gateway-provided relative path.
  const tradeHref = `${resolveApiBaseUrl().replace(/\/+$/, "")}${detail.tradeLinkPath}`;

  // Live implied probability: prefer a live tick on the "Yes" outcome (the
  // implied probability of a binary market is the Yes price), falling back to
  // the value loaded from the gateway. `hasLive` drives the "Live" badge.
  const yesOutcome = detail.outcomes.find((o) => o.label.trim().toLowerCase() === "yes");
  const liveYes = yesOutcome ? livePrices[yesOutcome.label] : undefined;
  const liveImpliedProb = liveYes ? liveYes.price : detail.impliedProb;
  const hasLive = Object.keys(livePrices).length > 0;

  return (
    <article aria-labelledby="market-question">
      <Link href="/" className="back-link">
        ← Back to discovery
      </Link>
      <p className="subtle">
        {detail.source.name} · {titleCase(detail.category)} ·{" "}
        <span className={`badge status-${detail.status}`}>{titleCase(detail.status)}</span>
        {hasLive && (
          <>
            {" · "}
            <span className="badge live-badge" data-live="true" aria-label="Live updates active">
              ● Live
            </span>
          </>
        )}
      </p>
      <h1 id="market-question" className="question">
        {detail.question}
      </h1>

      <div style={{ margin: "4px 0 8px" }}>
        <AddToWatchlistButton targetType="market" targetId={detail.id} client={api} />
      </div>

      <section className="detail-meta" aria-label="Market metrics">
        <Metric label="Implied prob" value={formatProbability(liveImpliedProb)} />
        <Metric label="24h volume" value={formatCurrency(detail.volume24h)} />
        <Metric label="Liquidity" value={formatCurrency(detail.liquidity)} />
        <Metric
          label="Spread"
          value={detail.spread === null ? EMPTY : formatProbability(detail.spread)}
        />
        <Metric label="Time left" value={formatTimeRemaining(detail.timeRemainingSec)} />
      </section>

      <OutcomesTable outcomes={detail.outcomes} livePrices={livePrices} />

      <section className="chart-card" aria-labelledby="history-heading">
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h2 id="history-heading">Price history</h2>
          <RangePicker value={range} onChange={setRange} />
        </div>
        <PriceHistoryChart
          points={history.points}
          ariaLabel={`Price history for ${detail.question}`}
        />
      </section>

      <a className="trade-link" href={tradeHref} target="_blank" rel="noopener noreferrer">
        Go trade on {detail.source.name} ↗
      </a>
      <p className="subtle" style={{ marginTop: 6 }}>
        Opens the source platform. This dashboard is read-only and never places orders.
      </p>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

/** Outcomes with their latest prices (Requirement 4.1). Live ticks (keyed by
 * outcome label) override the loaded last price when present (Req 9.2, 5.3). */
function OutcomesTable({
  outcomes,
  livePrices = {},
}: {
  outcomes: OutcomeDetail[];
  livePrices?: Record<string, LivePrice>;
}) {
  if (outcomes.length === 0) {
    return <p className="subtle">No outcomes available.</p>;
  }
  return (
    <table className="outcomes">
      <caption className="subtle" style={{ textAlign: "left", marginBottom: 6 }}>
        Outcomes
      </caption>
      <thead>
        <tr>
          <th scope="col">Outcome</th>
          <th scope="col" className="num">
            Implied prob
          </th>
          <th scope="col" className="num">
            Last price
          </th>
        </tr>
      </thead>
      <tbody>
        {outcomes.map((o) => {
          const live = livePrices[o.label];
          const lastPrice = live ? live.price : o.lastPrice;
          return (
            <tr key={o.id} data-live={live ? "true" : undefined}>
              <td>{o.label || EMPTY}</td>
              <td className="num">{formatProbability(o.impliedProb)}</td>
              <td className="num">{formatProbability(lastPrice)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Range preset selector for the price-history curve. */
function RangePicker({
  value,
  onChange,
}: {
  value: HistoryRangePreset;
  onChange: (next: HistoryRangePreset) => void;
}) {
  const presets: HistoryRangePreset[] = ["24h", "7d", "30d"];
  return (
    <div role="group" aria-label="Price history range" style={{ display: "flex", gap: 6 }}>
      {presets.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={p === value}
          onClick={() => onChange(p)}
          className="badge"
          style={
            p === value
              ? { borderColor: "var(--accent)", color: "var(--accent)", cursor: "pointer" }
              : { cursor: "pointer" }
          }
        >
          {p}
        </button>
      ))}
    </div>
  );
}
