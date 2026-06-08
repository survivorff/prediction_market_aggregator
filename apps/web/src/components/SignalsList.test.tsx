import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SignalsList } from "./SignalsList";
import type { SignalDto } from "../lib/dto";

// next/link → a plain anchor so we can assert hrefs in jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function signal(overrides: Partial<SignalDto> = {}): SignalDto {
  return {
    canonicalEventId: "ce1",
    title: "Will BTC close above $100k in 2024?",
    perPlatform: [
      { source: "polymarket", impliedProb: 0.62 },
      { source: "manifold", impliedProb: 0.41 },
    ],
    gap: 0.21,
    executable: false,
    ...overrides,
  };
}

describe("SignalsList", () => {
  it("shows an explicit empty state when there are no signals", () => {
    render(<SignalsList signals={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no spread signals/i);
  });

  it("renders signals in the given (ranked) order with rank labels (Req 3.1)", () => {
    const signals = [
      signal({ canonicalEventId: "wide", title: "Wide gap", gap: 0.3 }),
      signal({ canonicalEventId: "narrow", title: "Narrow gap", gap: 0.05 }),
    ];
    render(<SignalsList signals={signals} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // Preserves server-provided ranking order.
    expect(items[0]).toHaveTextContent("Wide gap");
    expect(items[0]).toHaveTextContent("#1");
    expect(items[1]).toHaveTextContent("Narrow gap");
    expect(items[1]).toHaveTextContent("#2");
  });

  it("renders per-platform implied probabilities and the gap", () => {
    render(<SignalsList signals={[signal()]} />);

    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("Polymarket");
    expect(item).toHaveTextContent("62%");
    expect(item).toHaveTextContent("Manifold");
    expect(item).toHaveTextContent("41%");
    // gap 0.21 → "21% gap".
    expect(item).toHaveTextContent("21% gap");
  });

  it("links to the comparison view for the canonical event (read-only navigation)", () => {
    render(<SignalsList signals={[signal({ canonicalEventId: "abc123" })]} />);
    const link = screen.getByRole("link", { name: /compare side by side/i });
    expect(link).toHaveAttribute("href", "/canonical-events/abc123");
  });

  it("presents signals as DISPLAY-ONLY and exposes NO execution affordance (Req 3.3)", () => {
    render(<SignalsList signals={[signal()]} />);

    // Explicit non-executable framing is rendered from executable:false data.
    const flag = screen.getByText(/display only/i);
    expect(flag).toBeInTheDocument();
    expect(flag).toHaveAttribute("data-executable", "false");

    // Hard assertion: there is no buy/place-order/execute/trade control anywhere.
    expect(screen.queryByRole("button", { name: /buy|place order|execute|trade|bet/i })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /buy|place order|execute|go trade|bet/i }),
    ).toBeNull();

    // The only interactive control is the read-only compare link.
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/canonical-events/ce1");
  });

  it("renders the title placeholder when missing", () => {
    render(<SignalsList signals={[signal({ title: "" })]} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByText("—")).toBeInTheDocument();
  });
});
