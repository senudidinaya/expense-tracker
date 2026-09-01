import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { errorEnvelope } from "@expense/shared";
import {
  ApiError,
  ApiParseError,
  AUTH_EXPIRED_EVENT,
  apiFetch,
  noContent,
} from "./client";

const userSchema = z.object({ id: z.string(), email: z.email() });

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The mocked `fetch`, typed so the assertions on its arguments type-check. */
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("parses a success body through the schema", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: "u1", email: "a@b.test" }),
    );

    await expect(apiFetch(userSchema, "/auth/me")).resolves.toEqual({
      id: "u1",
      email: "a@b.test",
    });
  });

  // The reason the client takes a schema at all. Without this, a server that
  // renames a field hands the app `undefined` and the failure surfaces three
  // components away from its cause.
  it("throws rather than returning a body that does not match the schema", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: "u1", emailAddress: "a@b.test" }),
    );

    const error = await apiFetch(userSchema, "/auth/me").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiParseError);
    expect((error as ApiParseError).issues).toContainEqual({
      path: "email",
      message: expect.any(String) as unknown as string,
    });
  });

  it("throws ApiError carrying the envelope's code on a 4xx", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, errorEnvelope("conflict", "Email already registered")),
    );

    const error = await apiFetch(userSchema, "/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.test", password: "hunter22" }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: "conflict",
      message: "Email already registered",
      status: 409,
    });
  });

  it("carries zod issue details through the envelope", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        400,
        errorEnvelope("validation_failed", "Invalid request", [
          { path: "password", message: "Too short" },
        ]),
      ),
    );

    const error = (await apiFetch(userSchema, "/auth/signup").catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error.details).toEqual([{ path: "password", message: "Too short" }]);
  });

  it("dispatches auth:expired exactly once on a 401", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, errorEnvelope("unauthorized", "Not signed in")),
    );
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);

    await expect(apiFetch(userSchema, "/auth/me")).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
  });

  it("does not dispatch auth:expired on any other status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(403, errorEnvelope("forbidden", "Origin mismatch")),
    );
    const listener = vi.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, listener);

    await expect(apiFetch(userSchema, "/expenses")).rejects.toBeInstanceOf(
      ApiError,
    );

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_EXPIRED_EVENT, listener);
  });

  it("sends credentials and prefixes the path with /api", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: "u1", email: "a@b.test" }),
    );

    await apiFetch(userSchema, "/auth/me");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/auth/me");
    expect(init?.credentials).toBe("include");
  });

  it("declares JSON only when there is a body to declare it for", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await apiFetch(noContent, "/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
    await apiFetch(noContent, "/auth/logout", { method: "POST" });

    const [withBody, withoutBody] = fetchMock.mock.calls;
    expect(new Headers(withBody?.[1]?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(new Headers(withoutBody?.[1]?.headers).get("content-type")).toBe(
      null,
    );
  });

  // A gateway or a crashed process answers with HTML, not the envelope. That
  // must still arrive as an ApiError, not as a SyntaxError from JSON.parse.
  it("synthesises an ApiError when the error body is not an envelope", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    );

    const error = (await apiFetch(userSchema, "/expenses").catch(
      (caught: unknown) => caught,
    )) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("internal");
    expect(error.status).toBe(502);
    expect(error.message).not.toContain("html");
  });

  it("treats a 204 as an empty body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      apiFetch(noContent, "/auth/logout", { method: "POST" }),
    ).resolves.toBeUndefined();
  });
});
