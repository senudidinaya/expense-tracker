import type { z } from "zod";

/**
 * The complete, stable set of error codes. Clients switch on these, so the
 * union is a public API surface: adding a code is a feature, changing the
 * meaning of one is a breaking change.
 *
 * `forbidden` is deliberately narrow — it means a CSRF origin mismatch and
 * nothing else. A resource belonging to another user answers `not_found`,
 * because 403 would confirm that the id exists.
 */
export const ERROR_CODES = [
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "demo_unavailable",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The only thing `details` ever carries: a field path and a human-readable
 * message, both derived from a zod issue. Never a stack trace, never SQL text,
 * never an internal identifier.
 */
export interface ErrorDetail {
  /** Dot-joined path to the offending field; `""` for a root-level issue. */
  path: string;
  message: string;
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
  };
}

/**
 * Every non-2xx response body in the API. The key is omitted rather than set to
 * `undefined` when there are no details, so the JSON carries no empty field.
 */
export const errorEnvelope = (
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
): ErrorEnvelope => ({
  error: { code, message, ...(details !== undefined ? { details } : {}) },
});

/**
 * Flattens a `ZodError` into the envelope's `details`. Nested and array paths
 * render dotted (`items.0.id`) so a client can address the field that failed.
 *
 * Only `path` and `message` survive: a zod issue also carries the received
 * value, and echoing that back would put a rejected password in a response body.
 */
export const zodErrorToDetails = (error: z.ZodError): ErrorDetail[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
