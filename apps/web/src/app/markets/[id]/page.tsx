import { MarketDetailView } from "../../../components/MarketDetailView";

/**
 * Market detail route (`/markets/[id]`). The interactive detail + price-history
 * curve live in {@link MarketDetailView} (a client component that fetches the
 * project API). The route segment only resolves the dynamic `id` param.
 */
export default async function MarketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MarketDetailView marketId={id} />;
}
