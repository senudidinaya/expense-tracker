import { and, asc, eq, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client.js";
import { categories } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { isUniqueViolation } from "../lib/pg-errors.js";

/**
 * design/api.md fixes this seed set. An account that lands on an empty category
 * list cannot record an expense at all, so seeding is part of "the user exists",
 * not a follow-up write — hence `DbOrTx`, so signup can run it inside the same
 * transaction as the user insert.
 */
export const DEFAULT_CATEGORY_NAMES = [
  "Food",
  "Transport",
  "Rent",
  "Utilities",
  "Health",
  "Entertainment",
  "Shopping",
  "Other",
] as const;

export async function insertDefaultCategories(
  tx: DbOrTx,
  userId: string,
): Promise<void> {
  await tx
    .insert(categories)
    .values(
      DEFAULT_CATEGORY_NAMES.map((name) => ({ id: newId(), userId, name })),
    );
}

/** Everything a caller outside this file may know about a category. */
export interface CategoryRecord {
  id: string;
  name: string;
  archivedAt: Date | null;
  createdAt: Date;
}

/**
 * The columns that make up a `CategoryRecord`. Selecting explicitly rather than
 * `select()` is what keeps `user_id` out of every result — the scoping column is
 * an implementation detail of this layer, not part of the record.
 */
const categoryColumns = {
  id: categories.id,
  name: categories.name,
  archivedAt: categories.archivedAt,
  createdAt: categories.createdAt,
} as const;

export type CategoryResult =
  | { ok: true; category: CategoryRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "name_taken" };

/** The partial unique index from design/schema.md: (user_id, lower(name)) where archived_at is null. */
const ACTIVE_NAME_UNIQUE = "categories_user_name_active_uq";

/** What a PATCH may change. `archived` is a command, not a column. */
export interface CategoryChanges {
  name?: string;
  archived?: boolean;
}

/**
 * Every method takes `userId` and puts it in the WHERE. That is the whole of
 * ownership enforcement in this app — `user_id` is denormalized onto the table
 * precisely so no join is needed to do it — and a query here that reads or
 * writes without it serves one user's data to another.
 */
export const categoriesRepo = {
  /**
   * Active and archived alike: design/api.md keeps archived categories
   * selectable in filters and reports, so the caller filters on `archivedAt`
   * rather than the query hiding rows.
   */
  async listAll(db: Db, userId: string): Promise<CategoryRecord[]> {
    return (
      db
        .select(categoryColumns)
        .from(categories)
        .where(eq(categories.userId, userId))
        // Case-insensitive, matching the index the uniqueness rule uses, so the
        // order a client sees agrees with the order names collide in.
        .orderBy(asc(sql`lower(${categories.name})`), asc(categories.id))
    );
  },

  async findById(
    db: Db,
    userId: string,
    id: string,
  ): Promise<CategoryRecord | null> {
    const [row] = await db
      .select(categoryColumns)
      .from(categories)
      .where(and(eq(categories.userId, userId), eq(categories.id, id)))
      .limit(1);
    return row ?? null;
  },

  /**
   * Returns a result rather than throwing on a taken name: which Postgres
   * SQLSTATE and constraint mean "that name is in use" is knowledge that belongs
   * in this layer, and the route's job is to turn `name_taken` into a 409.
   */
  async create(db: Db, userId: string, name: string): Promise<CategoryResult> {
    try {
      const [row] = await db
        .insert(categories)
        .values({ id: newId(), userId, name })
        .returning(categoryColumns);
      // A single-row insert with RETURNING always yields one row; this is for
      // the type, not for a case that can occur.
      if (!row) throw new Error("category insert returned no row");
      return { ok: true, category: row };
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_NAME_UNIQUE)) {
        return { ok: false, reason: "name_taken" };
      }
      throw err;
    }
  },

  /**
   * Rename and archive/unarchive in one UPDATE. One statement rather than two so
   * a request carrying both cannot half-apply — a rename that lands while the
   * archive is rejected would leave a state the client never asked for.
   *
   * Archiving is always allowed; the partial unique index only covers active
   * rows, so leaving is free and coming back is what can collide.
   */
  async patch(
    db: Db,
    userId: string,
    id: string,
    changes: CategoryChanges,
  ): Promise<CategoryResult> {
    const set: { name?: string; archivedAt?: Date | null } = {};
    if (changes.name !== undefined) set.name = changes.name;
    if (changes.archived !== undefined) {
      set.archivedAt = changes.archived ? new Date() : null;
    }

    // An empty PATCH is valid input (every field is optional) and must still
    // answer 404 for someone else's id, so it reads instead of updating nothing.
    if (Object.keys(set).length === 0) {
      const current = await categoriesRepo.findById(db, userId, id);
      return current
        ? { ok: true, category: current }
        : { ok: false, reason: "not_found" };
    }

    try {
      const [row] = await db
        .update(categories)
        .set(set)
        .where(and(eq(categories.userId, userId), eq(categories.id, id)))
        .returning(categoryColumns);
      return row
        ? { ok: true, category: row }
        : { ok: false, reason: "not_found" };
    } catch (err) {
      if (isUniqueViolation(err, ACTIVE_NAME_UNIQUE)) {
        return { ok: false, reason: "name_taken" };
      }
      throw err;
    }
  },
};
