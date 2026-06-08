import { SignalsView } from "../../components/SignalsView";

/**
 * Spread-signals page (`/signals`). The display-only signals list lives in
 * {@link SignalsView} (a client component that fetches the project API). v1 is
 * read-only: this page exposes no execution/order path (Requirement 3.3).
 */
export default function SignalsPage() {
  return <SignalsView />;
}
