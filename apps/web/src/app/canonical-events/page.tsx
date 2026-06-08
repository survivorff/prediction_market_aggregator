import { Suspense } from "react";
import { CanonicalEventsView } from "../../components/CanonicalEventsView";

/**
 * Comparison index page (`/canonical-events`). The cross-platform groupings
 * list lives in {@link CanonicalEventsView} (a client component that reads the
 * category filter from the URL and fetches the project API). Wrapped in
 * `Suspense` because it uses `useSearchParams`.
 */
export default function CanonicalEventsPage() {
  return (
    <Suspense
      fallback={
        <p className="state" role="status">
          Loading…
        </p>
      }
    >
      <CanonicalEventsView />
    </Suspense>
  );
}
