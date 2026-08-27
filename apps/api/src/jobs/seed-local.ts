/**
 * `pnpm seed` — a local dev account with six months of data behind it.
 *
 * A development convenience and nothing else: it is never built into the
 * image's start-up path, never run by CI, and never run against a deployed
 * database. What it produces is the same dataset the demo button produces
 * (seed/demo-data.ts), attached to an account you can actually log into, so
 * the dashboard, the reports and the budget bars all have something to draw
 * from the moment `pnpm dev` comes up.
 *
 * ## Re-runnable, by replacing rather than adding
 *
 * The script deletes the dev user first and rebuilds it. Appending a second
 * six-month window over the first would double every month's totals and make
 * the reports meaningless, and skipping when the user exists would make
 * `pnpm seed` useless the second time you need fresh data. The delete is
 * scoped to this one address, and the cascade takes the account's own rows —
 * no other account is touched.
 *
 * ## Why the seed is the address, not the new user's id
 *
 * Demo provisioning seeds its PRNG from the visitor's id, so two visitors get
 * different numbers. Here the opposite is wanted: re-seeding should give the
 * same dataset it gave last time, so a screenshot taken yesterday still
 * matches what is on screen today. The address is the one thing about the dev
 * user that does not change between runs.
 */

import { eq } from "drizzle-orm";
import pino from "pino";
import { createDb } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { users } from "../db/schema.js";
import { todayUtc } from "../lib/dates.js";
import { hashPassword } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { insertDefaultCategories } from "../repos/categories.js";
import { insertDemoDataset } from "../seed/insert-demo-dataset.js";

const log = pino({ name: "seed-local" });

const DEV_EMAIL = "dev@local.test";
/** Fixed and published — this account only ever exists on a developer's box. */
const DEV_PASSWORD = "devpassword1";

/**
 * docker-compose.yml's database, so `docker compose up -d && pnpm seed` works
 * with nothing else set. Only this script defaults: the API validates
 * `DATABASE_URL` at boot and the nightly job refuses to run without one,
 * because guessing a connection string is a local-tooling affordance, not a
 * behaviour worth having in something that runs unattended.
 */
const LOCAL_DATABASE_URL = "postgres://expense:expense@localhost:5432/expense";

const url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;

// Same fail-closed order as src/index.ts: a seed against a half-migrated
// database is a confusing pile of constraint errors rather than an error.
await runMigrations(url);

const { db, sql } = createDb(url);

try {
  // The hash is ~100ms of CPU and needs no connection — outside the
  // transaction, as in `usersRepo.provisionDemo`.
  const passwordHash = await hashPassword(DEV_PASSWORD);
  const today = todayUtc();

  const userId = await db.transaction(async (tx) => {
    const replaced = await tx
      .delete(users)
      .where(eq(users.email, DEV_EMAIL))
      .returning({ id: users.id });
    if (replaced.length > 0) {
      log.info({ email: DEV_EMAIL }, "replacing the existing dev user");
    }

    const id = newId();
    await tx
      .insert(users)
      // Not `is_demo`: the nightly reap deletes demo users after 24h, and a dev
      // account that disappeared overnight would be a bug report every morning.
      .values({ id, email: DEV_EMAIL, passwordHash, isDemo: false });

    const seeded = await insertDefaultCategories(tx, id);
    await insertDemoDataset(tx, {
      userId: id,
      today,
      seed: DEV_EMAIL,
      categoryIds: new Map(seeded.map((c) => [c.name, c.id])),
    });

    return id;
  });

  log.info(
    { userId, email: DEV_EMAIL, password: DEV_PASSWORD },
    "seeded the local dev user",
  );
} finally {
  await sql.end();
}
