import { describe, it, expect, vi } from "vitest";
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
import {
  withRetry,
  createFetchWrapper,
  TokenBucketRateLimiter,
  HttpError,
  MaxRetriesExceeded,
  defaultIsRetryable,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  type RateLimiter,
} from "./with-retry.js";
import { syncMarkets } from "./sync-markets.js";

/**
 * Unit tests for the resilient fetch wrapper (task 5.2 / Requirement 7.5).
 *
 * Everything is deterministic: `sleep`, the jitter source, and the rate
 * limiter's clock are all injected, so no real timers or randomness are used.
 * A captured-`sleep` spy records the exact backoff durations requested, letting
 * tests assert the `min(BASE*2^i, MAX_DELAY) + jitter` schedule precisely.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A no-wait sleep that records every requested duration in `calls`. */
function makeRecordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  calls: number[];
} {
  const calls: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleep, calls };
}

/** An operation that fails `failures` times (with `error`) then resolves `value`. */
function makeFlakyOperation<T>(
  failures: number,
  error: unknown,
  value: T,
): { op: () => Promise<T>; getCalls: () => number } {
  let calls = 0;
  const op = (): Promise<T> => {
    calls += 1;
    if (calls <= failures) return Promise.reject(error);
    return Promise.resolve(value);
  };
  return { op, getCalls: () => calls };
}

// ---------------------------------------------------------------------------
// defaultIsRetryable — error classification contract
// ---------------------------------------------------------------------------

