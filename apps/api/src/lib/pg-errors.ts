/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * True when `err` is a unique-index violation raised by exactly `constraint`.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` and hangs the
 * `PostgresError` off `cause`, so the SQLSTATE is never on the error that was
 * caught — hence the walk rather than a direct property read.
 *
 * The constraint name is part of the match, not just the SQLSTATE: any other
 * unique index touched by the same statement would raise 23505 too, and turning
 * that into "name already taken" would be a wrong answer the client cannot see
 * through.
 *
 * A pre-check would not remove the need for this. Two concurrent writes both
 * pass the check and one of them still has to lose at the index, so the index is
 * the only place the conflict is actually decided.
 */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  // Bounded: the chain is one hop deep today, and a cap means a self-referential
  // `cause` can never turn this into a hang.
  let cursor: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof cursor !== "object" || cursor === null) return false;
    const pgErr = cursor as { code?: unknown; constraint_name?: unknown };
    if (
      pgErr.code === UNIQUE_VIOLATION &&
      pgErr.constraint_name === constraint
    ) {
      return true;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
