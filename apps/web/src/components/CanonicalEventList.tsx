import Link from "next/link";
import type { CanonicalEventSummary } from "../lib/dto";
import { EMPTY, titleCase } from "../lib/format";

/**
 * Presentational list of cross-platform groupings (Requirement 2.1, list view).
 * Pure render given `events`. Each row links to the side-by-side comparison and
 * previews coverage: how many platform markets are linked and how many are
 * flagged with a resolution mismatch (excluded from the spread, Req 2.3).
 */
export function CanonicalEventList({ events }: { events: CanonicalEventSummary[] }) {
  if (events.length === 0) {
    return (
      <p className="state" role="status">
        No canonical events match your filter.
      </p>
    );
  }

  return (
    <table className="market-table">
      <caption className="subtle" style={{ textAlign: "left", marginBottom: 8 }}>
        {events.length} canonical event{events.length === 1 ? "" : "s"}
      </caption>
      <thead>
        <tr>
          <th scope="col">Event</th>
          <th scope="col">Category</th>
          <th scope="col" className="num">
            Platforms
          </th>
          <th scope="col" className="num">
            Mismatches
          </th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <CanonicalEventRow key={e.id} event={e} />
        ))}
      </tbody>
    </table>
  );
}

/** One grouping row. Exported for focused unit tests. */
export function CanonicalEventRow({ event }: { event: CanonicalEventSummary }) {
  return (
    <tr>
      <td>
        <Link href={`/canonical-events/${event.id}`}>{event.title || EMPTY}</Link>
      </td>
      <td>{titleCase(event.category)}</td>
      <td className="num">{event.memberCount}</td>
      <td className="num">
        {event.mismatchCount > 0 ? (
          <span className="badge mismatch-badge" data-mismatch="true">
            {event.mismatchCount}
          </span>
        ) : (
          "0"
        )}
      </td>
    </tr>
  );
}
