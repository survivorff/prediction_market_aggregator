/**
 * Framework-agnostic request handlers for the gateway. Each takes the injected
 * {@link GatewayDeps} plus already-validated input and returns a response DTO.
 * Keeping these free of Fastify makes them straightforward to unit-test with
 * in-memory fakes; `server.ts` is a thin Fastify adapter over them.
 *
 * The gateway reads ONLY from storage/Redis (Requirement 9.1). Latest prices
 * prefer the Redis hot cache and fall back to stored outcome data (Requirement
 * 10.4 / 1.5).
 */

import type { HotPrice, MarketSummaryRow, CanonicalComparisonMemberRow } from "@pma/storage";
import type { LinkedMarket } from "@pma/core";
import { computeSignalsForMany } from "@pma/matching";
import type {
  CanonicalEventListResponse,
  CanonicalEventSummary,
  ComparisonRow,
  ComparisonView,
  GatewayDeps,
  MarketDetail,
  MarketListResponse,
  MarketSummary,
  OutcomeDetail,
  PriceHistoryResponse,
  SignalDto,
  SignalListResponse,
  SourceInfo,
  SourceListResponse,
  TradeLink,
} from "./dto.js";
import { NotFoundError } from "./errors.js";
import { defaultTradeLinkResolver } from "./trade-link.js";
import type {
  CanonicalEventsQuery,
  DiscoveryQuery,
  HistoryQuery,
  SignalsQuery,
} from "./validation.js";

/** Derive seconds until an ISO end date relative to `now`; null when unknown/past handling. */
function timeRemainingSec(endDate: string | null, nowMs: number): number | null {
  if (endDate === null) return null;
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return null;
  return Math.round((end - nowMs) / 1000);
}

/** Find the Yes-outcome hot price within a market's hot-cache entries. */
function findYesHotPrice(hot: HotPrice[], yesLabel: string | null): HotPrice | undefined {
  const target = (yesLabel ?? "yes").toLowerCase();
  return hot.find((h) => h.outcomeLabel.toLowerCase() === target);
}

/**
 * Resolve a market summary's implied probability, preferring the hot cache
 * (Requirement 10.4) and falling back to the stored Yes-outcome probability
 * (Requirement 1.5: missing stays explicitly null).
 */
function resolveImpliedProb(row: MarketSummaryRow, hot: HotPrice[]): number | null {
  const hotYes = findYesHotPrice(hot, row.yesOutcomeLabel);
  if (hotYes !== undefined) return hotYes.price;
  return row.yesImpliedProb;
}

function toSummary(row: MarketSummaryRow, hot: HotPrice[], nowMs: number): MarketSummary {
  return {
    id: row.id,
    source: { key: row.sourceKey, name: row.sourceName },
    question: row.question,
    category: row.category,
    status: row.status,
    impliedProb: resolveImpliedProb(row, hot),
    volume24h: row.volume24h,
    liquidity: row.liquidity,
    timeRemainingSec: timeRemainingSec(row.endDate, nowMs),
    canonicalEventId: row.canonicalEventId,
  };
}

/**
 * `GET /api/markets` — unified discovery (Requirements 1.1, 1.2, 1.4, 1.5).
 * Filters/sort are applied in storage SQL; latest implied prob is overlaid from
 * the hot cache per market (keyed by the source-scoped external id, matching
 * the ingestion `onTick` write path).
 */
export async function handleListMarkets(
  deps: GatewayDeps,
  query: DiscoveryQuery,
): Promise<MarketListResponse> {
  const nowMs = (deps.now ?? Date.now)();
  const rows = await deps.discovery.listMarkets(query);

  const markets = await Promise.all(
    rows.map(async (row) => {
      const hot = deps.hotPrices ? await deps.hotPrices.getMarketHotPrices(row.externalId) : [];
      return toSummary(row, hot, nowMs);
    }),
  );

  return {
    markets,
    paging: {
      limit: query.limit ?? markets.length,
      offset: query.offset ?? 0,
      count: markets.length,
    },
  };
}

/**
 * `GET /api/markets/{id}` — detail: metadata + outcomes with latest prices + a
 * link to its source (Requirement 4.1). Order-book depth is not stored and the
 * gateway never calls adapters (Requirement 9.1), so `orderBookDepth` is null;
 * `orderBookDepthSupported` reflects the source's declared capability (Req 4.3).
 * Throws {@link NotFoundError} (404) for an unknown id.
 */
