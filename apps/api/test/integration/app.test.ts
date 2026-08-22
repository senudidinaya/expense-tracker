import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "../../src/app.js";
import { createDb } from "../../src/db/client.js";
import { GLOBAL_RATE_LIMIT } from "../../src/plugins/security.js";
import { makeTestApp, testEnv } from "../helpers.js";

/** Appears only inside thrown/rejected values, never in anything we mean to send. */
const SENTINEL = "sentinel-4f21ab-must-not-leak";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ app, db, stop } = await makeTestApp());

  // Probe routes: Task 5 ships no /api routes yet, so the error paths need
  // something to exercise them.
  app.post(
    "/probe/validate",
    {
      schema: {
        body: z.object({
          password: z.string().min(8),
          nested: z.object({ n: z.number() }),
          token: z.string().max(8),
        }),
      },
    },
    async () => ({ ok: true }),
  );
  app.get("/probe/boom", async () => {
    throw new Error(`connect failed for user=admin: ${SENTINEL}`);
  });

  await app.ready();
}, 120_000);

// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

describe("GET /health", () => {
  it("returns 200 with status and version", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "ok", version: "test" });
  });
});

describe("error envelope", () => {
  it("unknown route -> 404 not_found envelope, no details", async () => {
    const r = await app.inject({ method: "GET", url: "/api/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toEqual({ code: "not_found", message: "Not found" });
  });

  it("validation failure -> 400 envelope whose details carry only path and message", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/probe/validate",
      payload: { password: "short", nested: { n: "x" }, token: SENTINEL },
    });

    expect(r.statusCode).toBe(400);
    const { error } = r.json();
    expect(error.code).toBe("validation_failed");

    // Dotted paths, one entry per zod issue.
    expect(error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      "nested.n",
      "password",
      "token",
    ]);
    for (const detail of error.details) {
      expect(Object.keys(detail).sort()).toEqual(["message", "path"]);
      expect(typeof detail.message).toBe("string");
    }

    // Nothing from fastify's internal validation shape survives, and the
    // rejected value itself is never echoed back.
    expect(r.body).not.toContain(SENTINEL);
    for (const leak of ["instancePath", "schemaPath", "keyword", "params"]) {
      expect(r.body).not.toContain(leak);
    }
  });

  it("thrown error -> 500 internal envelope that leaks nothing, stack goes to the log", async () => {
    // Its own app so the log output can be captured; the shared app logs nowhere.
    const logLines: string[] = [];
    const quiet = await buildApp({
      db,
      env: testEnv(),
      logger: {
        level: "error",
        stream: {
          write: (line: string) => {
            logLines.push(line);
          },
        },
      },
    });
    quiet.get("/probe/boom", async () => {
      throw new Error(`connect failed for user=admin: ${SENTINEL}`);
    });
    await quiet.ready();

    const r = await quiet.inject({ method: "GET", url: "/probe/boom" });

    expect(r.statusCode).toBe(500);
    expect(r.json().error).toEqual({
      code: "internal",
      message: "Internal error",
    });
    expect(r.json().error.details).toBeUndefined();
    expect(r.body).not.toContain(SENTINEL);
    expect(r.body).not.toContain("Error");

    // The information is not lost — it is in the log, where it belongs.
    expect(logLines.join("")).toContain(SENTINEL);

    await quiet.close();
  }, 30_000);

  it("body over the 32 KB limit -> 400 envelope, payload not echoed", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/probe/validate",
      payload: { padding: SENTINEL.repeat(2000) },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
    expect(r.body).not.toContain(SENTINEL);
  });
});

describe("security baseline", () => {
  it("sets a self-only CSP and the standard helmet headers", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    const csp = r.headers["content-security-policy"] as string;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("http://");

    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["referrer-policy"]).toBeDefined();
  });

  it("omits HSTS on an http origin and sets it on an https one", async () => {
    const http = await app.inject({ method: "GET", url: "/health" });
    expect(http.headers["strict-transport-security"]).toBeUndefined();

    const secure = await buildApp({
      db,
      env: testEnv({ APP_ORIGIN: "https://expenses.example.com" }),
      logger: false,
    });
    const r = await secure.inject({ method: "GET", url: "/health" });
    expect(r.headers["strict-transport-security"]).toContain("max-age=");
    await secure.close();
  });

  it("advertises the global rate limit", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["x-ratelimit-limit"]).toBe(String(GLOBAL_RATE_LIMIT));
    expect(GLOBAL_RATE_LIMIT).toBe(300);
  });
});

describe("request ids", () => {
  it("generates one and echoes it when the client sends none", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["x-request-id"]).toMatch(UUID_RE);
  });

  it("honors a well-formed x-request-id", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "req_abc-123.4" },
    });
    expect(r.headers["x-request-id"]).toBe("req_abc-123.4");
  });

  it("ignores a malformed x-request-id rather than echoing it", async () => {
    const hostile = "a".repeat(65) + " <script>";
    const r = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": hostile },
    });
    expect(r.headers["x-request-id"]).toMatch(UUID_RE);
  });
});

describe("GET /health with an unreachable database", () => {
  it("returns 503 without leaking connection details", async () => {
    // Port 1 refuses immediately; the URL carries a password on purpose.
    const dead = createDb("postgres://someone:hunter2@127.0.0.1:1/nowhere");
    const app503 = await buildApp({
      db: dead.db,
      env: testEnv(),
      logger: false,
    });

    const r = await app503.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe("internal");
    for (const leak of ["hunter2", "someone", "127.0.0.1", "ECONNREFUSED"]) {
      expect(r.body).not.toContain(leak);
    }

    await app503.close();
    await dead.sql.end();
  });
});
