import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Notice } from "postgres";
import { fileURLToPath } from "node:url";

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
  const sql = postgres(url, { max: 1, onnotice: opts.onnotice });
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations",
    // Tests override this per suite (Task 3) so each suite's journal lives
    // inside its own schema; prod/dev use the default.
    migrationsSchema: opts.migrationsSchema ?? "drizzle",
  });
  await sql.end();
}
