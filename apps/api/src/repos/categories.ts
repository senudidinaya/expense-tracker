import type { DbOrTx } from "../db/client.js";
import { categories } from "../db/schema.js";
import { newId } from "../lib/ids.js";

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

/** Full CRUD arrives in Task 8; signup only needs the seed insert. */
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
