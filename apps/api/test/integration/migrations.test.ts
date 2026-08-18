import { it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import {
  startTestDb,
  silenceNotices,
  withDatabase,
  withSearchPath,
} from "../helpers";
import { runMigrations } from "../../src/db/migrate";
import postgres from "postgres";

let url: string,
  base: string,
  schema: string,
  stop: (() => Promise<unknown>) | undefined;
beforeAll(
  async () => ({ url, base, schema, stop } = await startTestDb()),
  120_000,
);
// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

it("applies all migrations and creates the six tables + citext", async () => {
  await runMigrations(url, {
    migrationsSchema: schema,
    onnotice: silenceNotices,
  });
  const sql = postgres(url, { onnotice: silenceNotices });
  // current_schema() (not 'public') so this test keeps working after Task 3
  // switches helpers.ts to schema-per-suite isolation.
  const tables =
    await sql`select table_name from information_schema.tables where table_schema = current_schema()`;
  const names = tables.map((t) => t.table_name);
  for (const t of [
    "users",
    "sessions",
    "categories",
    "expenses",
    "budgets",
    "recurring_rules",
  ])
    expect(names).toContain(t);
  const ext = await sql`select extname from pg_extension`;
  expect(ext.map((e) => e.extname)).toContain("citext");
  await sql.end();
});

it("migrates a pristine database concurrently without colliding", async () => {
  // Regression, and the reason runMigrations takes an advisory lock.
  //
  // `CREATE EXTENSION IF NOT EXISTS` is check-then-act: it reads pg_extension,
  // then inserts. Drizzle runs every migration statement inside one
  // transaction, so a second migrator starting before the first commits sees
  // no citext (the first's row is still uncommitted), attempts its own insert,
  // blocks on pg_extension's unique index, and fails 23505 the moment the
  // first commits. The window is the whole migration, not an instant.
  //
  // That is exactly the CI shape: TESTCONTAINERS_DISABLED=1 points every suite
  // at one database and vitest runs suite files in parallel. A pristine
  // database is required to reproduce it — once citext exists, every migrator
  // short-circuits at the check and the collision can no longer happen.
  const admin = postgres(base, { onnotice: silenceNotices });
  const fresh = `pristine_${randomBytes(6).toString("hex")}`;
  await admin.unsafe(`create database "${fresh}"`);
  try {
    const freshUrl = withDatabase(base, fresh);
    const target = postgres(freshUrl, { onnotice: silenceNotices });
    await target.unsafe(`create schema "s1"`);
    await target.unsafe(`create schema "s2"`);
    await target.end();

    await expect(
      Promise.all(
        ["s1", "s2"].map((s) =>
          runMigrations(withSearchPath(freshUrl, s), {
            migrationsSchema: s,
            onnotice: silenceNotices,
          }),
        ),
      ),
    ).resolves.toHaveLength(2);
  } finally {
    await admin.unsafe(`drop database "${fresh}" with (force)`);
    await admin.end();
  }
}, 120_000);
