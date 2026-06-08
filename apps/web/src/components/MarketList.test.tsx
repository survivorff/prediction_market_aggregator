import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MarketList, MarketRow } from "./MarketList";
import type { MarketSummary } from "../lib/dto";

// next/link → a plain anchor so we can assert hrefs in jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function market(overrides: Partial<MarketSummary> = {}): MarketSummary {
  return {
    id: "m1",
    source: { key: "polymarket", name: "Polymarket" },
    question: "Will BTC close above $100k in 2024?",
    category: "crypto",
    status: "open",
    impliedProb: 0.62,
    volume24h: 1_234_000,
    liquidity: 56_000,
    timeRemainingSec: 3 * 86_400,
    canonicalEventId: null,
    ...overrides,
  };
}

/** Render a single MarketRow inside a table body for valid DOM nesting. */
function renderRow(m: MarketSummary) {
  return render(
    <table>
      <tbody>
        <MarketRow market={m} />
      </tbody>
    </table>,
  );
}

describe("MarketRow", () => {
  it("renders unified metrics with formatting", () => {
    renderRow(market());
    const row = screen.getByRole("row");
    const cells = within(row).getAllByRole("cell");
    // [question, source, category, status, prob, vol, liq, time]
    expect(cells[4]).toHaveTextContent("62%");
    expect(cells[5]).toHaveTextContent("$1.2M");
    expect(cells[6]).toHaveTextContent("$56.0K");
    expect(cells[7]).toHaveTextContent("3d 0h");
  });

  it("renders missing numeric fields as the em-dash placeholder (Req 1.5)", () => {
    renderRow(
      market({ impliedProb: null, volume24h: null, liquidity: null, timeRemainingSec: null }),
    );
    const cells = within(screen.getByRole("row")).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent("—");
    expect(cells[5]).toHaveTextContent("—");
    expect(cells[6]).toHaveTextContent("—");
    expect(cells[7]).toHaveTextContent("—");
  });

  it("links the question to the detail page", () => {
    renderRow(market({ id: "abc123" }));
    const link = screen.getByRole("link", { name: /Will BTC close/ });
    expect(link).toHaveAttribute("href", "/markets/abc123");
  });
});

describe("MarketList", () => {
  it("shows an empty state when there are no markets", () => {
    render(<MarketList markets={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no markets/i);
  });

  it("renders one row per market", () => {
    render(<MarketList markets={[market({ id: "a" }), market({ id: "b" })]} />);
    // 1 header row + 2 body rows.
    expect(screen.getAllByRole("row")).toHaveLength(3);
  });
});
