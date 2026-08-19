import { z } from "zod";

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
 * The envelope as a zod schema, for the `response` map of every route that can
 * answer non-2xx.
 *
 * This is not merely a type annotation: fastify compiles a route's response
 * schema into its serializer, so a status declared here is filtered on the way
 * out — anything the handler puts on the object that is not `code`, `message` or
 * `details` never reaches the client. A status left undeclared is serialized
 * with `JSON.stringify` and whatever it carries goes out verbatim. That filter
 * is the reason to declare error statuses, not the types.
 *
 * `satisfies` rather than a type annotation: it proves the schema and
 * `ErrorEnvelope` cannot drift apart while leaving the concrete zod type intact
 * for the type provider to infer from.
 */
export const errorResponse = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
}) satisfies z.ZodType<ErrorEnvelope>;

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
