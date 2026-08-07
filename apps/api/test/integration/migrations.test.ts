import { it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb } from "../helpers";
import { runMigrations } from "../../src/db/migrate";
import postgres from "postgres";

let url: string, stop: () => Promise<unknown>;
beforeAll(async () => ({ url, stop } = await startTestDb()), 120_000);
afterAll(() => stop());

it("applies all migrations and creates the six tables + citext", async () => {
  await runMigrations(url);
  const sql = postgres(url);
  // current_schema() (not 'public') so this test keeps working after Task 3
  // switches helpers.ts to schema-per-suite isolation.
  const tables = await sql`select table_name from information_schema.tables where table_schema = current_schema()`;
  const names = tables.map((t) => t.table_name);
  for (const t of ["users", "sessions", "categories", "expenses", "budgets", "recurring_rules"])
    expect(names).toContain(t);
  const ext = await sql`select extname from pg_extension`;
  expect(ext.map((e) => e.extname)).toContain("citext");
  await sql.end();
});
