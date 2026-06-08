/**
 * Resilient fetch wrapper — `withRetry` + a per-source token-bucket rate limiter
 * (design.md "Ingestion Pipeline Algorithms" → "Resilient fetch wrapper"; task
 * 5.2).
 *
 * This is the resilience seam that plugs into `syncMarkets`'s injectable
 * {@link FetchWrapper}: it wraps each upstream call with (a) per-source rate
 * limiting (a token bucket keyed by `source.meta.key`) and (b) jittered
 * exponential backoff that retries only *transient* failures and propagates
 * non-retryable ones immediately.
 *
 * The design pseudocode:
 *
 * ```pascal
 * ALGORITHM withRetry(operation)
 * BEGIN
 *   attempt ← 0
 *   WHILE attempt < MAX_ATTEMPTS DO
 *     rateLimiter.acquire(source.meta.key)   // token bucket per source
 *     TRY
 *       RETURN await operation()
 *     CATCH err
 *       IF NOT isRetryable(err) THEN THROW err END IF
 *       delay ← min(BASE_DELAY * 2^attempt, MAX_DELAY) + jitter()
 *       sleep(delay)
 *       attempt ← attempt + 1
 *     END TRY
 *   END WHILE
 *   THROW MaxRetriesExceeded
 * END
 * ```
 *
 * **Postconditions** (design): transient errors (429, 5xx, network) are retried
 * with exponentially increasing, jittered delays bounded by `MAX_DELAY`;
 * non-retryable errors (4xx other than 429) propagate immediately.
 *
 * Every source of non-determinism — the clock, `sleep`, the jitter source — is
 * injectable so the whole module is unit-testable without real timers or
 * randomness (no flaky timing tests).
 *
 * **Deviation from the literal pseudocode (documented intent):** the pseudocode
 * computes a delay and sleeps even after the *final* failed attempt, then exits
 * the loop and throws. We skip that pointless trailing sleep — after the last
 * attempt fails we throw {@link MaxRetriesExceeded} immediately. The number of
 * `operation()` invocations is still exactly `MAX_ATTEMPTS`; only the redundant
 * post-exhaustion sleep is removed. Backoff delays therefore follow
 * `min(BASE_DELAY * 2^i, MAX_DELAY) + jitter()` for `i = 0 .. MAX_ATTEMPTS-2`
 * (one delay before each retry).
 *
 * Requirements: 7.5 — on a transient upstream failure (rate limit, 5xx,
 * network) apply rate limiting and jittered exponential backoff up to a maximum
 * attempt count (the caller — `syncMarkets` — guarantees the cursor is not
 * advanced on failure because the thrown error aborts the page).
 */

import type { FetchWrapper } from "./sync-markets.js";

// ---------------------------------------------------------------------------
// Defaults (the design's MAX_ATTEMPTS / BASE_DELAY / MAX_DELAY)
// ---------------------------------------------------------------------------

/** `MAX_ATTEMPTS`: total operation invocations before giving up. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** `BASE_DELAY` (ms): the first retry's un-jittered backoff. */
export const DEFAULT_BASE_DELAY_MS = 200;

/** `MAX_DELAY` (ms): upper bound on the exponential term (jitter adds on top). */
export const DEFAULT_MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// Retryable-error contract
// ---------------------------------------------------------------------------

/**
 * The minimal shape `withRetry` reads off a thrown error to classify it.
 *
 * An error carries its HTTP status either as `status` or `statusCode` (both are
 * common in the JS ecosystem; the adapters' {@link HttpResponse} exposes
 * `status`). An error with **no** numeric status is treated as a generic
 * network/transport failure (e.g. DNS failure, socket reset, timeout) and is
 * therefore retryable.
 *
 * Throw {@link HttpError} for a typed, status-carrying error, or any object
 * with a numeric `status`/`statusCode` — both are understood by
 * {@link defaultIsRetryable}.
 */
export interface StatusCarryingError {
  status?: number;
  statusCode?: number;
}

