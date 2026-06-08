import type { ComparisonRow, ComparisonView } from "../lib/dto";
import { tradeLinkHref } from "../lib/api-client";
import { EMPTY, formatCurrency, formatProbability, titleCase } from "../lib/format";

/**
 * Presentational side-by-side comparison (Requirements 2.1, 2.3, 2.4, 6.1).
 *
 * Pure render given a {@link ComparisonView}. Each platform's market is shown
 * as a row with its source, implied probability, 24h volume (Req 2.1), and an
 * outbound "Go trade" deep-link button (Req 6.1). Rows flagged
 * `resolutionMismatch` are still shown but carry an explicit badge explaining
 * they are excluded from the spread (Req 2.3). `maxSpread` is rendered when
 * present and as a "no spread" note when null (Req 2.4).
 */
export function ComparisonTable({ view }: { view: ComparisonView }) {
  const { canonicalEvent, rows, maxSpread } = view;
  const mismatchCount = rows.filter((r) => r.resolutionMismatch).length;

  return (
    <section className="comparison" aria-labelledby="comparison-heading">
      <header className="comparison-head">
        <p className="subtle">
          {titleCase(canonicalEvent.category)}
          {canonicalEvent.subjectEntity ? ` · ${canonicalEvent.subjectEntity}` : ""}
        </p>
        <h2 id="comparison-heading">{canonicalEvent.title || EMPTY}</h2>
        <div className="comparison-spread" aria-label="Maximum cross-platform spread">
          <span className="metric-label">Max spread</span>
          {maxSpread === null ? (
            <span className="metric-value subtle" data-spread="none">
              No spread
            </span>
          ) : (
            <span className="metric-value num">{formatProbability(maxSpread)}</span>
          )}
        </div>
        {maxSpread === null && (
          <p className="subtle" role="note">
            A spread needs at least two platforms with aligned resolution criteria. Showing the
            available market{rows.length === 1 ? "" : "s"} without a spread value.
          </p>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="state" role="status">
          No platform markets are linked to this event yet.
        </p>
      ) : (
        <table className="comparison-table">
          <caption className="subtle" style={{ textAlign: "left", marginBottom: 8 }}>
            {rows.length} platform{rows.length === 1 ? "" : "s"} side by side
            {mismatchCount > 0
              ? ` · ${mismatchCount} excluded from spread (resolution mismatch)`
              : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Platform</th>
              <th scope="col" className="num">
                Implied&nbsp;Prob
              </th>
              <th scope="col" className="num">
                24h&nbsp;Volume
              </th>
              <th scope="col">Resolution</th>
              <th scope="col">Trade</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ComparisonRowView key={row.marketId} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * One platform's comparison row. Exported for focused unit tests asserting the
 * mismatch badge (Req 2.3) and the outbound "Go trade" deep-link (Req 6.1).
 */
export function ComparisonRowView({ row }: { row: ComparisonRow }) {
  const href = tradeLinkHref(row.tradeLink);
  return (
    <tr className={row.resolutionMismatch ? "row-mismatch" : undefined}>
      <td>{row.source.name || EMPTY}</td>
      <td className="num">{formatProbability(row.impliedProb)}</td>
      <td className="num">{formatCurrency(row.volume24h)}</td>
      <td>
        {row.resolutionMismatch ? (
          <span
            className="badge mismatch-badge"
            data-mismatch="true"
            title="Excluded from the spread because this market's resolution criteria differ"
          >
            ⚠ Mismatch · excluded from spread
          </span>
        ) : (
          <span className="badge" data-mismatch="false">
            Aligned
          </span>
        )}
      </td>
      <td>
        <a
          className="trade-link trade-link-sm"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Go trade ↗
        </a>
      </td>
    </tr>
  );
}
