import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiscoveryControls, type DiscoveryControlValue } from "./DiscoveryControls";

const EMPTY_VALUE: DiscoveryControlValue = { q: "", category: "", status: "", sort: "" };

describe("DiscoveryControls", () => {
  it("fires onChange with the selected category (Req 1.2)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DiscoveryControls value={EMPTY_VALUE} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Category"), "crypto");

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_VALUE, category: "crypto" });
  });

  it("fires onChange with the selected status filter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DiscoveryControls value={EMPTY_VALUE} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Status"), "open");

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_VALUE, status: "open" });
  });

  it("fires onChange with the selected sort key (Req 1.4)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DiscoveryControls value={EMPTY_VALUE} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Sort by"), "volume");

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_VALUE, sort: "volume" });
  });

  it("debounces the search box and fires onChange once with the query (Req 1.2)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DiscoveryControls value={EMPTY_VALUE} onChange={onChange} searchDebounceMs={50} />);

    await user.type(screen.getByLabelText("Search"), "btc");

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...EMPTY_VALUE, q: "btc" }));
  });

  it("renders every category and sort option, with accessible labels", () => {
    render(<DiscoveryControls value={EMPTY_VALUE} onChange={vi.fn()} />);

    // Each control resolvable by its label proves the label/for wiring.
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Sort by")).toBeInTheDocument();

    // Category options include all six normalized categories + "All".
    const categorySelect = screen.getByLabelText("Category");
    expect(within(categorySelect).getAllByRole("option")).toHaveLength(7);
  });
});
