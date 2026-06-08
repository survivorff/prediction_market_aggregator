/**
 * @pma/core — Normalized domain model, value objects, and port interfaces.
 *
 * This package is intentionally I/O-free: it depends on nothing external so the
 * domain stays pure and adapters/api can depend inward on it (see design.md
 * "Layered Architecture").
 */

export const CORE_PACKAGE = "@pma/core" as const;

// Normalized domain model: types, value objects, and validation helpers.
export * from "./model/index.js";

// Port interfaces: the MarketSource adapter contract and repository ports.
export * from "./ports/index.js";
