/**
 * End-to-end test for the `WS /ws` fan-out route (task 7.4 / Requirement 9.2)
 * through the real Fastify + `@fastify/websocket` stack and a real `ws` client
 * over an ephemeral TCP port, driven by a fake Redis pub/sub injected via
 * `GatewayDeps.fanoutSubscriberFactory` (no real Redis).
 *
 * Asserts the subscribe protocol, that a published `FanoutMessage` is relayed as
 * `{ channel, type, payload }`, that malformed frames are rejected gracefully,
 * and that disconnect tears down the per-connection dedicated subscriber.
 */

import { describe, it, expect, afterEach } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { marketChannel, type FanoutMessage, type PricePayload } from "@pma/storage";
import { createServer } from "./server.js";
import type { GatewayDeps } from "./dto.js";
import {
  FakeDiscoveryReader,
  FakeOutcomeReader,
  FakePriceHistoryReader,
  FakeSourceReader,
  FakeFanoutSubscriber,
} from "./test-support.js";

const MARKET_ID = "11111111-1111-1111-1111-111111111111";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) await app.close();
  app = null;
});

/** Build + listen a server whose WS fan-out uses a single shared fake subscriber. */
async function listen(): Promise<{
  server: FastifyInstance;
  url: string;
  pubsub: FakeFanoutSubscriber;
}> {
  const pubsub = new FakeFanoutSubscriber();
  const deps: GatewayDeps = {
    discovery: new FakeDiscoveryReader([]),
    outcomes: new FakeOutcomeReader([]),
    prices: new FakePriceHistoryReader([]),
    sources: new FakeSourceReader([]),
    fanoutSubscriberFactory: () => pubsub,
  };
  app = createServer(deps);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo;
  return { server: app, url: `ws://127.0.0.1:${address.port}/ws`, pubsub };
}

/** Open a `ws` client and resolve once it is connected. */
async function connect(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  await once(client, "open");
  return client;
}

function priceMessage(price: number): FanoutMessage<PricePayload> {
  return {
    channel: marketChannel(MARKET_ID),
    type: "price",
    payload: {
      marketId: MARKET_ID,
      outcomeLabel: "Yes",
      price,
      volume: null,
      ts: "2025-01-01T00:00:00.000Z",
    },
  };
}

/** Wait until the relay has registered a handler on `channel` (subscribe is async). */
async function waitForChannel(pubsub: FakeFanoutSubscriber, channel: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (pubsub.hasChannel(channel)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`channel ${channel} was never subscribed`);
}

/** Wait until `predicate()` holds, polling briefly. */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition was never met");
}

describe("WS /ws fan-out (e2e, real ws client + ephemeral port)", () => {
  it("relays a published price tick to a subscribed client", async () => {
    const { url, pubsub } = await listen();
    const client = await connect(url);
    try {
      client.send(JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }));
      await waitForChannel(pubsub, marketChannel(MARKET_ID));

      const received = once(client, "message");
      pubsub.publish(marketChannel(MARKET_ID), priceMessage(0.73));
      const [data] = await received;
      expect(JSON.parse(data.toString())).toEqual({
        channel: marketChannel(MARKET_ID),
        type: "price",
        payload: priceMessage(0.73).payload,
      });
    } finally {
      client.terminate();
    }
  });

  it("does not deliver ticks for channels the client did not subscribe to (isolation)", async () => {
    const { url, pubsub } = await listen();
    const client = await connect(url);
    try {
      client.send(JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }));
      await waitForChannel(pubsub, marketChannel(MARKET_ID));

      const frames: unknown[] = [];
      client.on("message", (d) => frames.push(JSON.parse(d.toString())));

      // A channel the client never subscribed to: no handler, nothing delivered.
      const otherId = "99999999-9999-9999-9999-999999999999";
      pubsub.publish(marketChannel(otherId), priceMessage(0.1));
      pubsub.publish(marketChannel(MARKET_ID), priceMessage(0.9));

      await waitUntil(() => frames.length >= 1);
      expect(frames).toEqual([
        { channel: marketChannel(MARKET_ID), type: "price", payload: priceMessage(0.9).payload },
      ]);
    } finally {
      client.terminate();
    }
  });

  it("rejects a malformed frame with an error and keeps the socket open", async () => {
    const { url } = await listen();
    const client = await connect(url);
    try {
      const errored = once(client, "message");
      client.send("not json");
      const [data] = await errored;
      expect(JSON.parse(data.toString())).toMatchObject({ type: "error" });
    } finally {
      client.terminate();
    }
  });

  it("tears down the dedicated subscriber when the client disconnects", async () => {
    const { url, pubsub } = await listen();
    const client = await connect(url);
    client.send(JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }));
    await waitForChannel(pubsub, marketChannel(MARKET_ID));
    expect(pubsub.closed).toBe(false);

    client.close();
    await waitUntil(() => pubsub.closed);
    expect(pubsub.closed).toBe(true);
    expect(pubsub.activeChannels).toHaveLength(0);
  });

  it("closes the dedicated subscriber on server shutdown (onClose hook)", async () => {
    const { server, url, pubsub } = await listen();
    const client = await connect(url);
    client.send(JSON.stringify({ action: "subscribe", channel: "alerts" }));
    await waitUntil(() => pubsub.subscribeCount >= 1);

    await server.close();
    app = null; // already closed
    expect(pubsub.closed).toBe(true);

    client.terminate();
  });
});
