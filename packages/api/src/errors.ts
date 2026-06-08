/**
 * Typed gateway errors mapped to HTTP status codes by the Fastify error
 * handler (see `server.ts`). Keeping these as plain classes lets handler logic
 * stay framework-agnostic and unit-testable without booting Fastify.
 */

/** A client input error → HTTP 400 (Requirement 9.3: validate input params). */
export class ValidationError extends Error {
  readonly statusCode = 400 as const;
  /** Optional machine-readable field that failed validation. */
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

/** A missing-resource error → HTTP 404 (e.g. unknown market id). */
export class NotFoundError extends Error {
  readonly statusCode = 404 as const;

  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * A missing/invalid-credentials error → HTTP 401 (Requirement 9.4: user-scoped
 * resources require authentication). Thrown by the `requireAuth` preHandler when
 * no authenticated identity can be resolved for the request.
 */
export class UnauthorizedError extends Error {
  readonly statusCode = 401 as const;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** The JSON body shape returned for any handled error. */
export interface ErrorResponse {
  error: { code: string; message: string; field?: string };
}
