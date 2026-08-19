import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";
import { createSessionToken } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** design/api.md: 30-day expiry, sliding. */
export const SESSION_TTL_MS = 30 * DAY_MS;

/**
 * The hard ceiling on a session's life, measured from `created_at`. Sliding
 * refresh may not push `expires_at` past it, so a stolen token cannot be kept
 * alive forever simply by using it.
 */
export const SESSION_ABSOLUTE_MAX_MS = 90 * DAY_MS;

/** Refresh at most once a day: the point is a sliding window, not a write per request. */
export const SESSION_REFRESH_AFTER_MS = 1 * DAY_MS;

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

const sessionColumns = {
  id: sessions.id,
  userId: sessions.userId,
  createdAt: sessions.createdAt,
  expiresAt: sessions.expiresAt,
} as const;

export const sessionsRepo = {
  /**
   * Mints a session and returns the raw token — the only moment it exists
   * server-side. Only its sha256 is written, so the row cannot be turned back
   * into a usable cookie.
   */
  async create(db: Db, userId: string, now = new Date()): Promise<string> {
    const { token, tokenHash } = createSessionToken();
    await db.insert(sessions).values({
      id: newId(),
      userId,
      tokenHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
    });
    return token;
  },

  /**
   * The session behind a cookie, or `null` if there isn't a usable one — absent,
   * expired, or past the absolute cap all answer the same, because the caller
   * turns every one of them into the same 401.
   *
   * Applies the sliding refresh as a side effect, which is why this is the single
   * entry point the auth plugin uses rather than a plain lookup.
   */
  async findValid(
    db: Db,
    tokenHash: string,
    now = new Date(),
  ): Promise<SessionRecord | null> {
    const [row] = await db
      .select(sessionColumns)
      .from(sessions)
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;

    if (row.expiresAt.getTime() <= now.getTime()) return null;

    // Checked independently of `expires_at` rather than trusted to follow from
    // it: a row whose expiry was refreshed before this cap existed, or written by
    // a future bug, must still stop being accepted at 90 days.
    const absoluteDeadline = row.createdAt.getTime() + SESSION_ABSOLUTE_MAX_MS;
    if (now.getTime() >= absoluteDeadline) return null;

    // There is no `last_refreshed_at` column and none is needed: every refresh
    // sets `expires_at` to (that moment + TTL), so the moment is `expires_at - TTL`.
    const lastRefreshedAt = row.expiresAt.getTime() - SESSION_TTL_MS;
    if (now.getTime() - lastRefreshedAt < SESSION_REFRESH_AFTER_MS) return row;

    const nextExpiry = new Date(
      Math.min(now.getTime() + SESSION_TTL_MS, absoluteDeadline),
    );
    // Once the cap binds, the computed expiry stops moving. Writing it again on
    // every request would be a write per request that changes nothing — and it is
    // what makes the `expires_at - TTL` derivation above safe near the cap.
    if (nextExpiry.getTime() <= row.expiresAt.getTime()) return row;

    await db
      .update(sessions)
      .set({ expiresAt: nextExpiry })
      .where(eq(sessions.id, row.id));

    return { ...row, expiresAt: nextExpiry };
  },

  /** Logout, and the old half of login's token rotation. */
  async delete(db: Db, tokenHash: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  },

  /** Every device. Not used by login — rotation invalidates one cookie, not all. */
  async deleteAllForUser(db: Db, userId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId));
  },
};
