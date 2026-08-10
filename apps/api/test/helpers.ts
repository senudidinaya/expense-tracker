import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import type { Env } from "../src/env.js";

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
  const admin = postgres(base);
  await admin.unsafe(`create schema "${schema}"`);
  await admin.end();
  // search_path = suite schema first, then public — unqualified DDL/DML
  // lands in the suite schema while the citext type (installed WITH
  // SCHEMA public, Task 2) still resolves.
  const url = `${base}?options=${encodeURIComponent(`-c search_path=${schema},public`)}`;
  return {
    url,
    schema,
    stop: async () => {
      const s = postgres(base);
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
  await runMigrations(url, { migrationsSchema: schema });
  const { db, sql } = createDb(url);
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