/**
 * A typed HTTP error carrying a numeric `status`, suitable for throwing from an
 * adapter's HTTP layer so {@link defaultIsRetryable} can classify it. Preserves
 * the underlying cause via the standard `Error` `cause` option.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? `HTTP ${status}`, options);
    this.name = "HttpError";
  }
}

/**
 * Thrown by {@link withRetry} once a retryable operation has failed
 * `attempts` times (i.e. `MAX_ATTEMPTS` exhausted). The triggering error is
 * preserved both as {@link lastError} and as the standard `Error` `cause`, so
 * callers can inspect the final upstream failure.
 */
export class MaxRetriesExceeded extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError: unknown,
  ) {
    super(`Operation failed after ${attempts} attempt(s)`, {
      cause: lastError,
    });
    this.name = "MaxRetriesExceeded";
  }
}

/**
 * Extract a numeric HTTP status from an unknown thrown value, reading `status`
 * first then `statusCode`. Returns `undefined` when neither is a number — the
 * caller treats that as a generic network error.
 */
function extractStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const e = err as StatusCarryingError;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
  }
  return undefined;
}

/**
 * Default retry classifier (design "non-retryable errors (4xx other than 429)
 * propagate immediately"):
 *
 * - **No status** → generic network/transport error → **retryable**.
 * - `429` (Too Many Requests) → **retryable**.
 * - `5xx` (server errors) → **retryable**.
 * - any other status (notably 4xx such as 400/404) → **non-retryable**.
 *
 * Override via {@link RetryOptions.isRetryable} for source-specific policies.
 */
export function defaultIsRetryable(err: unknown): boolean {
  const status = extractStatus(err);
  if (status === undefined) return true; // network/transport error
  if (status === 429) return true; // rate limited
  if (status >= 500 && status <= 599) return true; // server error
  return false; // other 4xx (and anything else with a status)
}

// ---------------------------------------------------------------------------
// Injectable clock / sleep
// ---------------------------------------------------------------------------

/** Real wall-clock sleep. Replaced by a deterministic fake in tests. */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Real monotonic-ish clock in ms. Replaced by a fake clock in tests. */
const realNow = (): number => Date.now();

// ---------------------------------------------------------------------------
// Per-source token-bucket rate limiter
// ---------------------------------------------------------------------------

/**
 * The narrow rate-limit contract `withRetry` depends on. `acquire` resolves
 * once a request token is available for `sourceKey`, throttling the per-source
 * request rate. A shared limiter instance enforces independent budgets across
 * sources (each key gets its own bucket).
 */
export interface RateLimiter {
  /** Resolves once a token is available for `sourceKey` (may wait). */
  acquire(sourceKey: string): Promise<void>;
}

