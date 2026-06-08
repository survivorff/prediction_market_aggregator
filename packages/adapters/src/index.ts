/**
 * @pma/adapters — Per-platform MarketSource implementations.
 *
 * One folder per platform (polymarket/, manifold/). Each adapter implements the
 * MarketSource port from @pma/core and declares its capabilities. Nothing here
 * is imported by core, matching, or api — adding a platform is a localized
 * change (see design.md "Adapter Layer" and Requirement 8).
 */

export const ADAPTERS_PACKAGE = "@pma/adapters" as const;

// Polymarket adapter (task 4.2): Gamma + CLOB + WebSocket; full capabilities.
export {
  PolymarketAdapter,
  POLYMARKET_KEY,
  DEFAULT_GAMMA_BASE_URL,
  DEFAULT_CLOB_BASE_URL,
  DEFAULT_WS_URL,
  type PolymarketAdapterOptions,
  createFetchHttpClient,
  FakeWebSocket,
  type FetchLike,
  type HttpClient,
  type HttpResponse,
  type WebSocketFactory,
  type WebSocketLike,
  type NormalizedDepth,
  type OrderBookLevel,
} from "./polymarket/index.js";

// Manifold adapter (task 4.3): REST only; websocketPrices = false (the
// orchestrator routes it through tiered polling). No subscribePrices method.
export {
  ManifoldAdapter,
  MANIFOLD_KEY,
  DEFAULT_REST_BASE_URL,
  type ManifoldAdapterOptions,
} from "./manifold/index.js";

// Predict.fun adapter (task 4.6): BNB-Chain CLOB; REST only; websocketPrices =
// false (the orchestrator routes it through tiered polling). No subscribePrices
// method. Order-book mid is the Yes implied probability.
export {
  PredictFunAdapter,
  PREDICTFUN_KEY,
  DEFAULT_BASE_URL as PREDICTFUN_DEFAULT_BASE_URL,
  TESTNET_BASE_URL as PREDICTFUN_TESTNET_BASE_URL,
  type PredictFunAdapterOptions,
} from "./predictfun/index.js";
