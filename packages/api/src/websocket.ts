/**
 * Fastify integration for the `WS /ws` fan-out endpoint (design.md "WebSocket
 * fan-out"; Requirement 9.2). Registers `@fastify/websocket` and the `/ws`
 * route, wiring each connected client to a per-connection {@link FanoutRelay}.
 *
 * The relay logic lives in `ws-fanout.ts` (transport-agnostic, unit-tested with
 * a fake subscriber). This module is the thin adapter that binds a `ws` socket's
 * `message`/`close` events and `send` to the relay, and manages the
 * per-connection lifecycle:
 *
 *   - ONE {@link FanoutRelay} per WS client, owning ONE dedicated Redis
 *     subscriber connection (created lazily on first subscribe).
 *   - On socket `close`, the relay unsubscribes every channel and quits its
 *     connection.
 *   - On server `close`, an `onClose` hook tears down any still-open relays so
 *     no Redis connection leaks.
 *
 * The fan-out is fed ONLY by the system's own Redis pub/sub (populated by the
 * ingestion `onTick` path); the WS layer never connects to an upstream platform
 * (Requirement 9.1).
 */

import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { GatewayDeps } from "./dto.js";
import { FanoutRelay } from "./ws-fanout.js";

/** The fan-out WebSocket path (design.md `WS /ws`). */
export const WS_FANOUT_PATH = "/ws" as const;

/** Normalize a `ws` frame payload (Buffer | ArrayBuffer | Buffer[]) to a string. */
function frameToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return String(data);
}

/**
 * Register the `WS /ws` fan-out route on `app`. Requires
 * {@link GatewayDeps.fanoutSubscriberFactory}; callers should only invoke this
 * when the factory is present (see `createServer`). Registration is queued on
 * the Fastify instance and applied at `ready()`/`listen()`/`inject()` time, so
 * `createServer` can stay synchronous.
 */
export function registerWebSocketFanout(app: FastifyInstance, deps: GatewayDeps): void {
  const factory = deps.fanoutSubscriberFactory;
  if (factory === undefined) return;

  // Track live relays so server shutdown can tear down dedicated Redis
  // connections that haven't seen a socket `close` yet.
  const liveRelays = new Set<FanoutRelay>();

  app.register(fastifyWebsocket);

  // The route is registered inside an encapsulated plugin so the `websocket`
  // route option is recognized only after the plugin above has loaded.
  app.register(async (instance) => {
    instance.get(WS_FANOUT_PATH, { websocket: true }, (socket) => {
      const relay = new FanoutRelay(factory, (frame) => socket.send(frame));
      liveRelays.add(relay);

      socket.on("message", (data: unknown) => {
        // handleFrame never throws; guard the async boundary anyway.
        void relay.handleFrame(frameToString(data)).catch(() => undefined);
      });

      const teardown = (): void => {
        if (!liveRelays.has(relay)) return;
        liveRelays.delete(relay);
        void relay.close().catch(() => undefined);
      };

      socket.on("close", teardown);
      socket.on("error", teardown);
    });
  });

  // On server shutdown, close any relays still open (and their Redis conns).
  app.addHook("onClose", async () => {
    const relays = [...liveRelays];
    liveRelays.clear();
    await Promise.all(relays.map((r) => r.close().catch(() => undefined)));
  });
}
