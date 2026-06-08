/**
 * Vitest setup for the `web` project (jsdom environment).
 *
 *  - Registers the `@testing-library/jest-dom` matchers (`toBeInTheDocument`,
 *    `toHaveTextContent`, …) and auto-cleans the DOM between tests.
 *  - Polyfills `ResizeObserver` and a couple of layout APIs that Recharts'
 *    `ResponsiveContainer` touches but jsdom does not implement, so chart
 *    components render without throwing under test.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// Recharts' ResponsiveContainer observes element size; jsdom lacks it.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
