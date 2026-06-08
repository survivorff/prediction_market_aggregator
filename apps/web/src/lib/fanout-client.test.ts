import { describe, expect, it, vi } from "vitest";
import { createFanoutClient, deriveFanoutUrl, type WebSocketLike } from "./fanout-client";
import type { FanoutMessage } from "./dto";

/**
 * A controllable fake `WebSocket` (no real network). Records sent frames and
 * lets the test drive lifecycle events (open/message/close). Starts CONNECTING
 * so the client wires `onopen` before we fire it — mirroring a real socket.
 */
class FakeWebSocket implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: string[] = [];
  readyState = FakeWebSocket.CONNECTING;
  closed = false;

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({});
  }

  /** Test helper: transition to OPEN and fire `onopen`. */
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Test helper: deliver a relayed message frame. */
  fireMessage(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

describe("deriveFanoutUrl", () => {
  it("maps http→ws and appends /ws", () => {
    expect(deriveFanoutUrl("http://localhost:4000")).toBe("ws://localhost:4000/ws");
  });

  it("maps https→wss and appends /ws", () => {
    expect(deriveFanoutUrl("https://api.example.test")).toBe("wss://api.example.test/ws");
  });

  it("normalizes a trailing slash on the base", () => {
    expect(deriveFanoutUrl("http://localhost:4000/")).toBe("ws://localhost:4000/ws");
  });

  it("passes through an existing ws/wss base", () => {
    expect(deriveFanoutUrl("ws://h:1")).toBe("ws://h:1/ws");
    expect(deriveFanoutUrl("wss://h")).toBe("wss://h/ws");
  });
});

describe("createFanoutClient", () => {
  it("connects to the derived ws URL via the injected factory", () => {
    let created: FakeWebSocket | undefined;
    createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "market", id: "m1" }],
      onMessage: () => {},
      socketFactory: (u) => (created = new FakeWebSocket(u)),
    });
    expect(created).toBeDefined();
    expect(created!.url).toBe("ws://gw.test/ws");
  });

  it("sends the correct subscribe frame per channel once the socket opens", () => {
    const sockets: FakeWebSocket[] = [];
    createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [
        { channel: "market", id: "m1" },
        { channel: "canonical", id: "ce1" },
        { channel: "alerts" },
      ],
      onMessage: () => {},
      socketFactory: (u) => {
        const s = new FakeWebSocket(u);
        sockets.push(s);
        return s;
      },
    });
    const socket = sockets[0]!;
    // No frames before open.
    expect(socket.sent).toHaveLength(0);

    socket.fireOpen();

    expect(socket.sent.map((f) => JSON.parse(f))).toEqual([
      { action: "subscribe", channel: "market", id: "m1" },
      { action: "subscribe", channel: "canonical", id: "ce1" },
      { action: "subscribe", channel: "alerts" },
    ]);
  });

  it("dispatches relayed {channel,type,payload} envelopes to the handler", () => {
    const received: FanoutMessage[] = [];
    let socket: FakeWebSocket | undefined;
    createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "market", id: "m1" }],
      onMessage: (m) => received.push(m),
      socketFactory: (u) => (socket = new FakeWebSocket(u)),
    });
    socket!.fireOpen();

    const msg: FanoutMessage = {
      channel: "chan:market:m1",
      type: "price",
      payload: { marketId: "m1", outcomeLabel: "Yes", price: 0.62, volume: null, ts: "t" },
    };
    socket!.fireMessage(msg);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });

  it("ignores non-JSON and non-envelope frames", () => {
    const received: FanoutMessage[] = [];
    let socket: FakeWebSocket | undefined;
    createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "alerts" }],
      onMessage: (m) => received.push(m),
      socketFactory: (u) => (socket = new FakeWebSocket(u)),
    });
    socket!.fireOpen();

    socket!.fireMessage("not json{");
    socket!.fireMessage({ foo: "bar" }); // missing channel/type/payload
    socket!.fireMessage({ channel: "c", type: "bogus", payload: {} }); // bad type

    expect(received).toHaveLength(0);
  });

  it("sends unsubscribe frames and closes the socket on teardown", () => {
    let socket: FakeWebSocket | undefined;
    const client = createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "market", id: "m1" }, { channel: "alerts" }],
      onMessage: () => {},
      socketFactory: (u) => (socket = new FakeWebSocket(u)),
    });
    socket!.fireOpen();
    socket!.sent.length = 0; // clear the subscribe frames

    client.close();

    expect(socket!.sent.map((f) => JSON.parse(f))).toEqual([
      { action: "unsubscribe", channel: "market", id: "m1" },
      { action: "unsubscribe", channel: "alerts" },
    ]);
    expect(socket!.closed).toBe(true);
  });

  it("stops dispatching messages after close", () => {
    const onMessage = vi.fn();
    let socket: FakeWebSocket | undefined;
    const client = createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "market", id: "m1" }],
      onMessage,
      socketFactory: (u) => (socket = new FakeWebSocket(u)),
    });
    socket!.fireOpen();
    client.close();

    socket!.fireMessage({ channel: "chan:market:m1", type: "price", payload: {} });
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("subscribes immediately when the injected socket is already OPEN", () => {
    let socket: FakeWebSocket | undefined;
    createFanoutClient({
      url: "ws://gw.test/ws",
      subscriptions: [{ channel: "market", id: "m1" }],
      onMessage: () => {},
      socketFactory: (u) => {
        socket = new FakeWebSocket(u);
        socket.readyState = FakeWebSocket.OPEN; // already open
        return socket;
      },
    });
    expect(socket!.sent.map((f) => JSON.parse(f))).toEqual([
      { action: "subscribe", channel: "market", id: "m1" },
    ]);
  });
});
