import { z } from "zod";
import { timestamp, uuid } from "./common.js";

/** CHECK (char_length(name) BETWEEN 1 AND 50). */
const categoryName = z.string().min(1).max(50);

export const createCategoryBody = z.object({
  name: categoryName,
});

/**
 * Rename, archive (`archived: true`) or unarchive (`false`). Not
 * `createCategoryBody.partial()` — `archived` is a command, not a column, and
 * the server maps it onto `archived_at`.
 */
export const patchCategoryBody = z.object({
  name: categoryName.optional(),
  archived: z.boolean().optional(),
});

export const categoryDto = z.object({
  id: uuid,
  name: z.string(),
  archivedAt: timestamp.nullable(),
  createdAt: timestamp,
});

export const categoriesResponse = z.object({
  items: z.array(categoryDto),
});

export type CreateCategoryBody = z.infer<typeof createCategoryBody>;
export type PatchCategoryBody = z.infer<typeof patchCategoryBody>;
export type Category = z.infer<typeof categoryDto>;
export type CategoriesResponse = z.infer<typeof categoriesResponse>;
