import { z } from "zod";
import {
  errorResponse,
  zodErrorToDetails,
  type ErrorCode,
  type ErrorDetail,
} from "@expense/shared";

/**
 * Fired on the window whenever the API answers `401`.
 *
 * The fetch layer knows nothing about routing: it reports that the session is
 * gone and stops there. `AuthContext` is the only listener, and it decides
 * whether that means "redirect this signed-in user to /login" or "the login
 * form just got a wrong password" — a distinction the transport cannot make.
 */
export const AUTH_EXPIRED_EVENT = "auth:expired";

/** Response schema for a route that answers `204 No Content`. */
export const noContent = z.undefined();

export interface ApiErrorInit {
  code: ErrorCode;
  message: string;
  status: number;
  details?: ErrorDetail[];
}

/**
 * A non-2xx response, carrying the envelope the server sent.
 *
 * `code` is the machine-readable half and the only part worth branching on;
 * `message` is written to be shown to a user as-is.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(init: ApiErrorInit) {
    super(init.message);
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
  }
}

/**
 * A 2xx response whose body does not match the schema the caller asked for —
 * the client and server contracts have drifted apart.
 *
 * This is the whole reason `apiFetch` takes a schema instead of casting: the
 * alternative is `undefined` surfacing three components deep, far from the
 * response that caused it. It extends `ApiError` so every existing error
 * banner keeps working (there is nothing a user can do about either), while
 * `instanceof ApiParseError` and `issues` keep it diagnosable in a log.
 *
 * The code is `internal` because that is what it is: our bug, not the user's
 * input. It is deliberately not a new member of the shared error union —
 * that union is the set of codes the *server* sends.
 */
export class ApiParseError extends ApiError {
  readonly issues: ErrorDetail[];

  constructor(status: number, issues: ErrorDetail[]) {
    super({
      code: "internal",
      message: "The server sent an unexpected response.",
      status,
    });
    this.name = "ApiParseError";
    this.issues = issues;
  }
}

/**
 * The single call site for `fetch` in this app.
 *
 * `path` is API-relative (`/auth/me`) — the `/api` prefix and the credentials
 * mode are applied here so no caller can forget either. In production the SPA
 * and the API are the same origin; in dev the Vite proxy makes them look that
 * way, which is what lets the session cookie ride along and what lets the
 * server's Origin check stay strict.
 */
export async function apiFetch<T>(
  schema: z.ZodType<T>,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: withJsonContentType(init),
  });

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw await toApiError(response);
  }

  const parsed = schema.safeParse(await readBody(response));
  if (!parsed.success) {
    throw new ApiParseError(response.status, zodErrorToDetails(parsed.error));
  }
  return parsed.data;
}

/**
 * Callers pass `body: JSON.stringify(...)`; declaring the content type every
 * time is boilerplate that only ever has one right answer. An explicit header
 * still wins, so a future form-data or CSV upload is not blocked by this.
 */
function withJsonContentType(init?: RequestInit): HeadersInit | undefined {
  if (init?.body === undefined || init.body === null) return init?.headers;
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return headers;
}

/**
 * Reads the body without assuming there is one, and without assuming it is
 * JSON. `204` and an empty body both become `undefined`; unparseable text is
 * handed back verbatim so the schema rejects it as a contract failure rather
 * than the client throwing a raw `SyntaxError` from somewhere inside `fetch`.
 */
async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const envelope = errorResponse.safeParse(await readBody(response));
  if (envelope.success) {
    const { code, message, details } = envelope.data.error;
    return new ApiError({ code, message, status: response.status, details });
  }

  // No envelope: a proxy, a load balancer or a crash answered instead of the
  // app. Synthesise one from the status so callers still only ever handle
  // `ApiError`, and say nothing about what actually came back.
  return new ApiError({
    code: fallbackCode(response.status),
    message: "Something went wrong. Please try again.",
    status: response.status,
  });
}

/**
 * Only the statuses whose meaning is unambiguous get a specific code — a
 * bodyless 401 is still a 401, and callers branching on `unauthorized` should
 * not be defeated by a gateway that stripped the payload.
 */
function fallbackCode(status: number): ErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "internal";
}
