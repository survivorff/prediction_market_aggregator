import { describe, it, expect } from "vitest";
import fc from "fast-check";
import type {
  Market,
  MarketRepository,
  MarketSource,
  MarketUpsert,
  NormalizedMarket,
  Page,
  PageRequest,
  SourceMeta,
  SourceCapabilities,
  NormalizedEvent,
  NormalizedPriceSnapshot,
  NormalizedPricePoint,
} from "@pma/core";
import { syncMarkets } from "./sync-markets.js";

/**
 * Property-based test for cursor monotonicity / crash-safe resume (design
 * "Correctness Properties" → Property 6; task 5.5).
 *
 * The universal rule, straight from the `syncMarkets` postconditions and
 * Requirement 7.3:
 *
 *   For a given source the persisted keyset cursor is saved ONLY after a page
 *   is durably written; a failing page does NOT advance the cursor at all (no
 *   temporary advancement, no rollback); and across interleaved success/failure
 *   syncs the persisted cursors NEVER regress — a fresh pass resumes from
 *   exactly the persisted cursor (crash-safe resume).
 *
 * We model a deterministic keyset-paginated upstream as an ordered list of
 * pages at integer offsets `0..N-1`. Fetching with cursor `offset` returns the
 * page at that offset; its `nextCursor` is the string `offset+1` (or `null` on
 * the final page). Because offsets are monotone integers, "never regress" is a
 * decidable numeric check.
 *
 * Failures are injected deterministically and *transiently*: a page can fail
 * its fetch and/or one item's upsert a generated number of times before
 * succeeding. Each aborted `syncMarkets` run therefore consumes exactly one
 * injected failure and stops; a re-run resumes from the persisted cursor. With
 * a run budget of `totalInjectedFailures + 1` every scenario eventually drains
 * its failures and completes, so we can also assert full, in-order coverage.
 *
 * **Validates: Requirements 7.3**
 */

/** In-memory + cheap: exercise many interleavings of success/failure runs. */
const NUM_RUNS = 300;

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------------------
// Scenario generators
// ---------------------------------------------------------------------------

/** Per-page failure plan; failures are transient (clear after `times`). */
interface PagePlan {
  /** Number of markets returned by the page (may be 0 — an empty page). */
  itemCount: number;
  /** How many fetch attempts on this page fail (transiently) before succeeding. */
  fetchFailsTimes: number;
  /** Optional: one item whose upsert fails `times` before succeeding. */
  writeFail: { index: number; times: number } | null;
}

interface Scenario {
  pages: PagePlan[];
}

const arbPagePlan = (): fc.Arbitrary<PagePlan> =>
  fc.record({
    itemCount: fc.integer({ min: 0, max: 4 }),
    fetchFailsTimes: fc.integer({ min: 0, max: 3 }),
    writeFail: fc.option(
      fc.record({
        index: fc.nat({ max: 8 }),
        times: fc.integer({ min: 1, max: 3 }),
      }),
      { nil: null },
    ),
  });

const arbScenario = (): fc.Arbitrary<Scenario> =>
  fc.record({
    pages: fc.array(arbPagePlan(), { minLength: 1, maxLength: 6 }),
  });

// ---------------------------------------------------------------------------
// Deterministic in-memory upstream + repository sharing a failure budget
// ---------------------------------------------------------------------------

type SimEvent =
  | { kind: "fetch"; offset: number }
  | { kind: "fetchFail"; offset: number }
  | { kind: "upsert"; externalId: string }
  | { kind: "upsertFail"; externalId: string }
  | { kind: "save"; cursor: string | null };

interface World {
  source: MarketSource;
  repo: MarketRepository & { cursor: string | null };
  log: SimEvent[];
  pageItems: string[][];
  /** Total transient failures injected across all pages. */
  totalCredits: number;
}

function makeNormalizedMarket(externalId: string): NormalizedMarket {
  return {
    externalId,
    eventExternalId: null,
    question: `q-${externalId}`,
    status: "open",
    volume24h: null,
    liquidity: null,
    spread: null,
    outcomes: [],
    resolutionCriteria: {
      dataSource: null,
      cutoffTime: null,
      rounding: null,
      raw: {},
    },
  };
}

