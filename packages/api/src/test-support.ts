/**
 * In-memory fakes for the gateway's injected reader ports, plus a small
 * fixture builder. These let the handler/HTTP tests run with no Postgres/Redis
 * (the gateway only depends on the narrow reader interfaces in `dto.ts`), while
 * still exercising filter/sort/search and hot-cache overlay logic.
 *
 * The fakes intentionally re-implement the storage SQL's filter/sort semantics
 * in TS so unit tests assert the *gateway's* behavior independently; the
 * integration test (`gateway.integration.test.ts`) covers the real SQL.
 */

import type {
  Outcome,
  PricePoint,
  SourceCapabilities,
  TimeRange,
  CanonicalEvent,
  LinkedMarket,
  WatchlistItem,
  WatchlistItemInput,
  AlertRule,
  AlertRuleInput,
} from "@pma/core";
import { randomUUID } from "node:crypto";
import type {
  HotPrice,
  MarketDetailRow,
  MarketDiscoveryFilter,
  MarketSummaryRow,
  SourceRecord,
  CanonicalEventFilter,
  CanonicalEventSummaryRow,
  CanonicalComparisonMemberRow,
} from "@pma/storage";
import type {
  MarketDiscoveryReader,
  HotPriceReader,
  OutcomeReader,
  PriceHistoryReader,
  SourceReader,
  CanonicalEventReader,
  WatchlistStore,
  AlertStore,
  FanoutChannelSubscription,
  FanoutSubscriberPort,
} from "./dto.js";
import type { FanoutMessage } from "@pma/storage";

/** A seeded fake market with its detail row, summary row, and outcomes. */
export interface FakeMarket {
  detail: MarketDetailRow;
  summary: MarketSummaryRow;
  outcomes: Outcome[];
  history: PricePoint[];
}

export class FakeDiscoveryReader implements MarketDiscoveryReader {
  constructor(private readonly markets: FakeMarket[]) {}

  async listMarkets(filter: MarketDiscoveryFilter = {}): Promise<MarketSummaryRow[]> {
    let rows = this.markets.map((m) => m.summary);

    if (filter.category) rows = rows.filter((r) => r.category === filter.category);
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.q) {
      const needle = filter.q.toLowerCase();
      rows = rows.filter((r) => r.question.toLowerCase().includes(needle));
    }

    const sort = filter.sort ?? "volume";
    const order = filter.order ?? (sort === "timeRemaining" ? "asc" : "desc");
    const dir = order === "asc" ? 1 : -1;
    const keyOf = (r: MarketSummaryRow): number | null => {
      if (sort === "volume") return r.volume24h;
      if (sort === "liquidity") return r.liquidity;
      return r.endDate ? new Date(r.endDate).getTime() : null;
    };
    rows = [...rows].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      // NULLS LAST regardless of direction.
      if (ka === null && kb === null) return a.id < b.id ? -1 : 1;
      if (ka === null) return 1;
      if (kb === null) return -1;
      if (ka === kb) return a.id < b.id ? -1 : 1;
      return ka < kb ? -dir : dir;
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async getMarketDetail(id: string): Promise<MarketDetailRow | null> {
    return this.markets.find((m) => m.detail.id === id)?.detail ?? null;
  }
}

export class FakeOutcomeReader implements OutcomeReader {
  constructor(private readonly markets: FakeMarket[]) {}
  async listByMarket(marketId: string): Promise<Outcome[]> {
    return this.markets.find((m) => m.detail.id === marketId)?.outcomes ?? [];
  }
}

/** Outcome reader keyed by an explicit `marketId → Outcome[]` map (signals tests). */
export class FakeOutcomesByIdReader implements OutcomeReader {
  private readonly byMarket = new Map<string, Outcome[]>();
  constructor(entries: Record<string, Outcome[]> = {}) {
    for (const [marketId, outcomes] of Object.entries(entries)) {
      this.byMarket.set(marketId, outcomes);
    }
  }
  async listByMarket(marketId: string): Promise<Outcome[]> {
    return this.byMarket.get(marketId) ?? [];
  }
}
export class FakePriceHistoryReader implements PriceHistoryReader {
  constructor(private readonly markets: FakeMarket[]) {}
  async history(marketId: string, range: TimeRange): Promise<PricePoint[]> {
    const all = this.markets.find((m) => m.detail.id === marketId)?.history ?? [];
    const fromMs = new Date(range.from).getTime();
    const toMs = new Date(range.to).getTime();
    return all.filter((p) => {
      const t = new Date(p.ts).getTime();
      return t >= fromMs && t <= toMs;
    });
  }
}

export class FakeSourceReader implements SourceReader {
  constructor(private readonly sources: SourceRecord[]) {}
  async list(): Promise<SourceRecord[]> {
    return this.sources;
  }
}

