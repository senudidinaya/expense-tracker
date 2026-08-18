import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { categories, sessions, users } from "../../src/db/schema.js";
import { makeTestApp, testEnv } from "../helpers.js";

/**
 * design/api.md fixes this seed set. It is spelled out here rather than imported
 * from the repo so the test states the requirement independently — importing the
 * constant would make the assertion agree with whatever the code happens to say.
 */
const DEFAULT_CATEGORIES = [
  "Food",
  "Transport",
  "Rent",
  "Utilities",
  "Health",
  "Entertainment",
  "Shopping",
  "Other",
];

const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

interface ParsedCookie {
  name: string;
  value: string;
  attributes: Map<string, string>;
}

/**
 * Parses a raw `Set-Cookie` header rather than reading the test framework's
 * already-parsed view of it. The flags on that header *are* the security
 * boundary for the session, so the test asserts on the bytes that actually go
 * out on the wire.
 */
function parseSetCookie(raw: string): ParsedCookie {
  const parts = raw.split(";").map((s) => s.trim());
  const pair = parts[0] ?? "";
  const split = pair.indexOf("=");
  const attributes = new Map<string, string>();
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf("=");
    if (i === -1) attributes.set(attr.toLowerCase(), "");
    else attributes.set(attr.slice(0, i).toLowerCase(), attr.slice(i + 1));
  }
  return {
    name: pair.slice(0, split),
    value: decodeURIComponent(pair.slice(split + 1)),
    attributes,
  };
}

const setCookies = (headers: Record<string, unknown>): ParsedCookie[] => {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [String(raw)]).map((h) =>
    parseSetCookie(String(h)),
  );
};

/** The `session` cookie from a response, or a failure that names what happened. */
function sessionCookie(headers: Record<string, unknown>): ParsedCookie {
  const found = setCookies(headers).find((c) => c.name === "session");
  if (!found) throw new Error("response set no `session` cookie");
  return found;
}

const tokenOf = (headers: Record<string, unknown>): string =>
  sessionCookie(headers).value;

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

interface Extra {
  cookies?: Record<string, string>;
  remoteAddress?: string;
}

/**
 * A distinct client address per call. `/signup` and `/login` are rate-limited to
 * 10/min per IP (Task 7), and this suite makes far more than ten of each — but
 * what it is testing is credentials and sessions, not the limiter. Giving every
 * request its own bucket keeps those assertions about what they say they are
 * about; the limits themselves are tested in `security.test.ts`.
 *
 * With no `X-Forwarded-For` header, `trustProxy: 1` resolves `req.ip` — the
 * limiter's key — to exactly this socket address.
 */