/** Construction options for {@link TokenBucketRateLimiter}. */
export interface TokenBucketOptions {
  /** Max tokens a bucket holds (the burst size). Must be ≥ 1. */
  capacity: number;
  /** Tokens replenished per second. Must be > 0. */
  refillPerSecond: number;
  /** Initial token count per bucket. Defaults to `capacity` (full burst). */
  initialTokens?: number;
  /** Injectable ms clock. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Injectable sleep. Defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Mutable per-source bucket state. */
interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/** Tolerance for floating-point token comparisons. */
const TOKEN_EPSILON = 1e-9;

/**
 * A clean, dependency-free token-bucket rate limiter with **one bucket per
 * source key**. Tokens refill continuously at `refillPerSecond`, capped at
 * `capacity` (which also bounds burstiness). `acquire` consumes one token,
 * waiting (via the injected `sleep`) only when the bucket is empty.
 *
 * Determinism: the clock and sleep are injectable, so a test can drive a fake
 * clock that advances exactly when `sleep` is called, making rate-limit waits
 * fully reproducible.
 *
 * Note: this models a single-process limiter; concurrent `acquire` calls for
 * the same key are serialized by the event loop between `await` points, which
 * is sufficient for the ingestion orchestrator's per-source polling loop.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly capacity: number;
  private readonly refillRatePerMs: number;
  private readonly initialTokens: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, BucketState>();

  constructor(options: TokenBucketOptions) {
    if (!(options.capacity >= 1)) {
      throw new Error("TokenBucketRateLimiter: capacity must be >= 1");
    }
    if (!(options.refillPerSecond > 0)) {
      throw new Error("TokenBucketRateLimiter: refillPerSecond must be > 0");
    }
    this.capacity = options.capacity;
    this.refillRatePerMs = options.refillPerSecond / 1000;
    this.initialTokens = Math.min(options.capacity, options.initialTokens ?? options.capacity);
    this.now = options.now ?? realNow;
    this.sleep = options.sleep ?? realSleep;
  }

  async acquire(sourceKey: string): Promise<void> {
    const state = this.bucketFor(sourceKey);
    // Loop because, after sleeping, we re-check (a shared/concurrent limiter
    // could have its tokens consumed again before this call resumes).
    for (;;) {
      this.refill(state);
      if (state.tokens >= 1 - TOKEN_EPSILON) {
        state.tokens -= 1;
        return;
      }
      // Wait just long enough to accrue the remaining fraction of a token.
      const needed = 1 - state.tokens;
      const waitMs = Math.max(1, Math.ceil(needed / this.refillRatePerMs));
      await this.sleep(waitMs);
    }
  }

  /** Lazily create the bucket for `sourceKey`, seeded with `initialTokens`. */
  private bucketFor(sourceKey: string): BucketState {
    let state = this.buckets.get(sourceKey);
    if (state === undefined) {
      state = { tokens: this.initialTokens, lastRefillMs: this.now() };
      this.buckets.set(sourceKey, state);
    }
    return state;
  }

