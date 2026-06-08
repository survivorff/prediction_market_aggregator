/**
 * Unit tests for the transport-agnostic WebSocket fan-out relay (task 7.4 /
 * Requirement 9.2). Drives {@link FanoutRelay} with an injected fake pub/sub
 * (no Fastify, no real Redis) and asserts:
 *   - subscribe protocol parsing/validation + (channel,id) → Redis channel,
 *   - a published FanoutMessage is relayed to the client as { channel, type, payload },
 *   - channel isolation (only subscribed channels are delivered),
 *   - unsubscribe stops delivery,
 *   - disconnect (close) tears down all subscriptions + the dedicated connection,
 *   - malformed/invalid frames are rejected gracefully (error frame, connection stays).
 */

import { describe, it, expect } from "vitest";
import {
  marketChannel,
  canonicalChannel,
  alertsChannel,
  type FanoutMessage,
  type PricePayload,
} from "@pma/storage";
import { FanoutRelay, parseSubscribeFrame, resolveRedisChannel } from "./ws-fanout.js";
import { FakeFanoutSubscriber } from "./test-support.js";

const MARKET_ID = "11111111-1111-1111-1111-111111111111";
const CANON_ID = "22222222-2222-2222-2222-222222222222";

/** Collect frames the relay sends, with JSON-decoding helpers. */
function sink(): { frames: string[]; send: (f: string) => void; json: () => unknown[] } {
  const frames: string[] = [];
  return {
    frames,
    send: (f: string) => frames.push(f),
    json: () => frames.map((f) => JSON.parse(f)),
  };
}

function priceMessage(marketId: string, price: number): FanoutMessage<PricePayload> {
  return {
    channel: marketChannel(marketId),
    type: "price",
    payload: { marketId, outcomeLabel: "Yes", price, volume: null, ts: "2025-01-01T00:00:00.000Z" },
  };
}

describe("parseSubscribeFrame", () => {
  it("accepts a market subscribe with an id", () => {
    const r = parseSubscribeFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    expect(r).toEqual({
      ok: true,
      request: { action: "subscribe", channel: "market", id: MARKET_ID },
    });
  });

  it("accepts a canonical subscribe with an id", () => {
    const r = parseSubscribeFrame(
      JSON.stringify({ action: "subscribe", channel: "canonical", id: CANON_ID }),
    );
    expect(r).toEqual({
      ok: true,
      request: { action: "subscribe", channel: "canonical", id: CANON_ID },
    });
  });

  it("accepts an alerts subscribe with no id", () => {
    const r = parseSubscribeFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));
    expect(r).toEqual({ ok: true, request: { action: "subscribe", channel: "alerts" } });
  });

  it("accepts an unsubscribe action", () => {
    const r = parseSubscribeFrame(
      JSON.stringify({ action: "unsubscribe", channel: "market", id: MARKET_ID }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects invalid JSON", () => {
    expect(parseSubscribeFrame("not json").ok).toBe(false);
  });

  it("rejects a non-object frame", () => {
    expect(parseSubscribeFrame(JSON.stringify(["array"])).ok).toBe(false);
    expect(parseSubscribeFrame(JSON.stringify("string")).ok).toBe(false);
  });

  it("rejects an unknown action", () => {
    expect(
      parseSubscribeFrame(JSON.stringify({ action: "delete", channel: "market", id: MARKET_ID }))
        .ok,
    ).toBe(false);
  });

  it("rejects an unknown channel", () => {
    expect(
      parseSubscribeFrame(JSON.stringify({ action: "subscribe", channel: "weather" })).ok,
    ).toBe(false);
  });

  it("rejects market/canonical without an id", () => {
    expect(parseSubscribeFrame(JSON.stringify({ action: "subscribe", channel: "market" })).ok).toBe(
      false,
    );
    expect(
      parseSubscribeFrame(JSON.stringify({ action: "subscribe", channel: "canonical", id: "  " }))
        .ok,
    ).toBe(false);
  });
});

describe("resolveRedisChannel", () => {
  it("maps each channel kind to its Redis channel name", () => {
    expect(resolveRedisChannel({ action: "subscribe", channel: "market", id: MARKET_ID })).toBe(
      marketChannel(MARKET_ID),
    );
    expect(resolveRedisChannel({ action: "subscribe", channel: "canonical", id: CANON_ID })).toBe(
      canonicalChannel(CANON_ID),
    );
    expect(resolveRedisChannel({ action: "subscribe", channel: "alerts" })).toBe(alertsChannel());
  });
});