export async function handleGetMarket(deps: GatewayDeps, id: string): Promise<MarketDetail> {
  const detail = await deps.discovery.getMarketDetail(id);
  if (detail === null) {
    throw new NotFoundError(`Market "${id}" not found`);
  }

  const nowMs = (deps.now ?? Date.now)();
  const [outcomes, hot] = await Promise.all([
    deps.outcomes.listByMarket(id),
    deps.hotPrices ? deps.hotPrices.getMarketHotPrices(detail.externalId) : Promise.resolve([]),
  ]);

  const outcomeDetails: OutcomeDetail[] = outcomes.map((o) => {
    const hotMatch = hot.find((h) => h.outcomeLabel.toLowerCase() === o.label.toLowerCase());
    if (hotMatch !== undefined) {
      return {
        id: o.id,
        label: o.label,
        tokenId: o.tokenId,
        impliedProb: o.impliedProb,
        lastPrice: hotMatch.price,
        latestPriceTs: hotMatch.ts,
        priceSource: "hotCache",
      };
    }
    return {
      id: o.id,
      label: o.label,
      tokenId: o.tokenId,
      impliedProb: o.impliedProb,
      lastPrice: o.lastPrice,
      latestPriceTs: null,
      priceSource: o.lastPrice === null ? "none" : "stored",
    };
  });

  const yesOutcome = outcomeDetails.find((o) => o.label.toLowerCase() === "yes");
  const impliedProb = yesOutcome ? (yesOutcome.lastPrice ?? yesOutcome.impliedProb) : null;

  const capabilities = deps.capabilities?.[detail.sourceKey];

  return {
    id: detail.id,
    source: { key: detail.sourceKey, name: detail.sourceName },
    externalId: detail.externalId,
    question: detail.question,
    category: detail.category,
    status: detail.status,
    impliedProb,
    volume24h: detail.volume24h,
    liquidity: detail.liquidity,
    spread: detail.spread,
    timeRemainingSec: timeRemainingSec(detail.endDate, nowMs),
    canonicalEventId: detail.canonicalEventId,
    resolutionCriteria: detail.resolutionCriteria,
    outcomes: outcomeDetails,
    orderBookDepth: null,
    orderBookDepthSupported: capabilities?.orderBookDepth ?? false,
    tradeLinkPath: `/api/markets/${detail.id}/trade-link`,
  };
}

/**
 * `GET /api/markets/{id}/history` — price-history time-series (Requirement 4.2).
 * Validates the market exists first (404 otherwise), then reads the series from
 * the price-point repository over the requested range/interval.
 */
export async function handleGetMarketHistory(
  deps: GatewayDeps,
  id: string,
  query: HistoryQuery,
): Promise<PriceHistoryResponse> {
  const detail = await deps.discovery.getMarketDetail(id);
  if (detail === null) {
    throw new NotFoundError(`Market "${id}" not found`);
  }

  const points = await deps.prices.history(id, query.range);
  return {
    marketId: id,
    range: {
      from: query.range.from,
      to: query.range.to,
      interval: query.range.interval ?? null,
    },
    points: points.map((p) => ({
      outcomeId: p.outcomeId,
      ts: p.ts,
      price: p.price,
      volume: p.volume,
    })),
  };
}

/**
 * `GET /api/sources` — registered platforms + declared capabilities. Identity
 * comes from the `source` table; capabilities are declared in code by each
 * adapter and supplied via {@link GatewayDeps.capabilities} (null when unknown).
 */
export async function handleListSources(deps: GatewayDeps): Promise<SourceListResponse> {
  const records = await deps.sources.list();
  const sources: SourceInfo[] = records.map((s) => ({
    key: s.key,
    name: s.name,
    type: s.type,
    baseCurrency: s.baseCurrency,
    capabilities: deps.capabilities?.[s.key] ?? null,
  }));
  return { sources };
}

