import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddToWatchlistButton } from "./AddToWatchlistButton";
import { ApiError, MissingTokenError, type ApiClient } from "../lib/api-client";
import type { WatchlistItem } from "../lib/dto";

function item(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: "w1",
    targetType: "market",
    targetId: "m1",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a fake ApiClient exposing only the watchlist add used here. */
function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  const base: Partial<ApiClient> = {
    addWatchlist: vi.fn().mockResolvedValue(item()),
    hasToken: () => true,
  };
  return { ...base, ...overrides } as ApiClient;
}

describe("AddToWatchlistButton (Req 5.1, 9.4)", () => {
  it("adds the given target via the API and shows a confirmation (idempotent server)", async () => {
    const user = userEvent.setup();
    const addWatchlist = vi.fn().mockResolvedValue(item({ targetId: "m42" }));
    const client = fakeClient({ addWatchlist });

    render(<AddToWatchlistButton targetType="market" targetId="m42" client={client} />);

    await user.click(screen.getByRole("button", { name: /watch/i }));

    await waitFor(() =>
      expect(addWatchlist).toHaveBeenCalledWith({ targetType: "market", targetId: "m42" }),
    );
    // Success state: the button is replaced by an "on your watchlist" badge.
    expect(await screen.findByText(/on your watchlist/i)).toBeInTheDocument();
  });

  it("forwards a canonicalEvent target unchanged", async () => {
    const user = userEvent.setup();
    const addWatchlist = vi
      .fn()
      .mockResolvedValue(item({ targetType: "canonicalEvent", targetId: "ce1" }));
    const client = fakeClient({ addWatchlist });

    render(<AddToWatchlistButton targetType="canonicalEvent" targetId="ce1" client={client} />);
    await user.click(screen.getByRole("button", { name: /watch/i }));

    await waitFor(() =>
      expect(addWatchlist).toHaveBeenCalledWith({ targetType: "canonicalEvent", targetId: "ce1" }),
    );
  });

  it("renders a friendly sign-in hint when no token is configured (MissingTokenError)", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      addWatchlist: vi.fn().mockRejectedValue(new MissingTokenError("/api/watchlist")),
    });

    render(<AddToWatchlistButton targetType="market" targetId="m1" client={client} />);
    await user.click(screen.getByRole("button", { name: /watch/i }));

    expect(await screen.findByText(/sign in to add to your watchlist/i)).toBeInTheDocument();
  });

  it("treats a 401 as the unauthenticated state too", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      addWatchlist: vi.fn().mockRejectedValue(new ApiError(401, "Unauthorized", "/api/watchlist")),
    });

    render(<AddToWatchlistButton targetType="market" targetId="m1" client={client} />);
    await user.click(screen.getByRole("button", { name: /watch/i }));

    expect(await screen.findByText(/sign in to add to your watchlist/i)).toBeInTheDocument();
  });

  it("surfaces a non-auth error inline without crashing", async () => {
    const user = userEvent.setup();
    const client = fakeClient({
      addWatchlist: vi.fn().mockRejectedValue(new ApiError(400, "Bad Request", "/api/watchlist")),
    });

    render(<AddToWatchlistButton targetType="market" targetId="m1" client={client} />);
    await user.click(screen.getByRole("button", { name: /watch/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/400/);
  });
});