describe("FanoutRelay relay behavior", () => {
  it("relays a published price message to a subscribed client as { channel, type, payload }", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    const msg = priceMessage(MARKET_ID, 0.62);
    pubsub.publish(marketChannel(MARKET_ID), msg);

    expect(out.json()).toEqual([
      { channel: marketChannel(MARKET_ID), type: "price", payload: msg.payload },
    ]);
  });

  it("relays canonical (spread) and alerts messages", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "canonical", id: CANON_ID }),
    );
    await relay.handleFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));

    const spread: FanoutMessage = {
      channel: canonicalChannel(CANON_ID),
      type: "spread",
      payload: { canonicalEventId: CANON_ID, gap: 0.1, probabilities: [] },
    };
    const alert: FanoutMessage = {
      channel: alertsChannel(),
      type: "alert",
      payload: { kind: "thresholdCross", marketId: MARKET_ID },
    };
    pubsub.publish(canonicalChannel(CANON_ID), spread);
    pubsub.publish(alertsChannel(), alert);

    const frames = out.json();
    expect(frames).toContainEqual({
      channel: canonicalChannel(CANON_ID),
      type: "spread",
      payload: spread.payload,
    });
    expect(frames).toContainEqual({
      channel: alertsChannel(),
      type: "alert",
      payload: alert.payload,
    });
  });

  it("isolates channels: only the subscribed channel is delivered", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );

    // Publish to a DIFFERENT market the client never subscribed to.
    pubsub.publish(
      marketChannel("99999999-9999-9999-9999-999999999999"),
      priceMessage("99999999-9999-9999-9999-999999999999", 0.5),
    );
    expect(out.frames).toHaveLength(0);

    // Publish to the subscribed market → delivered.
    pubsub.publish(marketChannel(MARKET_ID), priceMessage(MARKET_ID, 0.7));
    expect(out.frames).toHaveLength(1);
  });

  it("stops delivery after unsubscribe and releases the channel", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    expect(pubsub.hasChannel(marketChannel(MARKET_ID))).toBe(true);
    expect(relay.channelCount).toBe(1);

    await relay.handleFrame(
      JSON.stringify({ action: "unsubscribe", channel: "market", id: MARKET_ID }),
    );
    expect(pubsub.hasChannel(marketChannel(MARKET_ID))).toBe(false);
    expect(relay.channelCount).toBe(0);

    pubsub.publish(marketChannel(MARKET_ID), priceMessage(MARKET_ID, 0.7));
    expect(out.frames).toHaveLength(0);
  });

  it("subscribing twice to the same channel is idempotent (single delivery)", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    expect(relay.channelCount).toBe(1);

    pubsub.publish(marketChannel(MARKET_ID), priceMessage(MARKET_ID, 0.7));
    expect(out.frames).toHaveLength(1);
  });

  it("creates the dedicated subscriber lazily only on first subscribe", async () => {
    let created = 0;
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => {
      created += 1;
      return pubsub;
    }, out.send);

    // A malformed frame must not provision a Redis connection.
    await relay.handleFrame("garbage");
    expect(created).toBe(0);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    expect(created).toBe(1);

    // Further subscribes reuse the same subscriber (one per WS client).
    await relay.handleFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));
    expect(created).toBe(1);
  });

  it("close() unsubscribes all channels and closes the dedicated connection", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    await relay.handleFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));
    expect(relay.channelCount).toBe(2);

    await relay.close();

    expect(relay.channelCount).toBe(0);
    expect(pubsub.closed).toBe(true);
    expect(pubsub.activeChannels).toHaveLength(0);

    // Post-close publishes are not relayed.
    pubsub.publish(marketChannel(MARKET_ID), priceMessage(MARKET_ID, 0.7));
    expect(out.frames).toHaveLength(0);
  });

  it("rejects a malformed frame with an error message and keeps the connection open", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);

    await relay.handleFrame("{ not valid json");
    expect(out.json()[0]).toMatchObject({ type: "error" });

    // Connection still usable: a valid subscribe afterwards works.
    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    pubsub.publish(marketChannel(MARKET_ID), priceMessage(MARKET_ID, 0.7));
    expect(out.json().some((f) => (f as { type: string }).type === "price")).toBe(true);
  });

  it("does not relay after close, even if handlers somehow fire", async () => {
    const pubsub = new FakeFanoutSubscriber();
    const out = sink();
    const relay = new FanoutRelay(() => pubsub, out.send);
    await relay.handleFrame(
      JSON.stringify({ action: "subscribe", channel: "market", id: MARKET_ID }),
    );
    await relay.close();
    await relay.handleFrame(JSON.stringify({ action: "subscribe", channel: "alerts" }));
    expect(relay.channelCount).toBe(0);
    expect(out.frames).toHaveLength(0);
  });
});
