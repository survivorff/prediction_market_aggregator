/**
 * Optional integration test: an {@link AlertEvaluator} wired to the real
 * `@pma/storage` {@link FanoutPublisher} should publish a fired notification to
 * Redis `chan:alerts`, where a {@link FanoutSubscriber} receives it — proving
 * the dispatch path end-to-end (AlertEvaluator → publishAlert → Redis
 * chan:alerts → subscriber; the same path the API WS fan-out uses, Req 9.2).
 *
 * Runs against the docker-compose `redis:7-alpine` instance. When Redis is
 * unreachable the whole suite skips gracefully rather than hard-failing.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  FanoutPublisher,
  FanoutSubscriber,
  createRedisClient,
  alertsChannel,
  resolveRedisUrl,
  type RedisClient,
  type FanoutMessage,
} from "@pma/storage";
import type { AlertRule, WatchlistTargetType } from "@pma/core";
import { AlertEvaluator } from "./evaluator.js";
import type { AlertRulesSource } from "./ports.js";
import type { AlertNotification } from "./notification.js";

/** Connect to the dev Redis, or return null so the suite can skip. */
async function connectRedisOrSkip(): Promise<RedisClient | null> {
  const client = createRedisClient({
    url: resolveRedisUrl(),
    options: {
      connectTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    },
  });
  try {
    await client.connect();
    await client.ping();
    return client;
  } catch {
    client.disconnect();
    return null;
  }
}

/** A rules source returning a single fixed rule for any target. */
class SingleRuleSource implements AlertRulesSource {
  constructor(private readonly rule: AlertRule) {}
  findActiveRules(_targetType: WatchlistTargetType, _targetId: string): AlertRule[] {
    return [this.rule];
  }
}

async function waitFor<T>(get: () => T | null, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== null) return value;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

let redis: RedisClient | null = null;

beforeAll(async () => {
  redis = await connectRedisOrSkip();
});

afterAll(async () => {
  if (redis) await redis.quit();
});

describe("AlertEvaluator dispatch over real Redis (integration)", () => {
  let subscriber: FanoutSubscriber | null = null;

  afterEach(async () => {
    if (subscriber) {
      await subscriber.close();
      subscriber = null;
    }
  });

  it("publishes a fired thresholdCross notification to chan:alerts", async () => {
    if (!redis) return;

    subscriber = new FanoutSubscriber(createRedisClient());
    let received: FanoutMessage<AlertNotification> | null = null;
    await subscriber.subscribe(alertsChannel(), (msg) => {
      received = msg as FanoutMessage<AlertNotification>;
    });

    const rule: AlertRule = {
      id: "rule-int-1",
      userId: "user-int-1",
      targetType: "market",
      targetId: "market-int-1",
      ruleType: "thresholdCross",
      params: { threshold: 0.5 },
      active: true,
      createdAt: "2025-01-01T00:00:00.000Z",
    };

    const evaluator = new AlertEvaluator({
      rulesSource: new SingleRuleSource(rule),
      publisher: new FanoutPublisher(redis),
    });

    const fired = await evaluator.evaluatePriceUpdate("market-int-1", 0.4, 0.6);
    expect(fired).toHaveLength(1);

    const got = await waitFor(() => received);
    expect(got.type).toBe("alert");
    expect(got.channel).toBe(alertsChannel());
    expect(got.payload).toMatchObject({
      alertId: "rule-int-1",
      userId: "user-int-1",
      ruleType: "thresholdCross",
      details: { kind: "thresholdCross", direction: "up" },
    });
  });
});