function buildWorld(scenario: Scenario): World {
  const pages = scenario.pages;
  const N = pages.length;
  const log: SimEvent[] = [];

  // External ids are unique per (page, item) so idempotent re-upserts on a
  // re-run collapse onto the same logical row.
  const pageItems: string[][] = pages.map((p, i) =>
    Array.from({ length: p.itemCount }, (_, j) => `p${i}-i${j}`),
  );

  // Mutable, shared transient-failure budget.
  const fetchFailRemaining = pages.map((p) => p.fetchFailsTimes);
  const writeFailRemaining = new Map<string, number>();
  pages.forEach((p, i) => {
    if (p.writeFail && p.itemCount > 0) {
      const idx = p.writeFail.index % p.itemCount;
      writeFailRemaining.set(pageItems[i]![idx]!, p.writeFail.times);
    }
  });

  const totalCredits =
    fetchFailRemaining.reduce((a, b) => a + b, 0) +
    [...writeFailRemaining.values()].reduce((a, b) => a + b, 0);

  const meta: SourceMeta = {
    id: SOURCE_ID,
    key: "fake",
    name: "Fake Source",
    type: "onchain",
    baseCurrency: "USDC",
  };
  const capabilities: SourceCapabilities = {
    websocketPrices: false,
    priceHistory: true,
    orderBookDepth: false,
    keysetPagination: true,
  };

  const source: MarketSource = {
    meta,
    fetchEvents: (): Promise<Page<NormalizedEvent>> =>
      Promise.resolve({ items: [], nextCursor: null }),
    fetchMarkets: (opts: PageRequest): Promise<Page<NormalizedMarket>> => {
      const offset = opts.cursor === undefined ? 0 : Number(opts.cursor);
      if (offset < 0 || offset >= N) {
        return Promise.reject(new Error(`out-of-range cursor offset ${offset}`));
      }
      if (fetchFailRemaining[offset]! > 0) {
        fetchFailRemaining[offset] -= 1;
        log.push({ kind: "fetchFail", offset });
        return Promise.reject(new Error(`transient fetch failure @${offset}`));
      }
      log.push({ kind: "fetch", offset });
      const items = pageItems[offset]!.map(makeNormalizedMarket);
      const nextCursor = offset + 1 < N ? String(offset + 1) : null;
      return Promise.resolve({ items, nextCursor });
    },
    fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
    fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
    capabilities: () => capabilities,
  };

  const markets = new Map<string, Market>();
  let idSeq = 0;

  const repo: MarketRepository & { cursor: string | null } = {
    cursor: null,
    loadCursor(): Promise<string | null> {
      return Promise.resolve(this.cursor);
    },
    saveCursor(_sourceId: string, cursor: string | null): Promise<void> {
      this.cursor = cursor;
      log.push({ kind: "save", cursor });
      return Promise.resolve();
    },
    upsertMarket(market: MarketUpsert): Promise<Market> {
      const remaining = writeFailRemaining.get(market.externalId) ?? 0;
      if (remaining > 0) {
        writeFailRemaining.set(market.externalId, remaining - 1);
        log.push({ kind: "upsertFail", externalId: market.externalId });
        return Promise.reject(new Error(`transient upsert failure for ${market.externalId}`));
      }
      log.push({ kind: "upsert", externalId: market.externalId });
      const key = `${market.sourceId}\u0000${market.externalId}`;
      const existing = markets.get(key);
      const id = existing ? existing.id : `m-${idSeq++}`;
      const persisted: Market = { ...market, id };
      markets.set(key, persisted);
      return Promise.resolve(persisted);
    },
    findByExternalId(sourceId: string, externalId: string): Promise<Market | null> {
      return Promise.resolve(markets.get(`${sourceId}\u0000${externalId}`) ?? null);
    },
    getById(id: string): Promise<Market | null> {
      for (const m of markets.values()) if (m.id === id) return Promise.resolve(m);
      return Promise.resolve(null);
    },
  };

  return { source, repo, log, pageItems, totalCredits };
}

// ---------------------------------------------------------------------------
// Driver: run repeated sync passes, recording per-run + global history
// ---------------------------------------------------------------------------

interface RunRecord {
  cursorBefore: string | null;
  cursorAfter: string | null;
  firstFetchOffset: number | null;
  savesInRun: Array<string | null>;
  threw: boolean;
}

interface SimResult {
  log: SimEvent[];
  runs: RunRecord[];
  completed: boolean;
  pageItems: string[][];
  finalCursor: string | null;
}

async function simulate(scenario: Scenario): Promise<SimResult> {
  const world = buildWorld(scenario);
  const { source, repo, log } = world;

  // Every injected failure aborts exactly one run; the run after the last
  // failure completes. +1 head-room keeps the loop bounded if it completes
  // immediately (no injected failures).
  const cap = world.totalCredits + 2;

  const runs: RunRecord[] = [];
  let completed = false;

  for (let r = 0; r < cap && !completed; r += 1) {
    const cursorBefore = repo.cursor;
    const logStart = log.length;
    let threw = false;
    try {
      await syncMarkets(source, repo);
      completed = true;
    } catch {
      threw = true;
    }
    const runEvents = log.slice(logStart);
    const firstFetch = runEvents.find((e) => e.kind === "fetch" || e.kind === "fetchFail");
    runs.push({
      cursorBefore,
      cursorAfter: repo.cursor,
      firstFetchOffset:
        firstFetch && (firstFetch.kind === "fetch" || firstFetch.kind === "fetchFail")
          ? firstFetch.offset
          : null,
      savesInRun: runEvents
        .filter((e): e is Extract<SimEvent, { kind: "save" }> => e.kind === "save")
        .map((e) => e.cursor),
      threw,
    });
  }

  return {
    log,
    runs,
    completed,
    pageItems: world.pageItems,
    finalCursor: repo.cursor,
  };
}

/** Map a *saved* cursor to its upstream offset; terminal `null` is the max. */
const savedOffset = (cursor: string | null, n: number): number =>
  cursor === null ? n : Number(cursor);
