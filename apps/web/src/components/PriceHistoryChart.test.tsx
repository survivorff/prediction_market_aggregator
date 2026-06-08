import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { PriceHistoryChart } from "./PriceHistoryChart";
import type { PriceHistoryPoint } from "../lib/dto";

// jsdom has no layout, so Recharts' ResponsiveContainer measures 0x0 and warns.
// Mock it to a fixed-size wrapper so the SVG renders cleanly under test.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 600, height: 280 }}>{children}</div>
    ),
  };
});

function point(overrides: Partial<PriceHistoryPoint> = {}): PriceHistoryPoint {
  return {
    outcomeId: "yes",
    ts: "2024-01-01T00:00:00.000Z",
    price: 0.5,
    volume: 100,
    ...overrides,
  };
}

describe("PriceHistoryChart", () => {
  it("renders an explicit empty state when there are no points (Req 4.2)", () => {
    render(<PriceHistoryChart points={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no price history/i);
  });

  it("renders a labelled figure + accessible data-table fallback for points", () => {
    const points: PriceHistoryPoint[] = [
      point({ ts: "2024-01-01T00:00:00.000Z", price: 0.4 }),
      point({ ts: "2024-01-02T00:00:00.000Z", price: 0.55 }),
    ];
    render(<PriceHistoryChart points={points} ariaLabel="BTC history" />);

    // Accessible region.
    const figure = screen.getByRole("figure", { name: "BTC history" });
    expect(figure).toBeInTheDocument();

    // The visually-hidden fallback table exposes the same data to AT.
    const table = within(figure).getByRole("table");
    const rows = within(table).getAllByRole("row");
    // header + 2 data rows.
    expect(rows).toHaveLength(3);
    expect(table).toHaveTextContent("40.0%");
    expect(table).toHaveTextContent("55.0%");
  });

  it("plots only the selected outcome when multiple are present", () => {
    const points: PriceHistoryPoint[] = [
      point({ outcomeId: "yes", price: 0.6 }),
      point({ outcomeId: "no", price: 0.4, ts: "2024-01-01T01:00:00.000Z" }),
    ];
    render(<PriceHistoryChart points={points} outcomeId="no" ariaLabel="filtered" />);

    const table = within(screen.getByRole("figure", { name: "filtered" })).getByRole("table");
    // header + exactly one "no" data row.
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table).toHaveTextContent("40.0%");
    expect(table).not.toHaveTextContent("60.0%");
  });
});
