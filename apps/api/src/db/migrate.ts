import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Notice } from "postgres";
import { fileURLToPath } from "node:url";

/**
 * Serializes migrators against one database. Arbitrary but stable — every
 * migrator of this database must use the same number, and it must stay above
 * 2^31 so Postgres resolves the bigint overload of pg_advisory_lock rather
 * than the two-int one.
 */
const MIGRATION_LOCK_KEY = 8_654_321_098_765;

export async function runMigrations(
  url: string,
  opts: {
    migrationsSchema?: string;
    /**
     * Opt-in NOTICE handler. Left unset in prod/dev on purpose: postgres.js
     * then falls back to logging notices, and a notice raised while migrating
     * production is something we want to see. Tests pass a no-op — see
     * test/helpers.ts for which notices are expected there.
     */
    onnotice?: (notice: Notice) => void;
  } = {},
) {
  // An explicit `undefined` here behaves exactly like omitting the key:
  // postgres.js branches on truthiness and falls back to console.log.
  // `max: 1` is load-bearing: the advisory lock below is session-scoped, so it
  // must be taken on the same connection the migration then runs on.
  const sql = postgres(url, { max: 1, onnotice: opts.onnotice });
  try {
    // Migrations are not safe to run concurrently against one database, even
    // though each statement looks idempotent. `CREATE EXTENSION IF NOT EXISTS`
    // is check-then-act, and drizzle wraps the whole migration in a single
    // transaction, so a second migrator can pass the check while the first
    // still holds its uncommitted pg_extension row and then die on the unique
    // index. Two callers race here for real: parallel test suites sharing the
    // CI database, and two app instances booting against a fresh database
    // (src/index.ts migrates before listening).
    await sql.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    await migrate(drizzle(sql), {
      migrationsFolder: fileURLToPath(
        new URL("../../drizzle", import.meta.url),
      ),
      migrationsTable: "__drizzle_migrations",
      // Tests override this per suite (Task 3) so each suite's journal lives
      // inside its own schema; prod/dev use the default.
      migrationsSchema: opts.migrationsSchema ?? "drizzle",
    });
  } finally {
    // Ending the session releases the advisory lock, including when migrate
    // threw — no explicit unlock needed, and none that could itself fail.
    await sql.end();
  }
}
