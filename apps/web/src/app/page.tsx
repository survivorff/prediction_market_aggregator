import { Suspense } from "react";
import { DiscoveryView } from "../components/DiscoveryView";

/**
 * Discovery page (`/`). The interactive list lives in {@link DiscoveryView} (a
 * client component that reads filters from the URL and fetches the project
 * API). Wrapped in `Suspense` because it uses `useSearchParams`.
 */
export default function HomePage() {
  return (
    <Suspense
      fallback={
        <p className="state" role="status">
          Loading…
        </p>
      }
    >
      <DiscoveryView />
    </Suspense>
  );
}
