import { isoDate, uuid } from "@expense/shared";
import { z } from "zod";

/**
 * The keyset cursor: a position in the expense list's `(date, id)` descending
 * sort. Not an offset — an offset is a count of rows, which changes whenever
 * rows are inserted or deleted ahead of it, so a paging client sees a row twice
 * or misses it entirely. A position does not move.
 *
 * It is base64url JSON: opaque enough that clients treat it as a token, and
 * plain enough that anyone can decode and edit it. That is deliberate and safe,
 * because a position is not an authorization — every repository query is scoped
 * to the session's `user_id` regardless of where the cursor points. Signing it
 * would protect nothing that is not already protected by the WHERE clause.
 *
 * base64url rather than base64 so the value survives a query string as-is:
 * `+`, `/` and `=` all need percent-encoding, and a client that forgets turns
 * `+` into a space.
 */
export interface Cursor {
  /** `YYYY-MM-DD` — the same wire format the `date` column crosses on. */
  date: string;
  id: string;
}

/**
 * The same primitives the public schemas use, so a cursor can only name a
 * position the list could actually have produced. This is the parse step that
 * makes `decodeCursor`'s output safe to interpolate into a query: `date` is a
 * real calendar date and `id` is a uuid, or the whole thing is `null`.
 */
const cursorPosition = z.object({ date: isoDate, id: uuid });

/**
 * A cursor this module issues is ~90 characters. Anything much longer was never
 * ours, so it is rejected on length rather than handed to a base64 decoder and
 * `JSON.parse` — bounded work for an unbounded input.
 */
const MAX_ENCODED_LENGTH = 256;

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(
    // Rebuilt rather than stringified as-is, so nothing a caller happens to
    // have hung on the object rides along into the token.
    JSON.stringify({ date: cursor.date, id: cursor.id }),
    "utf8",
  ).toString("base64url");

/**
 * `null` for anything that is not a well-formed position — never a throw, and
 * never a half-parsed object. The route turns that `null` into a 400.
 */
export function decodeCursor(raw: string): Cursor | null {
  if (raw.length === 0 || raw.length > MAX_ENCODED_LENGTH) return null;

  let parsed: unknown;
  try {
    // Node's base64 decoder is lenient — it skips characters outside the
    // alphabet rather than failing — so garbage in produces garbage bytes, not
    // an exception. `JSON.parse` and then the schema are what actually reject.
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const result = cursorPosition.safeParse(parsed);
  return result.success ? result.data : null;
}
