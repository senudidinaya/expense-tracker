import { argon2id, hash, verify } from "argon2";
import { createHash, randomBytes } from "node:crypto";

/**
 * Argon2id parameters, pinned here rather than inherited from the library's
 * defaults. These are the security parameter of every password in the database,
 * and a dependency upgrade must not be able to move them without a diff. The
 * values are the OWASP baseline: 64 MiB, 3 passes, 4 lanes.
 */
const ARGON2_OPTIONS = {
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
} as const;

export const hashPassword = (password: string): Promise<string> =>
  hash(password, ARGON2_OPTIONS);

/**
 * `false` — never a throw — for a digest argon2 cannot parse.
 *
 * The only caller is the login path, and a corrupted or truncated
 * `password_hash` column is not a password that matched. Letting the throw
 * escape would answer 500 for that one account, which both confirms the row
 * exists and breaks the timing uniformity the login path works to preserve.
 */
export async function verifyPassword(
  digest: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
}

/** design/api.md: 256-bit session tokens. */
const SESSION_TOKEN_BYTES = 32;

/**
 * SHA-256, deliberately not a slow KDF. A password needs one because it is
 * low-entropy and guessable; a 256-bit random token is neither, so stretching
 * it buys nothing and would cost ~100 ms on every authenticated request.
 * Hex because the column is looked up by equality on a btree index.
 */
export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

/**
 * The raw token goes to the client; only `tokenHash` is ever stored, so a
 * database dump does not hand over live sessions. base64url keeps the value
 * cookie-safe without percent-encoding.
 */
export function createSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashSessionToken(token) };
}

let dummy: Promise<string> | undefined;

/**
 * A real argon2id digest of a value nobody knows. Login verifies against it when
 * the email does not exist, so "no such user" costs the same as "wrong password"
 * and the response time stops being an account-existence oracle.
 *
 * Derived from `hashPassword` rather than hardcoded, so it always carries the
 * same cost parameters as the hashes it has to be indistinguishable from.
 * Memoized: the work happens once per process, warmed at route registration.
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(SESSION_TOKEN_BYTES).toString("base64url"))
    // A cached rejection would disable the timing defence for the life of the
    // process; drop it so the next login retries.
    .catch((err: unknown) => {
      dummy = undefined;
      throw err;
    });
  return dummy;
}