/** Hot cache fake keyed by `externalId` (matching the ingestion onTick write path). */
export class FakeHotPriceReader implements HotPriceReader {
  private readonly byMarket = new Map<string, HotPrice[]>();
  constructor(entries: Record<string, HotPrice[]> = {}) {
    for (const [externalId, prices] of Object.entries(entries)) {
      this.byMarket.set(externalId, prices);
    }
  }
  async getMarketHotPrices(externalId: string): Promise<HotPrice[]> {
    return this.byMarket.get(externalId) ?? [];
  }
}

/** Build a {@link FakeMarket} with sensible defaults; override per test. */
export function makeFakeMarket(
  overrides: Partial<{
    id: string;
    externalId: string;
    sourceKey: string;
    sourceName: string;
    question: string;
    category: MarketSummaryRow["category"];
    status: MarketSummaryRow["status"];
    volume24h: number | null;
    liquidity: number | null;
    endDate: string | null;
    canonicalEventId: string | null;
    yesImpliedProb: number | null;
    outcomes: Outcome[];
    history: PricePoint[];
  }> = {},
): FakeMarket {
  const id = overrides.id ?? "11111111-1111-1111-1111-111111111111";
  const externalId = overrides.externalId ?? `ext-${id.slice(0, 8)}`;
  const sourceKey = overrides.sourceKey ?? "polymarket";
  const sourceName = overrides.sourceName ?? "Polymarket";
  const question = overrides.question ?? "Will BTC close above $100k in 2025?";
  const category = overrides.category ?? "crypto";
  const status = overrides.status ?? "open";
  // Distinguish "not provided" from an explicit null (Req 1.5 missing-field tests).
  const volume24h = "volume24h" in overrides ? (overrides.volume24h ?? null) : 1000;
  const liquidity = "liquidity" in overrides ? (overrides.liquidity ?? null) : 500;
  const endDate = "endDate" in overrides ? (overrides.endDate ?? null) : "2025-12-31T00:00:00.000Z";
  const canonicalEventId = overrides.canonicalEventId ?? null;
  const yesImpliedProb = "yesImpliedProb" in overrides ? (overrides.yesImpliedProb ?? null) : 0.6;

  const outcomes: Outcome[] = overrides.outcomes ?? [
    {
      id: `${id}-yes`,
      marketId: id,
      label: "Yes",
      tokenId: "tok-yes",
      impliedProb: yesImpliedProb,
      lastPrice: yesImpliedProb,
    },
    {
      id: `${id}-no`,
      marketId: id,
      label: "No",
      tokenId: "tok-no",
      impliedProb: yesImpliedProb === null ? null : 1 - yesImpliedProb,
      lastPrice: yesImpliedProb === null ? null : 1 - yesImpliedProb,
    },
  ];

  const summary: MarketSummaryRow = {
    id,
    externalId,
    sourceKey,
    sourceName,
    question,
    category,
    status,
    volume24h,
    liquidity,
    endDate,
    canonicalEventId,
    yesOutcomeLabel: "Yes",
    yesImpliedProb,
  };

  const detail: MarketDetailRow = {
    id,
    sourceId: `src-${sourceKey}`,
    sourceKey,
    sourceName,
    externalId,
    eventId: null,
    canonicalEventId,
    question,
    category,
    status,
    volume24h,
    liquidity,
    spread: 0.02,
    endDate,
    resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
  };

  return { detail, summary, outcomes, history: overrides.history ?? [] };
}

