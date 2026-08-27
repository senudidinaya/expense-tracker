import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { isUniqueViolation } from "../lib/pg-errors.js";
import { insertDemoDataset } from "../seed/insert-demo-dataset.js";
import { insertDefaultCategories } from "./categories.js";
import { sessionsRepo } from "./sessions.js";

/**
 * Everything a caller outside this file may know about a user. `passwordHash` is
 * absent by construction: every query below selects columns explicitly, so the
 * hash cannot reach a route, a log line or a response by accident.
 */
export interface UserRecord {
  id: string;
  email: string;
  isDemo: boolean;
  createdAt: Date;
}

/** The columns that make up a `UserRecord`, for reuse across the queries here. */
const userColumns = {
  id: users.id,
  email: users.email,
  isDemo: users.isDemo,
  createdAt: users.createdAt,
} as const;

export type CreateUserResult =
  { ok: true; user: UserRecord } | { ok: false; reason: "email_taken" };

/**
 * design/api.md: at most 100 live `is_demo` users. Combined with the 5/min/IP
 * limit on the route, this is what bounds worst-case demo data volume.
 */
export const DEMO_USER_CAP = 100;

export type ProvisionDemoResult =
  | { ok: true; user: UserRecord; token: string }
  | { ok: false; reason: "at_capacity" };

/**
 * The name `users.email`'s UNIQUE carries in `drizzle/0000_init.sql`.
 *
 * Matching the constraint by name and not merely the SQLSTATE matters here: the
 * insert runs in a transaction that also seeds the default categories, and those
 * have a unique index of their own that would raise the same 23505.
 */
const EMAIL_UNIQUE_CONSTRAINT = "users_email_unique";

const isEmailTaken = (err: unknown): boolean =>
  isUniqueViolation(err, EMAIL_UNIQUE_CONSTRAINT);

export const usersRepo = {
  /**
   * Creates the user and its default categories in one transaction, so a signup
   * that fails at either step leaves nothing behind.
   *
   * Returns a result rather than throwing on a taken address: which Postgres
   * SQLSTATE means "email taken" is knowledge that belongs in this layer, and the
   * route's job is to turn `email_taken` into a 409.
   */
  async create(
    db: Db,
    {
      email,
      password,
      isDemo = false,
    }: { email: string; password: string; isDemo?: boolean },
  ): Promise<CreateUserResult> {
    const passwordHash = await hashPassword(password);

    try {
      const user = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ id: newId(), email, passwordHash, isDemo })
          .returning(userColumns);
        // A single-row insert with RETURNING always yields one row; this is for
        // the type, not for a case that can occur.
        if (!row) throw new Error("user insert returned no row");

        await insertDefaultCategories(tx, row.id);
        return row;
      });

      return { ok: true, user };
    } catch (err) {
      if (isEmailTaken(err)) return { ok: false, reason: "email_taken" };
      throw err;
    }
  },

  /**
   * Provisions a whole demo visitor: user, default categories, six months of
   * seeded data, and the session — in one transaction, or not at all.
   *
   * ## Why one transaction and not five
   *
   * Every partial outcome here is worse than an error. A user with no expenses
   * is a visitor staring at an empty app with no way to ask for another
   * sandbox (the route mints a *new* user each call, so retrying leaves the
   * empty one behind, counting against the cap until the nightly reap). A user
   * with expenses but no budgets is a demo that silently misrepresents the
   * product. A session issued before the data lands is a cookie for an account
   * that may never finish existing. There is no partial state worth keeping,
   * so there is no reason to let one exist.
   *
   * ## Why the capacity check races, and why that is the right trade
   *
   * `count(*) WHERE is_demo` followed by an insert is not atomic and cannot be
   * made atomic by ordering. Under READ COMMITTED a concurrent transaction's
   * uncommitted user row is invisible to this count, and there is no existing
   * row to lock — `SELECT ... FOR UPDATE` cannot lock a row that does not
   * exist yet. N requests arriving at 99 all count 99, all pass, all commit:
   * 99 + N. The window is the whole of provisioning too — hundreds of inserts,
   * hundreds of milliseconds — so this is a race that happens, not one that
   * merely could.
   *
   * The exact fixes are `pg_advisory_xact_lock` on a fixed key (which holds
   * until commit, serializing every demo provisioning in the fleet behind the
   * slowest seed) or SERIALIZABLE with a retry loop (around a transaction that
   * has already paid for an argon2 hash). Neither is worth it, because **the
   * cap is a resource ceiling, not an invariant**: nothing in the system reads
   * this count but this line, no data is wrong at 103 live demo users, the
   * 5/min/IP limit bounds the burst, and the nightly reap empties the table
   * within a day. A bounded overshoot is the cheapest correct answer.
   */
  async provisionDemo(
    db: Db,
    { today }: { today: string },
  ): Promise<ProvisionDemoResult> {
    const id = newId();

    // Outside the transaction: argon2 is ~100ms of CPU and needs no connection,
    // and holding one open across it would be a hundred milliseconds of pool
    // pressure per demo for nothing.
    //
    // The password is random and thrown away unread, so no client can ever
    // present it. The column is still a real argon2id digest rather than a
    // marker string, which is what keeps `verifyCredentials` on a guessed
    // demo address indistinguishable in cost from any other login.
    const passwordHash = await hashPassword(
      randomBytes(32).toString("base64url"),
    );

    return db.transaction(async (tx) => {
      const [live] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .where(eq(users.isDemo, true));
      if ((live?.n ?? 0) >= DEMO_USER_CAP) {
        // Returning rather than throwing: an empty transaction commits, which
        // is the correct amount of work for a request that is being refused.
        return { ok: false, reason: "at_capacity" };
      }

      const [user] = await tx
        .insert(users)
        // The address embeds the user's own id, which is already public in the
        // response body. `.invalid` is reserved by RFC 2606 and can never
        // resolve, so a demo account cannot receive mail even by accident.
        .values({
          id,
          email: `demo-${id}@demo.invalid`,
          passwordHash,
          isDemo: true,
        })
        .returning(userColumns);
      if (!user) throw new Error("demo user insert returned no row");

      const seeded = await insertDefaultCategories(tx, user.id);

      // Seeded from the user's id: one visitor always gets one dataset, two
      // visitors on the same day get different amounts. See seed/demo-data.ts.
      await insertDemoDataset(tx, {
        userId: user.id,
        today,
        seed: user.id,
        categoryIds: new Map(seeded.map((c) => [c.name, c.id])),
      });

      const token = await sessionsRepo.create(tx, user.id);
      return { ok: true, user, token };
    });
  },

  async findById(db: Db, id: string): Promise<UserRecord | null> {
    const [row] = await db
      .select(userColumns)
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  },

  /**
   * The only function that reads `password_hash`, and it does not return it —
   * that is what keeps the hash inside the repository layer instead of handing a
   * route something it must remember not to serialize.
   *
   * `users.email` is `citext`, so the comparison is case-insensitive in the index
   * itself; no `lower()` here, which would also cost the index.
   */
  async verifyCredentials(
    db: Db,
    { email, password }: { email: string; password: string },
  ): Promise<UserRecord | null> {
    const [row] = await db
      .select({ ...userColumns, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    // No such address: verify against a throwaway digest anyway. Returning early
    // would answer an unknown email in about a millisecond and a wrong password
    // in about a hundred, which is an account-existence oracle any client can
    // read off the clock.
    const digest = row?.passwordHash ?? (await dummyPasswordHash());
    const matches = await verifyPassword(digest, password);
    if (!row || !matches) return null;

    const { passwordHash: _hash, ...user } = row;
    return user;
  },
};
