"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PriceHistoryPoint } from "../lib/dto";

export interface PriceHistoryChartProps {
  /** Raw price-history points from `GET /api/markets/{id}/history`. */
  points: PriceHistoryPoint[];
  /**
   * Outcome id to plot. When omitted, the first outcome seen in `points` is
   * used (binary markets typically chart the Yes outcome).
   */
  outcomeId?: string;
  /** Accessible label for the chart region. */
  ariaLabel?: string;
}

/** A charted row: epoch ms + probability percentage. */
interface ChartDatum {
  ts: number;
  label: string;
  prob: number;
}

/** Format an epoch-ms tick as a short local date/time for the X axis. */
function formatTick(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Price-history probability curve (Requirement 4.2). Filters the series to a
 * single outcome, converts price (0..1) to a percentage, and renders a Recharts
 * line. Handles the empty case explicitly with a labelled placeholder.
 *
 * Accessibility: the chart is wrapped in a `figure` with an `aria-label`, and a
 * visually-hidden table fallback exposes the same data to assistive tech (SVG
 * line charts are otherwise opaque to screen readers).
 */
export function PriceHistoryChart({
  points,
  outcomeId,
  ariaLabel = "Price history",
}: PriceHistoryChartProps) {
  const data = useMemo<ChartDatum[]>(() => {
    const targetOutcome = outcomeId ?? points[0]?.outcomeId;
    if (targetOutcome === undefined) return [];
    return points
      .filter((p) => p.outcomeId === targetOutcome && Number.isFinite(p.price))
      .map((p) => {
        const ts = new Date(p.ts).getTime();
        return { ts, label: new Date(ts).toISOString(), prob: p.price * 100 };
      })
      .filter((d) => Number.isFinite(d.ts))
      .sort((a, b) => a.ts - b.ts);
  }, [points, outcomeId]);

  if (data.length === 0) {
    return (
      <div className="chart-empty" role="status">
        No price history available for this market yet.
      </div>
    );
  }

  return (
    <figure aria-label={ariaLabel} style={{ margin: 0 }}>
      <div style={{ width: "100%", height: 280 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#2a323d" strokeDasharray="3 3" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              scale="time"
              tickFormatter={formatTick}
              stroke="#9aa7b4"
              fontSize={12}
            />
            <YAxis
              domain={[0, 100]}
              tickFormatter={(v: number) => `${v}%`}
              stroke="#9aa7b4"
              fontSize={12}
              width={44}
            />
            <Tooltip
              formatter={(v: number) => [`${v.toFixed(1)}%`, "Implied prob"]}
              labelFormatter={(ts: number) => new Date(ts).toLocaleString()}
              contentStyle={{
                background: "#171c24",
                border: "1px solid #2a323d",
                borderRadius: 6,
                color: "#e6edf3",
              }}
            />
            <Line
              type="monotone"
              dataKey="prob"
              stroke="#4f9cf9"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Visually-hidden data table fallback for assistive technologies. */}
      <figcaption className="visually-hidden" style={visuallyHidden}>
        <table>
          <caption>{ariaLabel}: implied probability over time</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Implied probability</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.ts}>
                <td>{new Date(d.ts).toISOString()}</td>
                <td>{d.prob.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

/** Inline visually-hidden style (keeps the fallback in the a11y tree, off-screen). */
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};
