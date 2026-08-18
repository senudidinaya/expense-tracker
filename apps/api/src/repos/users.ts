import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import {
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
} from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { insertDefaultCategories } from "./categories.js";

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

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** The name `users.email`'s UNIQUE carries in `drizzle/0000_init.sql`. */
const EMAIL_UNIQUE_CONSTRAINT = "users_email_unique";

/**
 * Drizzle wraps every driver failure in a `DrizzleQueryError` and hangs the
 * `PostgresError` off `cause`, so the SQLSTATE is never on the error we catch —
 * hence the walk rather than a direct property read.
 *
 * The constraint name is part of the match, not just the SQLSTATE: any unique
 * index added to this transaction later would also raise 23505, and answering
 * that with "email taken" would be a wrong answer the client cannot see through.
 *
 * A pre-check would not remove the need for this: two concurrent signups for one
 * address both pass the check and one of them still has to lose at the index.
 */
const isEmailTaken = (err: unknown): boolean => {
  // Bounded: the chain is one hop deep today, and a cap means a self-referential
  // `cause` can never turn this into a hang.
  let cursor: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) return false;
    const pgErr = cursor as { code?: unknown; constraint_name?: unknown };
    if (
      pgErr.code === UNIQUE_VIOLATION &&
      pgErr.constraint_name === EMAIL_UNIQUE_CONSTRAINT
    ) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
};

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
