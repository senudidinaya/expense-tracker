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

/**
 * What a repository writes through: the pool itself, or a transaction opened on
 * it. Repos accept this so a caller can compose several of them into one
 * transaction — signup creates the user and seeds its categories atomically,
 * which is only possible if the categories repo will take the caller's `tx`.
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
