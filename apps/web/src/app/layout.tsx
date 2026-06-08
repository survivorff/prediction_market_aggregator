import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prediction Market Aggregator",
  description:
    "Unified, read-only discovery and comparison of prediction markets across platforms.",
};

/**
 * Root layout: a semantic page shell (header + main landmark) shared by every
 * route. Minimal, accessible chrome — the page content lives in the route
 * segments under `app/`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="inner">
            <h1>
              <Link href="/">Prediction Market Aggregator</Link>
            </h1>
            <nav className="site-nav" aria-label="Primary">
              <Link href="/">Discover</Link>
              <Link href="/canonical-events">Compare</Link>
              <Link href="/signals">Signals</Link>
              <Link href="/watchlist">Watchlist</Link>
            </nav>
            <span className="tagline">Read-only cross-platform discovery</span>
          </div>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
