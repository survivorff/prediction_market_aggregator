import { describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MarketDetailView } from "./MarketDetailView";
import type { ApiClient } from "../lib/api-client";
import type { MarketDetail, PriceHistoryResponse } from "../lib/dto";
import type { WebSocketLike } from "../lib/fanout-client";

// next/link → a plain anchor for jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// The detail view embeds the add-to-watchlist control, which can hit the
// user-scoped API. Stub it so this test focuses on live price updates.
vi.mock("./AddToWatchlistButton", () => ({
  AddToWatchlistButton: () => <div data-testid="add-watchlist" />,
}));

/** A controllable fake WebSocket for the live-price subscription. */
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

function detail(overrides: Partial<MarketDetail> = {}): MarketDetail {
  return {
    id: "m1",
    source: { key: "polymarket", name: "Polymarket" },
    externalId: "ext-1",
    question: "Will BTC close above $100k in 2024?",
    category: "crypto",
    status: "open",
    impliedProb: 0.5,
    volume24h: 1000,
    liquidity: 500,
    spread: 0.02,
    timeRemainingSec: 86_400,
    canonicalEventId: null,
    resolutionCriteria: { dataSource: null, cutoffTime: null, rounding: null, raw: {} },
    outcomes: [
      {
        id: "o-yes",
        label: "Yes",
        tokenId: null,
        impliedProb: 0.5,
        lastPrice: 0.5,
        latestPriceTs: null,
        priceSource: "stored",
      },
      {
        id: "o-no",
        label: "No",
        tokenId: null,
        impliedProb: 0.5,
        lastPrice: 0.5,
        latestPriceTs: null,
        priceSource: "stored",
      },
    ],
    orderBookDepth: null,
    orderBookDepthSupported: false,
    tradeLinkPath: "/api/markets/m1/trade-link",
    ...overrides,
  };
}

const emptyHistory: PriceHistoryResponse = {
  marketId: "m1",
  range: { from: "a", to: "b", interval: null },
  points: [],
};

function fakeClient(): ApiClient {
  return {
    getMarket: vi.fn().mockResolvedValue(detail()),
    getMarketHistory: vi.fn().mockResolvedValue(emptyHistory),
  } as unknown as ApiClient;
}

describe("MarketDetailView — live price updates (Req 9.2, 5.3)", () => {
  it("subscribes to the market channel and live-updates the displayed price on a price tick", async () => {
    const client = fakeClient();
    let socket: FakeWebSocket | undefined;

    render(
      <MarketDetailView
        marketId="m1"
        client={client}
        socketFactory={(u) => (socket = new FakeWebSocket(u))}
      />,
    );

    // Initial render shows the loaded implied prob (50%).
    await screen.findByText("Will BTC close above $100k in 2024?");
    const metrics = screen.getByLabelText("Market metrics");
    expect(within(metrics).getByText("50%")).toBeInTheDocument();

    // The subscription opened and sent the market subscribe frame.
    expect(socket).toBeDefined();
    act(() => socket!.fireOpen());
    expect(socket!.sent.map((f) => JSON.parse(f))).toEqual([
      { action: "subscribe", channel: "market", id: "m1" },
    ]);

    // A live price tick on the "Yes" outcome bumps the implied probability.
    act(() =>
      socket!.fireMessage({
        channel: "chan:market:m1",
        type: "price",
        payload: { marketId: "m1", outcomeLabel: "Yes", price: 0.73, volume: null, ts: "t1" },
      }),
    );

    await waitFor(() => {
      const m = screen.getByLabelText("Market metrics");
      expect(within(m).getByText("73%")).toBeInTheDocument();
    });
    // The "Live" badge appears once a tick has been received.
    expect(screen.getByLabelText("Live updates active")).toBeInTheDocument();
  });

  it("closes the socket on unmount (cleanup)", async () => {
    const client = fakeClient();
    let socket: FakeWebSocket | undefined;
    const { unmount } = render(
      <MarketDetailView
        marketId="m1"
        client={client}
        socketFactory={(u) => (socket = new FakeWebSocket(u))}
      />,
    );
    await screen.findByText("Will BTC close above $100k in 2024?");
    act(() => socket!.fireOpen());

    unmount();
    expect(socket!.readyState).toBe(3); // CLOSED
  });
});