/**
 * `GET /api/markets/{id}/trade-link` — the outbound trade deep-link (design
 * glossary "Trade Deep-Link"; Requirement 6.1). Looks up the market in storage
 * (404 for an unknown id), then delegates to the injected
 * {@link GatewayDeps.tradeLink} resolver — the replaceable "trade-link slot"
 * (Requirement 6.3) — to build a navigation URL on the source platform.
 *
 * v1 is navigation-only: the response carries `executable: false` and there is
 * NO order-placement, fund-routing, or execution code path (Requirements 6.2,
 * 12.1). The handler reads only from storage (Requirement 9.1) and never calls
 * an upstream platform.
 */
export async function handleGetTradeLink(deps: GatewayDeps, id: string): Promise<TradeLink> {
  const detail = await deps.discovery.getMarketDetail(id);
  if (detail === null) {
    throw new NotFoundError(`Market "${id}" not found`);
  }

  const resolve = deps.tradeLink ?? defaultTradeLinkResolver;
  return resolve({
    id: detail.id,
    sourceKey: detail.sourceKey,
    sourceName: detail.sourceName,
    externalId: detail.externalId,
  });
}

// ---------------------------------------------------------------------------
// Comparison + signals handlers (task 7.2).
// ---------------------------------------------------------------------------

/** A usable implied probability is a finite number in (or near) [0,1]. */
function isUsableProb(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}

/** Build the trade-link path for a market (the future execution slot, task 7.3). */
function tradeLinkPath(marketId: string): string {
  return `/api/markets/${marketId}/trade-link`;
}

/** Require the canonical-event reader, surfacing a clear error when unconfigured. */
function requireCanonicalEvents(deps: GatewayDeps): NonNullable<GatewayDeps["canonicalEvents"]> {
  if (deps.canonicalEvents === undefined) {
    throw new Error("Gateway is missing the canonicalEvents reader for comparison/signals routes");
  }
  return deps.canonicalEvents;
}

function toCanonicalSummary(
  row: Awaited<ReturnType<NonNullable<GatewayDeps["canonicalEvents"]>["listSummaries"]>>[number],
): CanonicalEventSummary {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    subjectEntity: row.subjectEntity,
    thresholdValue: row.thresholdValue,
    targetDate: row.targetDate,
    memberCount: row.memberCount,
    mismatchCount: row.mismatchCount,
  };
}

/**
 * `GET /api/canonical-events` — list cross-platform groupings with a
 * lightweight member-count summary, optionally filtered by category
 * (Requirement 2.1). Served entirely from storage (Requirement 9.1).
 */
export async function handleListCanonicalEvents(
  deps: GatewayDeps,
  query: CanonicalEventsQuery,
): Promise<CanonicalEventListResponse> {
  const reader = requireCanonicalEvents(deps);
  const filter = query.category ? { category: query.category } : {};
  const rows = await reader.listSummaries(filter);
  return {
    canonicalEvents: rows.map(toCanonicalSummary),
    filter: { category: query.category ?? null },
  };
}

/**
 * Resolve a comparison row's Yes implied probability, preferring the hot cache
 * (keyed by external id, Requirement 10.4) and falling back to the stored
 * Yes-outcome probability (Requirement 1.5: missing stays explicitly null).
 */
function resolveMemberImpliedProb(
  member: CanonicalComparisonMemberRow,
  hot: HotPrice[],
): number | null {
  const target = (member.yesOutcomeLabel ?? "yes").toLowerCase();
  const hotYes = hot.find((h) => h.outcomeLabel.toLowerCase() === target);
  if (hotYes !== undefined) return hotYes.price;
  return member.yesImpliedProb;
}

/**
 * `GET /api/canonical-events/{id}` — the same-question comparison view
 * (design.md `ComparisonView`). Presents each linked platform market side by
 * side (Requirement 2.1) with its implied prob, 24h volume, an explicit
 * `resolutionMismatch` flag (Req 2.3), and an outbound trade-link path.
 *
 * `maxSpread` is the max-minus-min implied probability over ONLY open,
 * non-mismatched rows with a usable probability; when fewer than two such rows
 * exist it is `null` (Req 2.4 — show the available market(s) without a spread).
 * Throws {@link NotFoundError} (404) for an unknown canonical-event id.
 */