let clients = 0;
const nextClientAddress = () => {
  clients += 1;
  return `10.0.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
};

const signup = (email: string, password: string, extra: Extra = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password },
    remoteAddress: nextClientAddress(),
    ...extra,
  });

const login = (email: string, password: string, extra: Extra = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
    remoteAddress: nextClientAddress(),
    ...extra,
  });

const me = (token?: string) =>
  app.inject({
    method: "GET",
    url: "/api/auth/me",
    ...(token === undefined ? {} : { cookies: { session: token } }),
  });

const logout = (token?: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/logout",
    ...(token === undefined ? {} : { cookies: { session: token } }),
  });

const sessionRow = async (token: string) => {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.tokenHash, sha256(token)));
  return rows[0];
};

/** Signs up a throwaway account and hands back its credentials and cookie. */
async function newAccount(label: string) {
  const email = `${label}@example.com`;
  const password = `pw-${label}-8charsmin`;
  const r = await signup(email, password);
  expect(r.statusCode).toBe(201);
  return {
    email,
    password,
    token: tokenOf(r.headers),
    userId: r.json().user.id,
  };
}

beforeAll(async () => {
  ({ app, db, stop } = await makeTestApp());
  await app.ready();
}, 120_000);

// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

// ---------------------------------------------------------------------------

describe("POST /api/auth/signup", () => {
  it("201s with the user, sets a session cookie, and seeds the 8 default categories", async () => {
    const r = await signup(
      "signup-ok@example.com",
      "a-perfectly-fine-passphrase",
    );

    expect(r.statusCode).toBe(201);
    const { user } = r.json();
    expect(user).toMatchObject({
      email: "signup-ok@example.com",
      isDemo: false,
    });
    expect(typeof user.id).toBe("string");
    expect(new Date(user.createdAt).getTime()).not.toBeNaN();

    const cookie = sessionCookie(r.headers);
    expect(cookie.value).not.toBe("");
    expect(cookie.attributes.has("httponly")).toBe(true);

    const seeded = await db
      .select()
      .from(categories)
      .where(eq(categories.userId, user.id));
    expect(seeded).toHaveLength(8);
    expect(seeded.map((c) => c.name).sort()).toEqual(
      [...DEFAULT_CATEGORIES].sort(),
    );
    // All active: an archived seed category would be invisible in a new-expense form.
    expect(seeded.every((c) => c.archivedAt === null)).toBe(true);
  });

  it("the new session is usable immediately", async () => {
    const r = await signup(
      "signup-session@example.com",
      "another-fine-passphrase",
    );
    const after = await me(tokenOf(r.headers));
    expect(after.statusCode).toBe(200);
    expect(after.json().user.email).toBe("signup-session@example.com");
  });

  it("rejects a duplicate email with 409 conflict", async () => {
    await signup("dupe@example.com", "first-account-passphrase");
    const second = await signup(
      "dupe@example.com",
      "second-account-passphrase",
    );

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict");
    expect(setCookies(second.headers)).toHaveLength(0);
  });

  it("treats email as case-insensitive when detecting a duplicate", async () => {
    await signup("CaseUser@example.com", "case-account-passphrase");
    const second = await signup(
      "caseuser@EXAMPLE.com",
      "case-account-passphrase",
    );
    expect(second.statusCode).toBe(409);
  });

  it("seeds categories in the same transaction as the user, so a failed signup leaves none", async () => {
    const before = await db.select().from(categories);
    const r = await signup("dupe@example.com", "third-account-passphrase");
    expect(r.statusCode).toBe(409);
    const after = await db.select().from(categories);
    expect(after).toHaveLength(before.length);
  });

  it("rejects a common password with 400 validation_failed naming the field", async () => {
    const r = await signup("common@example.com", "password1234");

    expect(r.statusCode).toBe(400);
    const { error } = r.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details.map((d: { path: string }) => d.path)).toContain(
      "password",
    );
    // The rejected password is never echoed back.
    expect(r.body).not.toContain("password1234");
  });

  it("rejects a password shorter than the policy minimum", async () => {
    const r = await signup("short@example.com", "sh0rt");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("rejects a malformed email", async () => {
    const r = await signup("not-an-email", "a-perfectly-fine-passphrase");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });
});

describe("POST /api/auth/login", () => {
  it("200s with the user and a fresh cookie", async () => {
    const acct = await newAccount("login-ok");
    const r = await login(acct.email, acct.password);

    expect(r.statusCode).toBe(200);
    expect(r.json().user.email).toBe(acct.email);
    expect(tokenOf(r.headers)).not.toBe(acct.token);
  });

  it("matches the email case-insensitively", async () => {
    const acct = await newAccount("login-case");
    const r = await login(acct.email.toUpperCase(), acct.password);
    expect(r.statusCode).toBe(200);
  });

  it("answers a wrong password and an unknown email with the identical 401 body", async () => {
    const acct = await newAccount("login-401");

    const wrongPassword = await login(
      acct.email,
      "definitely-not-the-password",
    );
    const unknownEmail = await login(
      "nobody-at-all@example.com",
      acct.password,
    );

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    // Byte-identical: any difference is an account-existence oracle.
    expect(unknownEmail.body).toBe(wrongPassword.body);
    expect(wrongPassword.json().error.code).toBe("unauthorized");
    expect(setCookies(wrongPassword.headers)).toHaveLength(0);
  });

  it("spends the same time on an unknown email as on a wrong password", async () => {
    const acct = await newAccount("login-timing");

    // Each sample gets its own client address: the per-route login rate limit
    // (Task 7) is keyed by IP, and this test is the heaviest caller in the suite.
    let addr = 0;
    const nextAddress = () =>
      `10.0.${Math.floor(addr / 250)}.${(addr++ % 250) + 1}`;

    const sample = async (email: string, password: string) => {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const r = await login(email, password, {
          remoteAddress: nextAddress(),
        });
        runs.push(performance.now() - started);
        expect(r.statusCode).toBe(401);
      }
      runs.sort((a, b) => a - b);
      return runs[Math.floor(runs.length / 2)]!;
    };

    // Warm first: argon2's first call in a process pays for native module init,
    // and the dummy digest is computed once and memoized. Neither is the signal.
    await sample("warmup-unknown@example.com", "warmup-password");
    await sample(acct.email, "warmup-wrong-password");

    const unknownEmail = await sample("ghost@example.com", "some-password");
    const wrongPassword = await sample(acct.email, "not-the-password");

    // Both paths run exactly one argon2id verification, so they land within a
    // small factor of each other. Skipping the verification when the email is
    // unknown — the bug this guards — makes the unknown-email path ~100x faster,
    // nowhere near this band even on a loaded CI runner.
    const ratio = unknownEmail / wrongPassword;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  }, 60_000);

  it("rotates the session: the cookie held before login stops working", async () => {
    const acct = await newAccount("login-rotate");
    expect((await me(acct.token)).statusCode).toBe(200);

    const r = await login(acct.email, acct.password, {
      cookies: { session: acct.token },
    });
    const rotated = tokenOf(r.headers);

    expect(rotated).not.toBe(acct.token);
    expect((await me(acct.token)).statusCode).toBe(401);
    expect((await me(rotated)).statusCode).toBe(200);
    expect(await sessionRow(acct.token)).toBeUndefined();
  });

  it("rotation is not a global sign-out: another device's session survives", async () => {
    const acct = await newAccount("login-other-device");
    const otherDevice = tokenOf(
      (await login(acct.email, acct.password)).headers,
    );

    // A third login, presenting neither cookie.
    await login(acct.email, acct.password);

    expect((await me(otherDevice)).statusCode).toBe(200);
  });
});

describe("GET /api/auth/me", () => {
  it("401s without a cookie", async () => {
    const r = await me();
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("401s on a cookie that is not a real token", async () => {
    const r = await me("this-is-not-a-session-token");
    expect(r.statusCode).toBe(401);
  });

  it("returns the user, with no password hash anywhere in the body", async () => {
    const acct = await newAccount("me-ok");
    const r = await me(acct.token);

    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json().user).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "isDemo",
    ]);
  });

  it("401s on an expired session", async () => {
    const acct = await newAccount("me-expired");
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.tokenHash, sha256(acct.token)));

    expect((await me(acct.token)).statusCode).toBe(401);
  });

  it("401s past the 90-day absolute cap even though expires_at is still in the future", async () => {
    const acct = await newAccount("me-capped");
    await db
      .update(sessions)
      .set({ createdAt: new Date(Date.now() - 91 * DAY_MS) })
      .where(eq(sessions.tokenHash, sha256(acct.token)));

    const row = await sessionRow(acct.token);
    // The point of the test: expiry alone would still let this through.
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect((await me(acct.token)).statusCode).toBe(401);
  });
});

describe("sliding session expiry", () => {
  it("does not touch expires_at when the session was refreshed under 24h ago", async () => {
    const acct = await newAccount("slide-fresh");
    const before = (await sessionRow(acct.token))!.expiresAt;

    expect((await me(acct.token)).statusCode).toBe(200);

    const after = (await sessionRow(acct.token))!.expiresAt;
    expect(after.getTime()).toBe(before.getTime());
  });

  it("extends expires_at when the last refresh was over 24h ago", async () => {
    const acct = await newAccount("slide-extend");
    const now = Date.now();
    // Last refreshed 2 days ago: a 30-day window that ends in 28 days.
    await db
      .update(sessions)
      .set({
        createdAt: new Date(now - 2 * DAY_MS),
        expiresAt: new Date(now + 28 * DAY_MS),
      })
      .where(eq(sessions.tokenHash, sha256(acct.token)));

    expect((await me(acct.token)).statusCode).toBe(200);

    const after = (await sessionRow(acct.token))!.expiresAt.getTime();
    expect(after).toBeGreaterThan(now + 29 * DAY_MS);
    expect(after).toBeLessThanOrEqual(now + 30 * DAY_MS + 60_000);
  });

  it("never slides past created_at + 90 days", async () => {
    const acct = await newAccount("slide-capped");
    const now = Date.now();
    const createdAt = new Date(now - 89 * DAY_MS);
    await db
      .update(sessions)
      .set({ createdAt, expiresAt: new Date(now + 60 * 60 * 1000) })
      .where(eq(sessions.tokenHash, sha256(acct.token)));

    expect((await me(acct.token)).statusCode).toBe(200);

    // A refresh happened (the window had 29 days of slack) but stopped at the
    // cap — one more day, not another thirty.
    const after = (await sessionRow(acct.token))!.expiresAt.getTime();
    expect(after).toBeGreaterThan(now + 60 * 60 * 1000);
    expect(after).toBeLessThanOrEqual(createdAt.getTime() + 90 * DAY_MS);
  });
});

describe("POST /api/auth/logout", () => {
  it("204s, clears the cookie, deletes the row, and the token stops working", async () => {
    const acct = await newAccount("logout-ok");

    const r = await logout(acct.token);
    expect(r.statusCode).toBe(204);

    const cleared = sessionCookie(r.headers);
    expect(cleared.value).toBe("");
    const expires = cleared.attributes.get("expires");
    const maxAge = cleared.attributes.get("max-age");
    expect(
      maxAge === "0" ||
        (expires !== undefined && new Date(expires).getTime() <= Date.now()),
    ).toBe(true);

    expect(await sessionRow(acct.token)).toBeUndefined();
    expect((await me(acct.token)).statusCode).toBe(401);
  });

  it("401s without a session", async () => {
    const r = await logout();
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });
});

describe("session storage", () => {
  it("stores the sha256 of the token and never the token itself", async () => {
    const acct = await newAccount("storage");

    const row = await sessionRow(acct.token);
    expect(row).toBeDefined();
    expect(row!.tokenHash).toBe(sha256(acct.token));
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.tokenHash).not.toBe(acct.token);

    // No column anywhere in the row carries the raw cookie value.
    expect(JSON.stringify(row)).not.toContain(acct.token);

    // And a full-table scan finds it nowhere either — including in rows this
    // test did not create.
    const all = await db.select().from(sessions);
    expect(JSON.stringify(all)).not.toContain(acct.token);
  });

  it("issues a distinct 256-bit token per session", async () => {
    const acct = await newAccount("storage-entropy");
    const second = tokenOf((await login(acct.email, acct.password)).headers);

    for (const token of [acct.token, second]) {
      // base64url of 32 bytes: 43 characters, no padding, cookie-safe alphabet.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(second).not.toBe(acct.token);
  });
});

describe("session cookie flags", () => {
  it("is HttpOnly, SameSite=Lax, site-wide, and expires in 30 days", async () => {
    const r = await signup("flags@example.com", "a-perfectly-fine-passphrase");
    const { attributes } = sessionCookie(r.headers);

    expect(attributes.has("httponly")).toBe(true);
    expect(attributes.get("samesite")?.toLowerCase()).toBe("lax");
    expect(attributes.get("path")).toBe("/");
    expect(Number(attributes.get("max-age"))).toBe(30 * 24 * 60 * 60);
  });

  it("omits Secure on an http origin and sets it on an https one", async () => {
    const insecure = await signup(
      "flags-http@example.com",
      "a-perfectly-fine-passphrase",
    );
    // The test env's APP_ORIGIN is http://localhost:5173 — a Secure cookie there
    // would never be sent back, breaking local dev.
    expect(sessionCookie(insecure.headers).attributes.has("secure")).toBe(
      false,
    );

    const secureApp = await buildApp({
      db,
      env: testEnv({ APP_ORIGIN: "https://expenses.example.com" }),
      logger: false,
    });
    const r = await secureApp.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: "flags-https@example.com",
        password: "a-perfectly-fine-passphrase",
      },
    });
    expect(r.statusCode).toBe(201);
    expect(sessionCookie(r.headers).attributes.has("secure")).toBe(true);

    await secureApp.close();
  });
});

describe("the password hash never leaves the repository layer", () => {
  it("appears in no auth response body, in no shape", async () => {
    const email = "leak@example.com";
    const password = "a-perfectly-fine-passphrase";

    const signedUp = await signup(email, password);
    const token = tokenOf(signedUp.headers);
    const loggedIn = await login(email, password);
    const profile = await me(token);
    const badLogin = await login(email, "wrong-password-here");
    const loggedOut = await logout(tokenOf(loggedIn.headers));

    const bodies = [signedUp, loggedIn, profile, badLogin, loggedOut].map(
      (r) => r.body,
    );

    for (const body of bodies) {
      for (const leak of [
        "passwordHash",
        "password_hash",
        "$argon2",
        password,
      ]) {
        expect(body).not.toContain(leak);
      }
    }

    // Belt and braces: the hash really is stored and really is an argon2id
    // digest, so the sweep above is asserting the absence of something that
    // exists rather than the absence of something never produced.
    const rows = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email));
    expect(rows[0]!.passwordHash.startsWith("$argon2id$")).toBe(true);
  });
});
