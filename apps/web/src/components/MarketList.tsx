import Link from "next/link";
import type { MarketSummary } from "../lib/dto";
import {
  EMPTY,
  formatCurrency,
  formatProbability,
  formatTimeRemaining,
  titleCase,
} from "../lib/format";

/**
 * Presentational discovery list (Requirement 1.1: unified metrics — implied
 * probability, 24h volume, liquidity, time remaining). Pure render given
 * `markets`; all null fields render as the explicit {@link EMPTY} placeholder
 * (Requirement 1.5). Each question links to the market detail page.
 *
 * Rendered as a semantic `<table>` with a caption for accessibility; numeric
 * columns are right-aligned with tabular figures.
 */
export function MarketList({ markets }: { markets: MarketSummary[] }) {
  if (markets.length === 0) {
    return (
      <p className="state" role="status">
        No markets match your filters.
      </p>
    );
  }

  return (
    <table className="market-table">
      <caption className="subtle" style={{ textAlign: "left", marginBottom: 8 }}>
        {markets.length} market{markets.length === 1 ? "" : "s"}
      </caption>
      <thead>
        <tr>
          <th scope="col">Market</th>
          <th scope="col">Source</th>
          <th scope="col">Category</th>
          <th scope="col">Status</th>
          <th scope="col" className="num">
            Implied&nbsp;Prob
          </th>
          <th scope="col" className="num">
            24h&nbsp;Volume
          </th>
          <th scope="col" className="num">
            Liquidity
          </th>
          <th scope="col" className="num">
            Time&nbsp;Left
          </th>
        </tr>
      </thead>
      <tbody>
        {markets.map((m) => (
          <MarketRow key={m.id} market={m} />
        ))}
      </tbody>
    </table>
  );
}

/**
 * One discovery row. Exported for focused unit tests asserting null → {@link
 * EMPTY} rendering (Requirement 1.5) and the detail link target.
 */
export function MarketRow({ market }: { market: MarketSummary }) {
  return (
    <tr>
      <td>
        <Link href={`/markets/${market.id}`}>{market.question}</Link>
      </td>
      <td>{market.source.name || EMPTY}</td>
      <td>{titleCase(market.category)}</td>
      <td>
        <span className={`badge status-${market.status}`}>{titleCase(market.status)}</span>
      </td>
      <td className="num">{formatProbability(market.impliedProb)}</td>
      <td className="num">{formatCurrency(market.volume24h)}</td>
      <td className="num">{formatCurrency(market.liquidity)}</td>
      <td className="num">{formatTimeRemaining(market.timeRemainingSec)}</td>
    </tr>
  );
}
