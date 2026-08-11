import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Notice } from "postgres";
import * as schema from "./schema.js";

export function createDb(
  url: string,
  /**
   * Opt-in NOTICE handler, same contract as runMigrations: unset means
   * postgres.js logs notices, which is what we want outside tests.
   */
  opts: { onnotice?: (notice: Notice) => void } = {},
) {
  const sql = postgres(url, { onnotice: opts.onnotice });
  return { db: drizzle(sql, { schema }), sql };
}

export type Db = ReturnType<typeof createDb>["db"];
