import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import postgres from "postgres";
import { expect } from "vitest";
import { randomBytes } from "node:crypto";
import { buildApp, type App } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Env } from "../src/env.js";

/**
 * Postgres raises NOTICEs that are expected under the schema-per-suite model
 * and only bury real test output. postgres.js console.logs the whole parsed
 * notice object unless `onnotice` is set, so every test client sets this.
 *
 * The two we provoke on purpose:
 *  - `schema "test_xxx" already exists, skipping` — drizzle's migrator opens
 *    with `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>`, and we point it at
 *    the schema startTestDb created moments earlier. Not a name collision.
 *  - `extension "citext" already exists, skipping` — 0000_init.sql re-runs
 *    `CREATE EXTENSION IF NOT EXISTS citext`, which repeats on every suite
 *    when TESTCONTAINERS_DISABLED=1 makes them share one database.
 */
export const silenceNotices = () => {};

/** Same base server, a different database. */
export function withDatabase(base: string, database: string) {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

/**
 * search_path = suite schema first, then public — unqualified DDL/DML lands in
 * the suite schema while the citext type (installed WITH SCHEMA public, Task 2)
 * still resolves.
 */
export function withSearchPath(base: string, schema: string) {
  return `${base}?options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
}

export async function startTestDb() {
  const schema = `test_${randomBytes(6).toString("hex")}`;
  let base: string;
  let stopContainer = async () => {};
  if (process.env.TESTCONTAINERS_DISABLED === "1") {
    base = process.env.DATABASE_URL!; // CI service container
  } else {
    const c = await new PostgreSqlContainer("postgres:16").start();
    base = c.getConnectionUri();
    stopContainer = async () => {
      await c.stop();
    };
  }
  const admin = postgres(base, { onnotice: silenceNotices });
  await admin.unsafe(`create schema "${schema}"`);
  await admin.end();
  const url = withSearchPath(base, schema);
  return {
    url,
    base,
    schema,
    stop: async () => {
      const s = postgres(base, { onnotice: silenceNotices });
      await s.unsafe(`drop schema "${schema}" cascade`);
      await s.end();
      await stopContainer();
    },
  };
}

/** Env for tests: real shape, no secrets, http origin (so no HSTS, no Secure). */
export const testEnv = (overrides: Partial<Env> = {}): Env => ({
  DATABASE_URL: "postgres://unused/unused",
  SESSION_SECRET: "test-session-secret-at-least-32-chars",
  APP_ORIGIN: "http://localhost:5173",
  PORT: 3000,
  APP_VERSION: "test",
  ...overrides,
});

/**
 * A migrated database plus an app wired to it. The returned app is not yet
 * `ready()`, so a suite can register probe routes before injecting.
 */
export async function makeTestApp() {
  const { url, schema, stop: stopDb } = await startTestDb();
  // migrationsSchema pins the journal inside this suite's schema — without it
  // parallel suites share `drizzle.__drizzle_migrations` and collide.
  await runMigrations(url, {
    migrationsSchema: schema,
    onnotice: silenceNotices,
  });
  const { db, sql } = createDb(url, { onnotice: silenceNotices });
  const app = await buildApp({
    db,
    env: testEnv({ DATABASE_URL: url }),
    logger: false,
  });
  return {
    app,
    db,
    stop: async () => {
      await app.close();
      await sql.end();
      await stopDb();
    },
  };
}

// ---------------------------------------------------------------------------
// Signed-in request helpers
// ---------------------------------------------------------------------------

export interface TestUser {
  email: string;
  password: string;
  /** The raw session cookie value. */
  token: string;
  userId: string;
}

/**
 * A distinct client address per request. The global rate limit is 300/min per
 * IP (Task 7) and a CRUD suite makes more calls than that — but what those
 * suites test is ownership and CRUD, not the limiter, so every request gets its
 * own bucket. The limits themselves are tested in `security.test.ts`.
 *
 * With no `X-Forwarded-For` header, `trustProxy: 1` resolves `req.ip` — the
 * limiter's key — to exactly this socket address.
 */
let clients = 0;
export const nextClientAddress = (): string => {
  clients += 1;
  return `10.${Math.floor(clients / 62_500) % 250}.${Math.floor(clients / 250) % 250}.${(clients % 250) + 1}`;
};

/** The `session` cookie value from a response, or a failure that names what happened. */
function sessionCookieValue(headers: Record<string, unknown>): string {
  const raw = headers["set-cookie"];
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const header = all.map(String).find((h) => h.startsWith("session="));
  if (header === undefined) throw new Error("response set no `session` cookie");
  const pair = header.split(";")[0] ?? "";
  return decodeURIComponent(pair.slice("session=".length));
}

/** Signs up a throwaway account and hands back its credentials and cookie. */
export async function signupUser(app: App, label: string): Promise<TestUser> {
  const email = `${label}@example.com`;
  const password = `pw-${label}-8charsmin`;
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password },
    remoteAddress: nextClientAddress(),
  });
  if (r.statusCode !== 201) {
    throw new Error(`signup for "${label}" failed: ${r.statusCode} ${r.body}`);
  }
  return {
    email,
    password,
    token: sessionCookieValue(r.headers),
    userId: r.json().user.id as string,
  };
}

/**
 * A request maker bound to one user's session cookie, so an isolation test reads
 * as `asB.patch(...)` — the user making the call is part of the sentence rather
 * than a cookie assembled at each call site.
 */
export function asUser(app: App, user: TestUser) {
  const send = (
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: InjectOptions["payload"],
  ): Promise<LightMyRequestResponse> => {
    // Built as a value rather than spread inline: `inject` is overloaded, and a
    // conditional spread makes TypeScript resolve the chainable-builder overload
    // instead of the promise-returning one.
    const options: InjectOptions = {
      method,
      url,
      cookies: { session: user.token },
      remoteAddress: nextClientAddress(),
    };
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };

  return {
    user,
    get: (url: string) => send("GET", url),
    post: (url: string, payload: InjectOptions["payload"]) =>
      send("POST", url, payload),
    patch: (url: string, payload: InjectOptions["payload"]) =>
      send("PATCH", url, payload),
    put: (url: string, payload: InjectOptions["payload"]) =>
      send("PUT", url, payload),
    delete: (url: string) => send("DELETE", url),
  };
}

// ---------------------------------------------------------------------------
// Date-order assertions
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` sorts lexicographically, which is what makes comparing dates as
 * strings sound — but vitest's numeric matchers reject them outright
 * ("actual value must be number or bigint, received string"), so
 * `expect(date).toBeGreaterThan(today)` is a TypeError and not a comparison.
 * A bare `expect(a <= b).toBe(true)` compares correctly but reports only
 * "expected false to be true"; these two put both dates in the message.
 */
export const expectOnOrBefore = (earlier: string, later: string): void => {
  expect(earlier <= later ? "ordered" : `${earlier} is after ${later}`).toBe(
    "ordered",
  );
};

export const expectStrictlyBefore = (earlier: string, later: string): void => {
  expect(
    earlier < later ? "ordered" : `${earlier} is not before ${later}`,
  ).toBe("ordered");
};