  /** Add tokens accrued since `lastRefillMs`, capped at `capacity`. */
  private refill(state: BucketState): void {
    const current = this.now();
    const elapsed = current - state.lastRefillMs;
    if (elapsed > 0) {
      state.tokens = Math.min(this.capacity, state.tokens + elapsed * this.refillRatePerMs);
      state.lastRefillMs = current;
    }
  }
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/**
 * Options for {@link withRetry}. Every field is optional; the defaults
 * reproduce the design's `MAX_ATTEMPTS` / `BASE_DELAY` / `MAX_DELAY` behavior
 * with no rate limiting and real timers.
 */
export interface RetryOptions {
  /**
   * Per-source rate limiter; `acquire(sourceKey)` is awaited before each
   * attempt (design's `rateLimiter.acquire(source.meta.key)`). Omit to disable
   * rate limiting.
   */
  rateLimiter?: RateLimiter;
  /** Source key passed to `rateLimiter.acquire`. Required iff a limiter is set. */
  sourceKey?: string;
  /** Max operation invocations before throwing {@link MaxRetriesExceeded}. */
  maxAttempts?: number;
  /** `BASE_DELAY` in ms. */
  baseDelayMs?: number;
  /** `MAX_DELAY` in ms — caps the exponential term (jitter is added on top). */
  maxDelayMs?: number;
  /** Retry classifier; defaults to {@link defaultIsRetryable}. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable sleep used between attempts. Defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable `[0, 1)` random source used by the default jitter. Ignored when
   * a custom {@link jitter} is supplied. Defaults to {@link Math.random}.
   */
  random?: () => number;
  /**
   * Jitter contribution (ms) added to each clamped backoff delay. Defaults to
   * `random() * baseDelayMs` (additive "full jitter" up to one base delay).
   * Override for a custom jitter policy or to make tests assert exact delays.
   */
  jitter?: () => number;
}

/**
 * Compute the backoff delay for retry `retryIndex` (0-based): the design's
 * `min(BASE_DELAY * 2^retryIndex, MAX_DELAY) + jitter()`. Jitter is added
 * *after* the clamp, so the realized delay may exceed `MAX_DELAY` by up to one
 * jitter sample (matching the design).
 */
function computeBackoffDelay(
  retryIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: () => number,
): number {
  const exponential = baseDelayMs * 2 ** retryIndex;
  return Math.min(exponential, maxDelayMs) + jitter();
}

/**
 * Run `operation`, retrying transient failures with jittered exponential
 * backoff and per-source token-bucket rate limiting (design "Resilient fetch
 * wrapper"; Requirement 7.5).
 *
 * Behavior:
 * - Before each attempt, `rateLimiter.acquire(sourceKey)` is awaited (when a
 *   limiter is configured), throttling the per-source request rate.
 * - On success the operation's value is returned immediately.
 * - On a **non-retryable** error (per {@link RetryOptions.isRetryable}) the
 *   error is rethrown immediately — no further attempts.
 * - On a **retryable** error, if attempts remain the wrapper sleeps for
 *   `min(BASE_DELAY * 2^i, MAX_DELAY) + jitter()` and retries; once
 *   `MAX_ATTEMPTS` is exhausted it throws {@link MaxRetriesExceeded} wrapping
 *   the last error.
 *
 * @throws the original error for non-retryable failures.
 * @throws {MaxRetriesExceeded} when retryable failures exhaust `MAX_ATTEMPTS`.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    rateLimiter,
    sourceKey = "",
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    isRetryable = defaultIsRetryable,
    sleep = realSleep,
    random = Math.random,
  } = options;

  if (!(maxAttempts >= 1)) {
    throw new Error("withRetry: maxAttempts must be >= 1");
  }

  const jitter = options.jitter ?? (() => random() * baseDelayMs);

  // `attempt` counts invocations already made. Loop until success, a
  // non-retryable error, or exhaustion.
  let attempt = 0;
  for (;;) {
    if (rateLimiter) {
      await rateLimiter.acquire(sourceKey);
    }

    try {
      return await operation();
    } catch (err) {
      // Non-retryable (e.g. 400/404): propagate immediately.
      if (!isRetryable(err)) throw err;

      attempt += 1;

      // Exhausted MAX_ATTEMPTS — give up with the last error preserved.
      if (attempt >= maxAttempts) {
        throw new MaxRetriesExceeded(maxAttempts, err);
      }

      // Backoff before the next attempt. `attempt - 1` is the 0-based retry
      // index, so the first retry waits BASE_DELAY * 2^0 (+ jitter).
      const delay = computeBackoffDelay(attempt - 1, baseDelayMs, maxDelayMs, jitter);
      await sleep(delay);
    }
  }
}

// ---------------------------------------------------------------------------
// FetchWrapper factory (drops into syncMarkets({ fetchWrapper }))
// ---------------------------------------------------------------------------

/**
 * Options for {@link createFetchWrapper}: a source key plus the shared rate
 * limiter and retry policy to bind into the produced wrapper.
 */
export interface CreateFetchWrapperOptions extends Omit<RetryOptions, "sourceKey"> {
  /** Stable source slug (`source.meta.key`) used for per-source rate limiting. */
  sourceKey: string;
}

/**
 * Build a {@link FetchWrapper} bound to a source key, a (typically shared)
 * {@link RateLimiter}, and a retry policy. The result drops directly into
 * `syncMarkets({ fetchWrapper })`, so every page fetch for that source is rate
 * limited and retried with jittered exponential backoff — with zero changes to
 * the sync algorithm.
 *
 * ```ts
 * const limiter = new TokenBucketRateLimiter({ capacity: 5, refillPerSecond: 5 });
 * const fetchWrapper = createFetchWrapper({
 *   sourceKey: source.meta.key,
 *   rateLimiter: limiter,
 * });
 * await syncMarkets(source, repo, { fetchWrapper });
 * ```
 */
export function createFetchWrapper(options: CreateFetchWrapperOptions): FetchWrapper {
  const { sourceKey, ...retryOptions } = options;
  return <T>(operation: () => Promise<T>): Promise<T> =>
    withRetry(operation, { ...retryOptions, sourceKey });
}
