import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
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