/** Map a *resume* cursor (loaded at run start) to its upstream offset. */
const resumeOffset = (cursor: string | null): number => (cursor === null ? 0 : Number(cursor));

// ---------------------------------------------------------------------------
// Property 6 — cursor monotonicity / crash-safe resume
// ---------------------------------------------------------------------------

describe("Property 6: cursor monotonicity / crash-safe resume (Req 7.3)", () => {
  it("persisted cursors never regress and are saved only after durable page writes", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario(), async (scenario) => {
        const { log, runs, completed, pageItems } = await simulate(scenario);
        const n = pageItems.length;

        // -- MONOTONICITY: the global save sequence strictly advances. Each
        // durably-written page advances the cursor by one offset and a page is
        // never saved twice, so saved offsets never regress (Req 7.3).
        const saves = log
          .filter((e): e is Extract<SimEvent, { kind: "save" }> => e.kind === "save")
          .map((e) => e.cursor);
        const saveOffsets = saves.map((c) => savedOffset(c, n));
        for (let i = 1; i < saveOffsets.length; i += 1) {
          expect(saveOffsets[i]!).toBeGreaterThan(saveOffsets[i - 1]!);
        }

        // -- SAVE-AFTER-DURABLE-WRITE: every `save` is immediately preceded by
        // the successful, in-order upsert of *all* of that page's items, with
        // no intervening upsert/fetch failure (Req 7.3: durable only after the
        // page is written).
        let currentPageItems: string[] | null = null;
        let upsertsSinceFetch: string[] = [];
        let failedSinceFetch = false;
        for (const e of log) {
          switch (e.kind) {
            case "fetch":
              currentPageItems = pageItems[e.offset]!;
              upsertsSinceFetch = [];
              failedSinceFetch = false;
              break;
            case "fetchFail":
              currentPageItems = null;
              upsertsSinceFetch = [];
              failedSinceFetch = true;
              break;
            case "upsert":
              upsertsSinceFetch.push(e.externalId);
              break;
            case "upsertFail":
              failedSinceFetch = true;
              break;
            case "save":
              expect(failedSinceFetch).toBe(false);
              expect(currentPageItems).not.toBeNull();
              expect(upsertsSinceFetch).toEqual(currentPageItems);
              break;
          }
        }

        // -- CRASH-SAFE RESUME + NO TEMPORARY ADVANCEMENT (per run):
        for (const rec of runs) {
          // Resumes from exactly the persisted cursor — never reprocessing
          // already-passed pages and never skipping ahead.
          expect(rec.firstFetchOffset).toBe(resumeOffset(rec.cursorBefore));

          // The cursor only ever moves forward within a run.
          const before = resumeOffset(rec.cursorBefore);
          const after = rec.cursorAfter === null ? n : Number(rec.cursorAfter);
          expect(after).toBeGreaterThanOrEqual(before);

          // A failing page leaves the cursor exactly at the last durably-saved
          // value (or untouched when no page was written) — no temporary
          // advancement and no rollback (Req 7.3).
          const expectedAfter =
            rec.savesInRun.length > 0
              ? rec.savesInRun[rec.savesInRun.length - 1]!
              : rec.cursorBefore;
          expect(rec.cursorAfter).toBe(expectedAfter);

          // A run that threw never persisted the terminal cursor: reaching the
          // end-of-stream `null` requires a fully-written final page, which
          // returns without throwing. (Note: `null` is also the *start*
          // sentinel, so we check the saves, not the post-run cursor.)
          if (rec.threw) expect(rec.savesInRun).not.toContain(null);
        }

        // -- EVENTUAL COMPLETION & FULL IN-ORDER COVERAGE: transient failures
        // always drain within the run budget, so the window completes with the
        // terminal `null`, exactly one save per page, in strictly ascending
        // order, and every item durably written at least once.
        expect(completed).toBe(true);
        expect(saves[saves.length - 1]).toBeNull();
        expect(saves).toHaveLength(n);
        const expectedNonNull = Array.from({ length: n - 1 }, (_, i) => String(i + 1));
        expect(saves.slice(0, n - 1)).toEqual(expectedNonNull);

        const upserted = new Set(
          log
            .filter((e): e is Extract<SimEvent, { kind: "upsert" }> => e.kind === "upsert")
            .map((e) => e.externalId),
        );
        for (const id of pageItems.flat()) expect(upserted.has(id)).toBe(true);

        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("a fresh pass after a failure resumes from the persisted cursor (no backward move)", async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario(), async (scenario) => {
        const { runs } = await simulate(scenario);

        // Across consecutive runs the resume point is non-decreasing: a run
        // never restarts behind where the previous run left the cursor.
        for (let i = 1; i < runs.length; i += 1) {
          const prevAfter = resumeOffset(runs[i - 1]!.cursorAfter);
          const thisBefore = resumeOffset(runs[i]!.cursorBefore);
          expect(thisBefore).toBe(prevAfter);
          expect(runs[i]!.firstFetchOffset).toBe(thisBefore);
        }
        return true;
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