export async function handleGetCanonicalEvent(
  deps: GatewayDeps,
  id: string,
): Promise<ComparisonView> {
  const reader = requireCanonicalEvents(deps);
  const canonicalEvent = await reader.getById(id);
  if (canonicalEvent === null) {
    throw new NotFoundError(`Canonical event "${id}" not found`);
  }

  const members = await reader.comparisonMembers(id);

  const rows: ComparisonRow[] = await Promise.all(
    members.map(async (member) => {
      const hot = deps.hotPrices ? await deps.hotPrices.getMarketHotPrices(member.externalId) : [];
      return {
        source: { key: member.sourceKey, name: member.sourceName },
        marketId: member.marketId,
        impliedProb: resolveMemberImpliedProb(member, hot),
        volume24h: member.volume24h,
        resolutionMismatch: member.resolutionMismatch,
        tradeLink: tradeLinkPath(member.marketId),
      };
    }),
  );

  // Spread is computed only over open, non-mismatched rows with a usable prob
  // (Req 2.3); fewer than two such rows → null (Req 2.4).
  const eligible = members
    .map((m, i) => ({ member: m, prob: rows[i]!.impliedProb }))
    .filter((e) => e.member.status === "open" && !e.member.resolutionMismatch)
    .map((e) => e.prob)
    .filter(isUsableProb);

  const maxSpread = eligible.length >= 2 ? Math.max(...eligible) - Math.min(...eligible) : null;

  return { canonicalEvent, rows, maxSpread };
}

/**
 * Build the Yes-implied-probability resolver the matching engine's
 * `computeSignals` injects: prefer the Redis hot cache (keyed by external id,
 * Req 10.4) and fall back to the stored Yes outcome (via `OutcomeReader`).
 * Returns `null` when no usable Yes probability exists (the market is then
 * dropped from the signal — see `@pma/matching` null policy).
 */
function makeYesImpliedProbResolver(
  deps: GatewayDeps,
): (m: LinkedMarket) => Promise<number | null> {
  return async (market: LinkedMarket): Promise<number | null> => {
    if (deps.hotPrices) {
      const hot = await deps.hotPrices.getMarketHotPrices(market.externalId);
      const hotYes = hot.find((h) => h.outcomeLabel.toLowerCase() === "yes");
      if (hotYes !== undefined && Number.isFinite(hotYes.price)) return hotYes.price;
    }
    const outcomes = await deps.outcomes.listByMarket(market.id);
    const yes = outcomes.find((o) => o.label.toLowerCase() === "yes");
    return yes ? yes.impliedProb : null;
  };
}

/**
 * `GET /api/signals` — display-only spread signals ranked by largest
 * cross-platform gap (Requirement 3.1). Enumerates canonical events from
 * storage, then delegates to the pure matching engine's `computeSignalsForMany`
 * over each event's open, resolution-aligned markets (Req 3.2, enforced by
 * matching); every signal is `executable: false` (Req 3.3). The matching logic
 * reads only storage/Redis (no adapters), preserving Requirement 9.1. An
 * optional `limit` bounds the ranked list.
 */
export async function handleListSignals(
  deps: GatewayDeps,
  query: SignalsQuery,
): Promise<SignalListResponse> {
  const reader = requireCanonicalEvents(deps);
  const summaries = await reader.listSummaries();

  // Title resolver backed by the already-fetched summaries (avoids N getById).
  const titleById = new Map(summaries.map((s) => [s.id, s.title]));

  // Map internal source ids → stable source keys for per-platform labels.
  const sourceRecords = await deps.sources.list();
  const keyBySourceId = new Map(sourceRecords.map((s) => [s.id, s.key]));

  const ids = summaries.map((s) => s.id);
  const signals = await computeSignalsForMany(
    ids,
    {
      repo: { marketsForCanonical: (id) => reader.marketsForCanonical(id) },
      getYesImpliedProb: makeYesImpliedProbResolver(deps),
    },
    {
      resolveSource: (m) => keyBySourceId.get(m.sourceId) ?? m.sourceId,
      resolveTitle: (id) => Promise.resolve(titleById.get(id) ?? null),
    },
  );

  const limit = query.limit ?? signals.length;
  const limited = signals.slice(0, limit);

  const dtos: SignalDto[] = limited.map((s) => ({
    canonicalEventId: s.canonicalEventId,
    title: s.title,
    perPlatform: s.perPlatform.map((leg) => ({ source: leg.source, impliedProb: leg.impliedProb })),
    gap: s.gap,
    executable: false,
  }));

  return { signals: dtos, limit };
}
