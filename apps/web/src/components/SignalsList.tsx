import Link from "next/link";
import type { SignalDto } from "../lib/dto";
import { EMPTY, formatProbability, titleCase } from "../lib/format";

/**
 * Presentational, DISPLAY-ONLY spread-signals list (Requirements 3.1, 3.3).
 *
 * Pure render given `signals`, which the gateway already returns ranked by the
 * largest cross-platform implied-probability gap (Req 3.1). For each signal we
 * show the canonical question, the per-platform implied probabilities, and the
 * gap.
 *
 * Display-only invariant (Req 3.3 / 12.1): every signal carries `executable:
 * false` and v1 exposes NO execution path. This component therefore renders NO
 * "buy / place order / execute" affordance — only a read-only "Compare" link to
 * the canonical-event view and an explicit "display-only" framing. The
 * `executable` flag is surfaced verbatim so the non-executable contract is
 * visible to users and assistive tech.
 */
export function SignalsList({ signals }: { signals: SignalDto[] }) {
  if (signals.length === 0) {
    return (
      <p className="state" role="status">
        No spread signals right now. Signals appear when at least two platforms list the same
        question with aligned resolution criteria.
      </p>
    );
  }

  return (
    <ol className="signals-list" aria-label="Cross-platform spread signals, ranked by largest gap">
      {signals.map((signal, index) => (
        <SignalCard key={signal.canonicalEventId} signal={signal} rank={index + 1} />
      ))}
    </ol>
  );
}

/**
 * One ranked signal. Exported for focused unit tests asserting the per-platform
 * probabilities, the gap, the display-only framing, and the absence of any
 * execution affordance.
 */
export function SignalCard({ signal, rank }: { signal: SignalDto; rank: number }) {
  return (
    <li className="signal-card">
      <div className="signal-head">
        <span className="signal-rank" aria-label={`Rank ${rank}`}>
          #{rank}
        </span>
        <h3 className="signal-title">{signal.title || EMPTY}</h3>
        <span className="signal-gap num" aria-label="Cross-platform gap">
          {formatProbability(signal.gap)} gap
        </span>
      </div>

      <table className="signal-platforms">
        <caption className="subtle" style={{ textAlign: "left", marginBottom: 4 }}>
          Per-platform implied probability
        </caption>
        <thead>
          <tr>
            <th scope="col">Platform</th>
            <th scope="col" className="num">
              Implied&nbsp;Prob
            </th>
          </tr>
        </thead>
        <tbody>
          {signal.perPlatform.map((p) => (
            <tr key={p.source}>
              <td>{titleCase(p.source)}</td>
              <td className="num">{formatProbability(p.impliedProb)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="signal-footer">
        {/* Display-only: a read-only navigation link, NOT an execution action. */}
        <Link href={`/canonical-events/${signal.canonicalEventId}`} className="signal-compare-link">
          Compare side by side →
        </Link>
        {/* Surface the non-executable contract verbatim (Req 3.3). */}
        {signal.executable === false && (
          <span className="badge signal-display-only" data-executable="false">
            Display only · not executable
          </span>
        )}
      </div>
    </li>
  );
}
