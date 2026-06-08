import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ComparisonTable } from "./ComparisonTable";
import type { ComparisonRow, ComparisonView } from "../lib/dto";

// Pin the gateway base so the outbound trade-link href is deterministic.
const BASE = "https://gw.example.test";
let prevBase: string | undefined;
beforeAll(() => {
  prevBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  process.env.NEXT_PUBLIC_API_BASE_URL = BASE;
});
afterAll(() => {
  if (prevBase === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
  else process.env.NEXT_PUBLIC_API_BASE_URL = prevBase;
});

function row(overrides: Partial<ComparisonRow> = {}): ComparisonRow {
  return {
    source: { key: "polymarket", name: "Polymarket" },
    marketId: "m1",
    impliedProb: 0.62,
    volume24h: 1_234_000,
    resolutionMismatch: false,
    tradeLink: "/api/markets/m1/trade-link",
    ...overrides,
  };
}

function view(overrides: Partial<ComparisonView> = {}): ComparisonView {
  return {
    canonicalEvent: {
      id: "ce1",
      title: "Will BTC close above $100k in 2024?",
      category: "crypto",
      subjectEntity: "BTC",
      thresholdValue: 100000,
      targetDate: null,
    },
    rows: [row()],
    maxSpread: 0.21,
    ...overrides,
  };
}

describe("ComparisonTable", () => {
  it("renders each platform side by side with prob and 24h volume (Req 2.1)", () => {
    render(
      <ComparisonTable
        view={view({
          rows: [
            row({
              source: { key: "polymarket", name: "Polymarket" },
              marketId: "m1",
              impliedProb: 0.62,
            }),
            row({
              source: { key: "manifold", name: "Manifold" },
              marketId: "m2",
              impliedProb: 0.41,
              volume24h: 5_000,
              tradeLink: "/api/markets/m2/trade-link",
            }),
          ],
        })}
      />,
    );

    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row").slice(1); // drop header
    expect(bodyRows).toHaveLength(2);
    expect(bodyRows[0]).toHaveTextContent("Polymarket");
    expect(bodyRows[0]).toHaveTextContent("62%");
    expect(bodyRows[0]).toHaveTextContent("$1.2M");
    expect(bodyRows[1]).toHaveTextContent("Manifold");
    expect(bodyRows[1]).toHaveTextContent("41%");
    expect(bodyRows[1]).toHaveTextContent("$5.0K");
  });

  it("flags mismatched rows with an explicit badge explaining spread exclusion (Req 2.3)", () => {
    render(
      <ComparisonTable
        view={view({
          rows: [
            row({ marketId: "m1", resolutionMismatch: false }),
            row({
              marketId: "m2",
              resolutionMismatch: true,
              tradeLink: "/api/markets/m2/trade-link",
            }),
          ],
        })}
      />,
    );

    const badges = screen.getAllByText(/mismatch/i);
    // The mismatched row carries the badge; copy explains exclusion from spread.
    const mismatchBadge = badges.find((el) => el.getAttribute("data-mismatch") === "true");
    expect(mismatchBadge).toBeDefined();
    expect(mismatchBadge).toHaveTextContent(/excluded from spread/i);
  });

  it("renders maxSpread when present", () => {
    render(<ComparisonTable view={view({ maxSpread: 0.21 })} />);
    const spread = screen.getByLabelText(/maximum cross-platform spread/i);
    expect(spread).toHaveTextContent("21%");
  });

  it("renders a 'no spread' note when maxSpread is null (Req 2.4)", () => {
    render(<ComparisonTable view={view({ maxSpread: null, rows: [row()] })} />);
    const spread = screen.getByLabelText(/maximum cross-platform spread/i);
    expect(spread).toHaveTextContent(/no spread/i);
    expect(screen.getByRole("note")).toHaveTextContent(/at least two platforms/i);
  });

  it("renders a 'Go trade' deep-link button pointing OUTBOUND via the trade-link path (Req 6.1)", () => {
    render(
      <ComparisonTable view={view({ rows: [row({ tradeLink: "/api/markets/m1/trade-link" })] })} />,
    );

    const link = screen.getByRole("link", { name: /go trade/i });
    expect(link).toHaveAttribute("href", `${BASE}/api/markets/m1/trade-link`);
    // Outbound: opens in a new tab with safe rel.
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("renders null prob/volume as the em-dash placeholder", () => {
    render(
      <ComparisonTable
        view={view({ rows: [row({ impliedProb: null, volume24h: null })], maxSpread: null })}
      />,
    );
    const table = screen.getByRole("table");
    const cells = within(within(table).getAllByRole("row")[1]!).getAllByRole("cell");
    // [platform, prob, volume, resolution, trade]
    expect(cells[1]).toHaveTextContent("—");
    expect(cells[2]).toHaveTextContent("—");
  });

  it("shows an empty state when no platforms are linked", () => {
    render(<ComparisonTable view={view({ rows: [], maxSpread: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no platform markets/i);
  });
});