describe("defaultIsRetryable", () => {
  it("treats a 429 (rate limited) as retryable", () => {
    expect(defaultIsRetryable(new HttpError(429))).toBe(true);
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
  });

  it("treats 5xx server errors as retryable", () => {
    expect(defaultIsRetryable(new HttpError(500))).toBe(true);
    expect(defaultIsRetryable(new HttpError(503))).toBe(true);
    expect(defaultIsRetryable({ statusCode: 599 })).toBe(true);
  });

  it("treats a generic network error (no status) as retryable", () => {
    expect(defaultIsRetryable(new Error("ECONNRESET"))).toBe(true);
    expect(defaultIsRetryable("socket hang up")).toBe(true);
    expect(defaultIsRetryable(undefined)).toBe(true);
  });

  it("treats other 4xx (400/401/404) as non-retryable", () => {
    expect(defaultIsRetryable(new HttpError(400))).toBe(false);
    expect(defaultIsRetryable(new HttpError(401))).toBe(false);
    expect(defaultIsRetryable(new HttpError(404))).toBe(false);
    expect(defaultIsRetryable({ status: 422 })).toBe(false);
  });

  it("reads `status` in preference to `statusCode`", () => {
    // status=503 (retryable) wins over statusCode=400.
    expect(defaultIsRetryable({ status: 503, statusCode: 400 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// withRetry — transient retry then success
// ---------------------------------------------------------------------------

describe("withRetry — transient errors", () => {
  it("retries a 429 and eventually succeeds", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const { op, getCalls } = makeFlakyOperation(2, new HttpError(429), "ok");

    const result = await withRetry(op, {
      sleep,
      jitter: () => 0,
      baseDelayMs: 100,
    });

    expect(result).toBe("ok");
    expect(getCalls()).toBe(3); // 2 failures + 1 success
    expect(calls).toHaveLength(2); // a sleep before each of the 2 retries
  });

  it("retries a 503 and eventually succeeds", async () => {
    const { sleep } = makeRecordingSleep();
    const { op, getCalls } = makeFlakyOperation(1, new HttpError(503), 42);

    const result = await withRetry(op, { sleep, jitter: () => 0 });

    expect(result).toBe(42);
    expect(getCalls()).toBe(2);
  });

  it("retries a generic network error (no status) and eventually succeeds", async () => {
    const { sleep } = makeRecordingSleep();
    const { op, getCalls } = makeFlakyOperation(2, new Error("ECONNRESET"), "done");

    const result = await withRetry(op, { sleep, jitter: () => 0 });

    expect(result).toBe("done");
    expect(getCalls()).toBe(3);
  });

  it("returns immediately on first success without sleeping", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.resolve("first-try"));

    const result = await withRetry(op, { sleep });

    expect(result).toBe("first-try");
    expect(op).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry — non-retryable errors propagate immediately
// ---------------------------------------------------------------------------

describe("withRetry — non-retryable errors", () => {
  it("propagates a 400 immediately without retrying", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(400, "bad request")));

    await expect(withRetry(op, { sleep, jitter: () => 0 })).rejects.toThrow(/bad request/);
    expect(op).toHaveBeenCalledTimes(1); // no retry
    expect(calls).toHaveLength(0); // never slept
  });

  it("propagates a 404 immediately without retrying", async () => {
    const { sleep } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(404)));

    await expect(withRetry(op, { sleep })).rejects.toBeInstanceOf(HttpError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("propagates the original error (not MaxRetriesExceeded) for non-retryable", async () => {
    const original = new HttpError(403, "forbidden");
    const op = () => Promise.reject(original);

    await expect(withRetry(op, { sleep: () => Promise.resolve() })).rejects.toBe(original);
  });

  it("honors a custom isRetryable classifier", async () => {
    const { sleep } = makeRecordingSleep();
    // Custom policy: nothing is retryable.
    const op = vi.fn(() => Promise.reject(new HttpError(503)));

    await expect(withRetry(op, { sleep, isRetryable: () => false })).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// withRetry — bounded by MAX_ATTEMPTS → MaxRetriesExceeded
// ---------------------------------------------------------------------------

describe("withRetry — exhaustion", () => {
  it("throws MaxRetriesExceeded after exhausting maxAttempts", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(withRetry(op, { sleep, jitter: () => 0, maxAttempts: 4 })).rejects.toBeInstanceOf(
      MaxRetriesExceeded,
    );

    // Exactly maxAttempts invocations; one fewer sleep (no trailing sleep).
    expect(op).toHaveBeenCalledTimes(4);
    expect(calls).toHaveLength(3);
  });

  it("wraps the last error as MaxRetriesExceeded.lastError and cause", async () => {
    const lastErr = new HttpError(502, "bad gateway");
    const op = () => Promise.reject(lastErr);

    let thrown: unknown;
    try {
      await withRetry(op, {
        sleep: () => Promise.resolve(),
        jitter: () => 0,
        maxAttempts: 2,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(MaxRetriesExceeded);
    const err = thrown as MaxRetriesExceeded;
    expect(err.attempts).toBe(2);
    expect(err.lastError).toBe(lastErr);
    expect(err.cause).toBe(lastErr);
  });

  it("uses DEFAULT_MAX_ATTEMPTS when not overridden", async () => {
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(
      withRetry(op, { sleep: () => Promise.resolve(), jitter: () => 0 }),
    ).rejects.toBeInstanceOf(MaxRetriesExceeded);
    expect(op).toHaveBeenCalledTimes(DEFAULT_MAX_ATTEMPTS);
  });

  it("invokes the operation exactly once when maxAttempts is 1", async () => {
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(
      withRetry(op, { sleep: () => Promise.resolve(), maxAttempts: 1 }),
    ).rejects.toBeInstanceOf(MaxRetriesExceeded);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid maxAttempts < 1", async () => {
    await expect(withRetry(() => Promise.resolve(1), { maxAttempts: 0 })).rejects.toThrow(
      /maxAttempts must be >= 1/,
    );
  });
});

// ---------------------------------------------------------------------------
// withRetry — backoff schedule: min(BASE*2^i, MAX_DELAY) + jitter
// ---------------------------------------------------------------------------

describe("withRetry — backoff schedule", () => {
  it("follows BASE*2^i with a fixed jitter, before clamping", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(
      withRetry(op, {
        sleep,
        baseDelayMs: 100,
        maxDelayMs: 100_000, // high enough that no clamping happens
        maxAttempts: 5,
        jitter: () => 7, // fixed jitter so the schedule is exact
      }),
    ).rejects.toBeInstanceOf(MaxRetriesExceeded);

    // retries 0..3 → 100*2^0..3 = 100,200,400,800; + jitter 7 each.
    expect(calls).toEqual([107, 207, 407, 807]);
  });

  it("clamps the exponential term at MAX_DELAY (jitter added on top)", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(
      withRetry(op, {
        sleep,
        baseDelayMs: 100,
        maxDelayMs: 350, // clamp kicks in once 100*2^i exceeds 350
        maxAttempts: 5,
        jitter: () => 0,
      }),
    ).rejects.toBeInstanceOf(MaxRetriesExceeded);

    // 100, 200, min(400,350)=350, min(800,350)=350
    expect(calls).toEqual([100, 200, 350, 350]);
  });

  it("derives default jitter from the injected random source", async () => {
    const { sleep, calls } = makeRecordingSleep();
    const op = vi.fn(() => Promise.reject(new HttpError(500)));

    await expect(
      withRetry(op, {
        sleep,
        baseDelayMs: 100,
        maxDelayMs: 100_000,
        maxAttempts: 2,
        random: () => 0.5, // jitter = 0.5 * baseDelay = 50
      }),
    ).rejects.toBeInstanceOf(MaxRetriesExceeded);

    // one retry: 100*2^0 + (0.5*100) = 150
    expect(calls).toEqual([150]);
  });

  it("exposes the documented default constants", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    expect(DEFAULT_BASE_DELAY_MS).toBe(200);
    expect(DEFAULT_MAX_DELAY_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// withRetry — rate limiting: acquire awaited before every attempt
// ---------------------------------------------------------------------------

describe("withRetry — rate limiting", () => {
  it("acquires a token before every attempt (including retries)", async () => {
    const acquire = vi.fn(() => Promise.resolve());
    const limiter: RateLimiter = { acquire };
    const { op } = makeFlakyOperation(2, new HttpError(429), "ok");

    const result = await withRetry(op, {
      rateLimiter: limiter,
      sourceKey: "polymarket",
      sleep: () => Promise.resolve(),
      jitter: () => 0,
    });

    expect(result).toBe("ok");
    // 3 attempts → 3 acquires, all with the source key.
    expect(acquire).toHaveBeenCalledTimes(3);
    for (const call of acquire.mock.calls) expect(call[0]).toBe("polymarket");
  });

  it("acquires before the operation each attempt (ordering)", async () => {
    const order: string[] = [];
    const limiter: RateLimiter = {
      acquire: () => {
        order.push("acquire");
        return Promise.resolve();
      },
    };
    const op = () => {
      order.push("operation");
      return Promise.resolve("ok");
    };

    await withRetry(op, { rateLimiter: limiter, sourceKey: "k" });

    expect(order).toEqual(["acquire", "operation"]);
  });
});

// ---------------------------------------------------------------------------
// TokenBucketRateLimiter — per-source throttling with an injected clock
// ---------------------------------------------------------------------------

describe("TokenBucketRateLimiter", () => {
  /** A controllable fake clock + sleep that advances the clock on sleep. */
  function makeFakeClock(startMs = 0) {
    let nowMs = startMs;
    const sleepCalls: number[] = [];
    return {
      now: () => nowMs,
      sleep: (ms: number): Promise<void> => {
        sleepCalls.push(ms);
        nowMs += ms; // sleeping advances time so tokens accrue
        return Promise.resolve();
      },
      advance: (ms: number) => {
        nowMs += ms;
      },
      sleepCalls,
    };
  }

  it("serves up to `capacity` tokens immediately without sleeping (burst)", async () => {
    const clock = makeFakeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 3,
      refillPerSecond: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire("s");
    await limiter.acquire("s");
    await limiter.acquire("s");

    expect(clock.sleepCalls).toHaveLength(0); // 3 tokens available up front
  });

  it("sleeps to throttle once the burst is exhausted", async () => {
    const clock = makeFakeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSecond: 2, // one token per 500ms
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire("s"); // consumes the initial token
    await limiter.acquire("s"); // must wait ~500ms for a refill

    expect(clock.sleepCalls.length).toBeGreaterThanOrEqual(1);
    const totalWaited = clock.sleepCalls.reduce((a, b) => a + b, 0);
    expect(totalWaited).toBeGreaterThanOrEqual(500);
  });

  it("keeps independent buckets per source key", async () => {
    const clock = makeFakeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerSecond: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    // Each key has its own full bucket → neither waits on the first acquire.
    await limiter.acquire("polymarket");
    await limiter.acquire("manifold");

    expect(clock.sleepCalls).toHaveLength(0);
  });

  it("refills over elapsed wall-clock time", async () => {
    const clock = makeFakeClock();
    const limiter = new TokenBucketRateLimiter({
      capacity: 2,
      refillPerSecond: 1,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire("s");
    await limiter.acquire("s"); // bucket now empty

    clock.advance(2000); // 2s → 2 tokens accrue (capped at capacity)

    await limiter.acquire("s");
    await limiter.acquire("s");
    expect(clock.sleepCalls).toHaveLength(0); // both served from refill
  });

  it("rejects invalid construction options", () => {
    expect(() => new TokenBucketRateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(
      /capacity must be >= 1/,
    );
    expect(() => new TokenBucketRateLimiter({ capacity: 1, refillPerSecond: 0 })).toThrow(
      /refillPerSecond must be > 0/,
    );
  });
});

// ---------------------------------------------------------------------------
// createFetchWrapper — produces a FetchWrapper bound to a source + limiter
// ---------------------------------------------------------------------------

describe("createFetchWrapper", () => {
  it("produces a FetchWrapper that rate-limits and retries", async () => {
    const acquire = vi.fn(() => Promise.resolve());
    const limiter: RateLimiter = { acquire };
    const { op, getCalls } = makeFlakyOperation(1, new HttpError(503), "page");

    const fetchWrapper = createFetchWrapper({
      sourceKey: "manifold",
      rateLimiter: limiter,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
    });

    const result = await fetchWrapper(op);

    expect(result).toBe("page");
    expect(getCalls()).toBe(2); // retried once
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire).toHaveBeenCalledWith("manifold");
  });

  it("propagates non-retryable errors through the wrapper", async () => {
    const fetchWrapper = createFetchWrapper({
      sourceKey: "manifold",
      sleep: () => Promise.resolve(),
    });

    await expect(fetchWrapper(() => Promise.reject(new HttpError(400)))).rejects.toBeInstanceOf(
      HttpError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration: the produced FetchWrapper drops into syncMarkets
// ---------------------------------------------------------------------------

describe("createFetchWrapper + syncMarkets integration", () => {
  const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

  function makeNormalizedMarket(externalId: string): NormalizedMarket {
    return {
      externalId,
      eventExternalId: null,
      question: `Question ${externalId}?`,
      status: "open",
      volume24h: 1000,
      liquidity: 500,
      spread: 0.02,
      outcomes: [
        { label: "Yes", tokenId: null, impliedProb: 0.6, lastPrice: 0.6 },
        { label: "No", tokenId: null, impliedProb: 0.4, lastPrice: 0.4 },
      ],
      resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
    };
  }

  /**
   * A flaky source whose first `fetchMarkets` call throws a transient 503, then
   * serves a single terminal page. Verifies the wrapper transparently absorbs
   * the transient failure so the sync still completes.
   */
  function makeFlakySource(): MarketSource {
    let calls = 0;
    const meta: SourceMeta = {
      id: SOURCE_ID,
      key: "flaky",
      name: "Flaky Source",
      type: "onchain",
      baseCurrency: "USDC",
    };
    const capabilities: SourceCapabilities = {
      websocketPrices: false,
      priceHistory: true,
      orderBookDepth: false,
      keysetPagination: true,
    };
    return {
      meta,
      fetchEvents: (): Promise<Page<NormalizedEvent>> =>
        Promise.resolve({ items: [], nextCursor: null }),
      fetchMarkets: (_opts: PageRequest): Promise<Page<NormalizedMarket>> => {
        calls += 1;
        if (calls === 1) return Promise.reject(new HttpError(503, "unavailable"));
        return Promise.resolve({
          items: [makeNormalizedMarket("a"), makeNormalizedMarket("b")],
          nextCursor: null,
        });
      },
      fetchPriceSnapshot: (): Promise<NormalizedPriceSnapshot[]> => Promise.resolve([]),
      fetchPriceHistory: (): Promise<NormalizedPricePoint[]> => Promise.resolve([]),
      capabilities: () => capabilities,
    };
  }

  /** Minimal in-memory MarketRepository sufficient for syncMarkets. */
  class FakeMarketRepository implements MarketRepository {
    readonly markets = new Map<string, Market>();
    cursor: string | null = null;
    private idSeq = 0;

    loadCursor(): Promise<string | null> {
      return Promise.resolve(this.cursor);
    }
    saveCursor(_sourceId: string, cursor: string | null): Promise<void> {
      this.cursor = cursor;
      return Promise.resolve();
    }
    upsertMarket(market: MarketUpsert): Promise<Market> {
      const key = `${market.sourceId}\u0000${market.externalId}`;
      const existing = this.markets.get(key);
      const id = existing ? existing.id : `m-${this.idSeq++}`;
      const persisted: Market = { ...market, id };
      this.markets.set(key, persisted);
      return Promise.resolve(persisted);
    }
    findByExternalId(sourceId: string, externalId: string): Promise<Market | null> {
      return Promise.resolve(this.markets.get(`${sourceId}\u0000${externalId}`) ?? null);
    }
    getById(id: string): Promise<Market | null> {
      for (const m of this.markets.values()) if (m.id === id) return Promise.resolve(m);
      return Promise.resolve(null);
    }
  }

  it("absorbs a transient 503 so syncMarkets completes the page", async () => {
    const source = makeFlakySource();
    const repo = new FakeMarketRepository();
    const limiter = new TokenBucketRateLimiter({
      capacity: 10,
      refillPerSecond: 100,
    });
    const fetchWrapper = createFetchWrapper({
      sourceKey: source.meta.key,
      rateLimiter: limiter,
      sleep: () => Promise.resolve(),
      jitter: () => 0,
    });

    const result = await syncMarkets(source, repo, { fetchWrapper });

    expect(result.processed).toBe(2);
    expect(repo.markets.size).toBe(2);
    expect(repo.cursor).toBeNull(); // terminal page reached
  });

  it("aborts the sync (cursor untouched) when retries are exhausted", async () => {
    // A source that always 500s.
    const meta: SourceMeta = {
      id: SOURCE_ID,
      key: "down",
      name: "Down Source",
      type: "onchain",
      baseCurrency: "USDC",
    };
    const source: MarketSource = {
      meta,
      fetchEvents: () => Promise.resolve({ items: [], nextCursor: null }),
      fetchMarkets: () => Promise.reject(new HttpError(500)),
      fetchPriceSnapshot: () => Promise.resolve([]),
      fetchPriceHistory: () => Promise.resolve([]),
      capabilities: () => ({
        websocketPrices: false,
        priceHistory: true,
        orderBookDepth: false,
        keysetPagination: true,
      }),
    };
    const repo = new FakeMarketRepository();
    repo.cursor = "prior";
    const fetchWrapper = createFetchWrapper({
      sourceKey: "down",
      sleep: () => Promise.resolve(),
      jitter: () => 0,
      maxAttempts: 2,
    });

    await expect(syncMarkets(source, repo, { fetchWrapper })).rejects.toBeInstanceOf(
      MaxRetriesExceeded,
    );

    // Requirement 7.5: cursor not advanced on failure.
    expect(repo.cursor).toBe("prior");
  });
});
