import postgres from "postgres";

/**
 * Installs citext once, before any suite runs.
 *
 * Only matters when TESTCONTAINERS_DISABLED=1 (the CI path), where every suite
 * shares one database and vitest runs suite files in parallel. citext is the
 * only thing 0000_init.sql writes to a database-global namespace — the suite
 * schema and the migration journal are both per-suite names — so pre-creating
 * it here moves that one write out of the parallel phase into the single phase
 * vitest guarantees is serial. Every suite's `CREATE EXTENSION IF NOT EXISTS`
 * then short-circuits at the existence check.
 *
 * runMigrations' advisory lock is what actually makes concurrent migration
 * correct; this keeps that lock uncontended in the common case. If a migration
 * ever adds a second extension, add it here too.
 *
 * The testcontainers path needs none of this: it starts a container per suite,
 * so suites share no database and have nothing to race over.
 */
export default async function setup() {
  if (process.env.TESTCONTAINERS_DISABLED !== "1") return;
  const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
  try {
    await sql.unsafe(
      "create extension if not exists citext with schema public",
    );
  } finally {
    await sql.end();
  }
}
