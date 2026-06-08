import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatchlistView } from "./WatchlistView";
import { ApiError, MissingTokenError, type ApiClient } from "../lib/api-client";
import type { WatchlistItem } from "../lib/dto";

// next/link → a plain anchor so we can assert hrefs in jsdom.
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// The watchlist view embeds the live-alerts surface, which opens a fan-out
// connection. Stub it so the component test does not touch WebSocket.
vi.mock("./AlertsNotifications", () => ({
  AlertsNotifications: () => <div data-testid="alerts-surface" />,
}));

function item(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: "w1",
    targetType: "market",
    targetId: "m1",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a fake ApiClient with overridable watchlist methods. */
function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base: Partial<ApiClient> = {
    listWatchlist: vi.fn().mockResolvedValue({ items: [] }),
    addWatchlist: vi.fn(),
    deleteWatchlist: vi.fn().mockResolvedValue(undefined),
    hasToken: () => true,
  };
  return { ...base, ...overrides } as ApiClient;
}

describe("WatchlistView", () => {
  it("renders the auth-required state when the client has no token (no crash on 401)", async () => {
    const client = fakeClient({
      listWatchlist: vi.fn().mockRejectedValue(new MissingTokenError("/api/watchlist")),
    });
    render(<WatchlistView client={client} />);

    expect(await screen.findByText(/requires authentication/i)).toBeInTheDocument();
    expect(screen.getByText(/NEXT_PUBLIC_API_TOKEN/)).toBeInTheDocument();
    // No add form is shown in the unauthenticated state.
    expect(screen.queryByRole("button", { name: /add to watchlist/i })).toBeNull();
  });

  it("renders the auth-required state on a 401 ApiError too", async () => {
    const client = fakeClient({
      listWatchlist: vi.fn().mockRejectedValue(new ApiError(401, "Unauthorized", "/api/watchlist")),
    });
    render(<WatchlistView client={client} />);
    expect(await screen.findByText(/requires authentication/i)).toBeInTheDocument();
  });

  it("renders an empty state when the user has no watched items", async () => {
    const client = fakeClient();
    render(<WatchlistView client={client} />);
    expect(await screen.findByText(/your watchlist is empty/i)).toBeInTheDocument();
  });

  it("lists watched items with links to their targets", async () => {
    const client = fakeClient({
      listWatchlist: vi.fn().mockResolvedValue({
        items: [
          item({ id: "w1", targetType: "market", targetId: "m1" }),
          item({ id: "w2", targetType: "canonicalEvent", targetId: "ce1" }),
        ],
      }),
    });
    render(<WatchlistView client={client} />);

    const marketLink = await screen.findByRole("link", { name: "m1" });
    expect(marketLink).toHaveAttribute("href", "/markets/m1");
    const canonicalLink = screen.getByRole("link", { name: "ce1" });
    expect(canonicalLink).toHaveAttribute("href", "/canonical-events/ce1");
  });

  it("add fires addWatchlist with the chosen target then reloads the list", async () => {
    const user = userEvent.setup();
    const listWatchlist = vi
      .fn()
      .mockResolvedValueOnce({ items: [] }) // initial load
      .mockResolvedValueOnce({ items: [item({ id: "w9", targetId: "m42" })] }); // after add
    const addWatchlist = vi.fn().mockResolvedValue(item({ id: "w9", targetId: "m42" }));
    const client = fakeClient({ listWatchlist, addWatchlist });

    render(<WatchlistView client={client} />);
    await screen.findByText(/your watchlist is empty/i);

    await user.type(screen.getByLabelText(/target id/i), "m42");
    await user.click(screen.getByRole("button", { name: /add to watchlist/i }));

    await waitFor(() =>
      expect(addWatchlist).toHaveBeenCalledWith({ targetType: "market", targetId: "m42" }),
    );
    // Reloaded list now shows the new item.
    expect(await screen.findByRole("link", { name: "m42" })).toBeInTheDocument();
    expect(listWatchlist).toHaveBeenCalledTimes(2);
  });

  it("adding a duplicate target is handled gracefully (idempotent server returns existing)", async () => {
    const user = userEvent.setup();
    const existing = item({ id: "w-existing", targetType: "canonicalEvent", targetId: "ce1" });
    const listWatchlist = vi
      .fn()
      .mockResolvedValueOnce({ items: [existing] })
      .mockResolvedValueOnce({ items: [existing] }); // unchanged after duplicate add
    const addWatchlist = vi.fn().mockResolvedValue(existing); // server returns the same row
    const client = fakeClient({ listWatchlist, addWatchlist });

    render(<WatchlistView client={client} />);
    // Switch to canonical event and re-add the existing target.
    await screen.findByRole("link", { name: "ce1" });
    await user.selectOptions(screen.getByLabelText(/type/i), "canonicalEvent");
    await user.type(screen.getByLabelText(/target id/i), "ce1");
    await user.click(screen.getByRole("button", { name: /add to watchlist/i }));

    await waitFor(() =>
      expect(addWatchlist).toHaveBeenCalledWith({ targetType: "canonicalEvent", targetId: "ce1" }),
    );
    // Still exactly one row for ce1 (no duplicate).
    expect(screen.getAllByRole("link", { name: "ce1" })).toHaveLength(1);
  });

  it("remove fires deleteWatchlist and reloads", async () => {
    const user = userEvent.setup();
    const listWatchlist = vi
      .fn()
      .mockResolvedValueOnce({ items: [item({ id: "w1", targetId: "m1" })] })
      .mockResolvedValueOnce({ items: [] }); // after delete
    const deleteWatchlist = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({ listWatchlist, deleteWatchlist });

    render(<WatchlistView client={client} />);
    const row = (await screen.findByRole("link", { name: "m1" })).closest("tr")!;
    await user.click(within(row).getByRole("button", { name: /remove m1 from watchlist/i }));

    await waitFor(() => expect(deleteWatchlist).toHaveBeenCalledWith("w1"));
    expect(await screen.findByText(/your watchlist is empty/i)).toBeInTheDocument();
  });

  it("surfaces an add error inline without crashing", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      addWatchlist: vi.fn().mockRejectedValue(new ApiError(400, "Bad Request", "/api/watchlist")),
    });
    render(<WatchlistView client={client} />);
    await screen.findByText(/your watchlist is empty/i);

    await user.type(screen.getByLabelText(/target id/i), "oops");
    await user.click(screen.getByRole("button", { name: /add to watchlist/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/400/);
  });
});
