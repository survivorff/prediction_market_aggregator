import { WatchlistView } from "../../components/WatchlistView";

/**
 * Watchlist page (`/watchlist`). The interactive list + add/remove controls
 * live in {@link WatchlistView} (a client component that reads/writes the
 * project API). User-scoped + authenticated (Requirements 5.1, 5.4, 9.4); the
 * view renders a friendly "sign in" state when no token is configured.
 */
export default function WatchlistPage() {
  return <WatchlistView />;
}