/** A capability set helper. */
export function caps(overrides: Partial<SourceCapabilities> = {}): SourceCapabilities {
  return {
    websocketPrices: false,
    priceHistory: false,
    orderBookDepth: false,
    keysetPagination: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Comparison + signals fakes (task 7.2).
// ---------------------------------------------------------------------------

/** A seeded fake canonical event with its summary, comparison rows, and linked markets. */
export interface FakeCanonicalEvent {
  event: CanonicalEvent;
  summary: CanonicalEventSummaryRow;
  members: CanonicalComparisonMemberRow[];
  linked: LinkedMarket[];
}

/**
 * In-memory {@link CanonicalEventReader} for the comparison/signals handler +
 * HTTP tests (no Postgres). `listSummaries` applies the optional category
 * filter; `getById` / `comparisonMembers` / `marketsForCanonical` look up by id.
 */
export class FakeCanonicalEventReader implements CanonicalEventReader {
  constructor(private readonly events: FakeCanonicalEvent[]) {}

  async listSummaries(filter: CanonicalEventFilter = {}): Promise<CanonicalEventSummaryRow[]> {
    let rows = this.events.map((e) => e.summary);
    if (filter.category) rows = rows.filter((r) => r.category === filter.category);
    return rows;
  }

  async getById(id: string): Promise<CanonicalEvent | null> {
    return this.events.find((e) => e.event.id === id)?.event ?? null;
  }

  async comparisonMembers(canonicalEventId: string): Promise<CanonicalComparisonMemberRow[]> {
    return this.events.find((e) => e.event.id === canonicalEventId)?.members ?? [];
  }

  async marketsForCanonical(canonicalEventId: string): Promise<LinkedMarket[]> {
    return this.events.find((e) => e.event.id === canonicalEventId)?.linked ?? [];
  }
}

/** Spec for one platform member of a fake canonical event. */
export interface FakeMemberSpec {
  marketId: string;
  externalId?: string;
  sourceId?: string;
  sourceKey: string;
  sourceName?: string;
  status?: LinkedMarket["status"];
  volume24h?: number | null;
  resolutionMismatch?: boolean;
  /** Yes-outcome implied probability (drives both comparison rows and signals). */
  yesImpliedProb: number | null;
}

/**
 * Build a {@link FakeCanonicalEvent} (event + summary + comparison member rows +
 * linked markets) from a small spec. Keeps the comparison-row data and the
 * `LinkedMarket` membership in sync (same source/status/prob) so handler tests
 * exercise both the comparison view and signal computation consistently.
 */
export function makeFakeCanonicalEvent(spec: {
  id: string;
  title?: string;
  category?: CanonicalEvent["category"];
  members: FakeMemberSpec[];
}): FakeCanonicalEvent {
  const title = spec.title ?? "Will BTC close above $100k in 2025?";
  const category = spec.category ?? "crypto";

  const members: CanonicalComparisonMemberRow[] = spec.members.map((m) => ({
    marketId: m.marketId,
    externalId: m.externalId ?? `ext-${m.marketId}`,
    sourceKey: m.sourceKey,
    sourceName: m.sourceName ?? m.sourceKey,
    status: m.status ?? "open",
    volume24h: "volume24h" in m ? (m.volume24h ?? null) : 1000,
    resolutionMismatch: m.resolutionMismatch ?? false,
    yesOutcomeLabel: "Yes",
    yesImpliedProb: m.yesImpliedProb,
  }));

  const linked: LinkedMarket[] = spec.members.map((m) => ({
    id: m.marketId,
    sourceId: m.sourceId ?? `src-${m.sourceKey}`,
    eventId: null,
    canonicalEventId: spec.id,
    externalId: m.externalId ?? `ext-${m.marketId}`,
    question: title,
    status: m.status ?? "open",
    volume24h: "volume24h" in m ? (m.volume24h ?? null) : 1000,
    liquidity: null,
    spread: null,
    resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
    resolutionMismatch: m.resolutionMismatch ?? false,
  }));

  const event: CanonicalEvent = {
    id: spec.id,
    title,
    category,
    subjectEntity: null,
    thresholdValue: null,
    targetDate: null,
  };

  const summary: CanonicalEventSummaryRow = {
    id: spec.id,
    title,
    category,
    subjectEntity: null,
    thresholdValue: null,
    targetDate: null,
    memberCount: members.length,
    mismatchCount: members.filter((m) => m.resolutionMismatch).length,
  };

  return { event, summary, members, linked };
}

/**
 * Build outcomes for a fake market's Yes/No pair from a Yes probability. Used by
 * the signals handler tests where the Yes implied prob is resolved from
 * `OutcomeReader` (not the comparison member rows).
 */
export function yesNoOutcomes(marketId: string, yesProb: number | null): Outcome[] {
  return [
    {
      id: `${marketId}-yes`,
      marketId,
      label: "Yes",
      tokenId: null,
      impliedProb: yesProb,
      lastPrice: yesProb,
    },
    {
      id: `${marketId}-no`,
      marketId,
      label: "No",
      tokenId: null,
      impliedProb: yesProb === null ? null : 1 - yesProb,
      lastPrice: yesProb === null ? null : 1 - yesProb,
    },
  ];
}

// ---------------------------------------------------------------------------
// Watchlist fake store (task 8.1).
// ---------------------------------------------------------------------------

let watchlistSeq = 0;

/**
 * In-memory {@link WatchlistStore} for the watchlist handler + HTTP tests (no
 * Postgres). Faithfully reproduces the storage contract that matters to the
 * gateway: duplicate prevention per `(userId, targetType, targetId)` so a
 * re-add returns the EXISTING item (Requirement 5.1), and strict user scoping
 * so list/delete only ever touch the caller's own rows (Requirements 5.4, 9.4).
 */
export class FakeWatchlistStore implements WatchlistStore {
  private readonly items: WatchlistItem[] = [];

  constructor(seed: WatchlistItem[] = []) {
    this.items.push(...seed);
  }

  async add(input: WatchlistItemInput): Promise<WatchlistItem> {
    const existing = this.items.find(
      (i) =>
        i.userId === input.userId &&
        i.targetType === input.targetType &&
        i.targetId === input.targetId,
    );
    if (existing) return { ...existing };

    watchlistSeq += 1;
    const item: WatchlistItem = {
      id: randomUUID(),
      userId: input.userId,
      targetType: input.targetType,
      targetId: input.targetId,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, watchlistSeq)).toISOString(),
    };
    this.items.push(item);
    return { ...item };
  }

  async listByUser(userId: string): Promise<WatchlistItem[]> {
    return this.items
      .filter((i) => i.userId === userId)
      .map((i) => ({ ...i }))
      .reverse(); // newest first (mirrors created_at DESC)
  }

  async delete(userId: string, itemId: string): Promise<boolean> {
    const idx = this.items.findIndex((i) => i.id === itemId && i.userId === userId);
    if (idx === -1) return false;
    this.items.splice(idx, 1);
    return true;
  }

  /** Test helper: total rows held (across all users). */
  get size(): number {
    return this.items.length;
  }
}

