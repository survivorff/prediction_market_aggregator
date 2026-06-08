import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CanonicalEventList } from "./CanonicalEventList";
import type { CanonicalEventSummary } from "../lib/dto";

// next/link → a plain anchor so we can assert hrefs in jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function event(overrides: Partial<CanonicalEventSummary> = {}): CanonicalEventSummary {
  return {
    id: "ce1",
    title: "Will BTC close above $100k in 2024?",
    category: "crypto",
    subjectEntity: "BTC",
    thresholdValue: 100000,
    targetDate: null,
    memberCount: 2,
    mismatchCount: 0,
    ...overrides,
  };
}

describe("CanonicalEventList", () => {
  it("shows an empty state when there are no events", () => {
    render(<CanonicalEventList events={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no canonical events/i);
  });

  it("links each event to its comparison view and shows coverage counts", () => {
    render(
      <CanonicalEventList events={[event({ id: "abc", memberCount: 3, mismatchCount: 1 })]} />,
    );

    const link = screen.getByRole("link", { name: /Will BTC close/ });
    expect(link).toHaveAttribute("href", "/canonical-events/abc");

    const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
    // [event, category, platforms, mismatches]
    expect(cells[2]).toHaveTextContent("3");
    const badge = within(cells[3]!).getByText("1");
    expect(badge).toHaveAttribute("data-mismatch", "true");
  });
});
