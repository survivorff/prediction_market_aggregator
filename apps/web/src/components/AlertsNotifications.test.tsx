import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { AlertsNotifications } from "./AlertsNotifications";
import type { WebSocketLike } from "../lib/fanout-client";
import type { FanoutAlertPayload } from "../lib/dto";

/** A controllable fake WebSocket for the alerts fan-out subscription. */
class FakeWebSocket implements WebSocketLike {
  static readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function alertPayload(overrides: Partial<FanoutAlertPayload> = {}): FanoutAlertPayload {
  return {
    alertId: "a1",
    userId: "u1",
    ruleType: "thresholdCross",
    targetType: "market",
    targetId: "m1",
    details: {},
    ...overrides,
  };
}

describe("AlertsNotifications — live alerts (Req 5.3, 9.2)", () => {
  it("subscribes to the alerts channel and renders incoming notifications", async () => {
    let socket: FakeWebSocket | undefined;
    render(<AlertsNotifications socketFactory={(u) => (socket = new FakeWebSocket(u))} />);

    // Empty state until a notification arrives.
    expect(screen.getByText(/no alerts yet/i)).toBeInTheDocument();

    expect(socket).toBeDefined();
    act(() => socket!.fireOpen());
    expect(socket!.sent.map((f) => JSON.parse(f))).toEqual([
      { action: "subscribe", channel: "alerts" },
    ]);

    act(() =>
      socket!.fireMessage({
        channel: "chan:alerts",
        type: "alert",
        payload: alertPayload({ ruleType: "thresholdCross", targetId: "m1" }),
      }),
    );

    await waitFor(() => expect(screen.getByText(/threshold crossed/i)).toBeInTheDocument());
    expect(screen.getByText(/on m1/i)).toBeInTheDocument();
  });

  it("ignores non-alert messages relayed on the connection", async () => {
    let socket: FakeWebSocket | undefined;
    render(<AlertsNotifications socketFactory={(u) => (socket = new FakeWebSocket(u))} />);
    act(() => socket!.fireOpen());

    act(() =>
      socket!.fireMessage({
        channel: "chan:market:m1",
        type: "price",
        payload: { marketId: "m1", outcomeLabel: "Yes", price: 0.6, volume: null, ts: "t" },
      }),
    );

    // Still the empty state — price ticks are not alerts.
    expect(screen.getByText(/no alerts yet/i)).toBeInTheDocument();
  });

  it("renders a spread-widen notification distinctly", async () => {
    let socket: FakeWebSocket | undefined;
    render(<AlertsNotifications socketFactory={(u) => (socket = new FakeWebSocket(u))} />);
    act(() => socket!.fireOpen());

    act(() =>
      socket!.fireMessage({
        channel: "chan:alerts",
        type: "alert",
        payload: alertPayload({
          ruleType: "spreadWiden",
          targetType: "canonicalEvent",
          targetId: "ce1",
        }),
      }),
    );

    await waitFor(() => expect(screen.getByText(/spread widened/i)).toBeInTheDocument());
  });

  it("closes the socket on unmount (cleanup)", () => {
    let socket: FakeWebSocket | undefined;
    const { unmount } = render(
      <AlertsNotifications socketFactory={(u) => (socket = new FakeWebSocket(u))} />,
    );
    act(() => socket!.fireOpen());
    unmount();
    expect(socket!.readyState).toBe(3); // CLOSED
  });

  it("opens no connection when disabled", () => {
    let created = 0;
    render(
      <AlertsNotifications
        enabled={false}
        socketFactory={(u) => {
          created += 1;
          return new FakeWebSocket(u);
        }}
      />,
    );
    expect(created).toBe(0);
  });
});