// ---------------------------------------------------------------------------
// Alert-rule fake store (task 8.2).
// ---------------------------------------------------------------------------

let alertSeq = 0;

/**
 * In-memory {@link AlertStore} for the alert handler + HTTP tests (no Postgres).
 * Faithfully reproduces the storage contract that matters to the gateway: NO
 * deduplication (each `create` inserts a new rule, even for the same target —
 * Requirement 5.2), the persisted `params` + `active` flag, and strict user
 * scoping so list/delete only ever touch the caller's own rows
 * (Requirements 5.4, 9.4).
 */
export class FakeAlertStore implements AlertStore {
  private readonly rules: AlertRule[] = [];

  constructor(seed: AlertRule[] = []) {
    this.rules.push(...seed);
  }

  async create(input: AlertRuleInput): Promise<AlertRule> {
    alertSeq += 1;
    const rule: AlertRule = {
      id: randomUUID(),
      userId: input.userId,
      targetType: input.targetType,
      targetId: input.targetId,
      ruleType: input.ruleType,
      params: input.params,
      active: input.active ?? true,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, alertSeq)).toISOString(),
    };
    this.rules.push(rule);
    return { ...rule };
  }

  async listByUser(userId: string): Promise<AlertRule[]> {
    return this.rules
      .filter((r) => r.userId === userId)
      .map((r) => ({ ...r }))
      .reverse(); // newest first (mirrors created_at DESC)
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const idx = this.rules.findIndex((r) => r.id === id && r.userId === userId);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  /** Test helper: total rows held (across all users). */
  get size(): number {
    return this.rules.length;
  }
}

// ---------------------------------------------------------------------------
// WebSocket fan-out fake pub/sub (task 7.4).
// ---------------------------------------------------------------------------

/**
 * In-memory {@link FanoutSubscriberPort} for the WS fan-out tests — a fake
 * Redis pub/sub. `publish(channel, message)` delivers the envelope to every
 * handler currently subscribed to that channel, so tests can assert relay
 * behavior (correct frames, channel isolation, unsubscribe, cleanup) with no
 * real Redis.
 *
 * Tracks `closed` and `subscribeCount`/`unsubscribeCount` so tests can verify
 * the per-connection lifecycle (one subscriber per WS client; dedicated
 * connection torn down on disconnect).
 */
export class FakeFanoutSubscriber implements FanoutSubscriberPort {
  /** channel → set of live handlers. */
  private readonly handlers = new Map<string, Set<(m: FanoutMessage) => void>>();
  closed = false;
  subscribeCount = 0;
  unsubscribeCount = 0;

  async subscribe(
    channel: string,
    handler: (message: FanoutMessage) => void,
  ): Promise<FanoutChannelSubscription> {
    this.subscribeCount += 1;
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);

    return {
      channel,
      close: async () => {
        this.unsubscribeCount += 1;
        const current = this.handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) this.handlers.delete(channel);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }

  /** Deliver an envelope to all handlers subscribed to `channel`. */
  publish(channel: string, message: FanoutMessage): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const handler of [...set]) handler(message);
  }

  /** Whether any handler is currently subscribed to `channel`. */
  hasChannel(channel: string): boolean {
    return (this.handlers.get(channel)?.size ?? 0) > 0;
  }

  /** Distinct channels with at least one live handler. */
  get activeChannels(): string[] {
    return [...this.handlers.keys()].filter((c) => (this.handlers.get(c)?.size ?? 0) > 0);
  }
}
