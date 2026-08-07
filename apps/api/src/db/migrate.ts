import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";

export async function runMigrations(
  url: string,
  opts: { migrationsSchema?: string } = {},
) {
  const sql = postgres(url, { max: 1 });
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    migrationsTable: "__drizzle_migrations",
    // Tests override this per suite (Task 3) so each suite's journal lives
    // inside its own schema; prod/dev use the default.
    migrationsSchema: opts.migrationsSchema ?? "drizzle",
  });
  await sql.end();
}
