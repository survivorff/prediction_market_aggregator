import { ComparisonView } from "../../../components/ComparisonView";

/**
 * Same-question comparison route (`/canonical-events/[id]`). The interactive
 * side-by-side comparison lives in {@link ComparisonView} (a client component
 * that fetches the project API). The route segment only resolves the dynamic
 * `id` param.
 */
export default async function CanonicalEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComparisonView canonicalEventId={id} />;
}
