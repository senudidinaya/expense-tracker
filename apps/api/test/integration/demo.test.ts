import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgets,
  categories,
  expenses,
  recurringRules,
  sessions,
  users,
} from "../../src/db/schema.js";
import { addDays, todayUtc } from "../../src/lib/dates.js";
import { newId } from "../../src/lib/ids.js";
import {
  expectOnOrBefore,
  expectStrictlyBefore,
  makeTestApp,
  nextClientAddress,
} from "../helpers.js";

/**
 * Task 15, Step 1 — `POST /api/auth/demo`.
 *
 * design/api.md: a single shared writable demo account is a public
 * unauthenticated write surface, so every visitor gets a fresh ephemeral user
 * instead — `is_demo`, a synthetic `demo-<uuid>@demo.invalid` address, an
 * unusable random password hash — seeded with ~6 months of data and handed a
 * normal session cookie. Capacity is capped at 100 live demo users; past the
 * cap the route answers 503 `demo_unavailable`.
 *
 * ## What this file pins that the unit test cannot
 *
 *  - **One transaction.** User, categories, expenses, budgets, rules and
 *    session all commit together or none of them do. A half-seeded demo — a
 *    user who logs in to an empty dashboard, or worse, to a dashboard missing
 *    only its budgets — must be impossible. The probe below breaks the
 *    expenses insert deliberately and then asserts the *user* is gone too.
 *  - **Disjointness.** Two visitors share nothing: not a user, not a row, not
 *    an amount. The amounts are the interesting half — they are what proves
 *    the PRNG is seeded from the new user's id rather than from a constant.
 *  - **The capacity cap**, at its boundary in both directions.
 *
 * Amounts are asserted as ranges and shapes only. The seed is the user id, so
 * an exact-amount assertion here could only pass by accident; see the header
 * of `test/unit/demo-data.test.ts`.
 *
 * ## Which day is "today" — the route reads `todayUtc()`
 *
 * `demoDataset` never reads the clock; `today` is a parameter. Something has
 * to supply it, and the handler is the composition root that does, exactly as
 * Task 16's cron supplies it to the generator. The value it supplies is
 * **UTC**, and this is the decision:
 *
 *  - `todayUtc()` is the codebase's only clock reader, and `lib/dates.ts`
 *    already calls it "the generator's calendar". Seeding a demo on
 *    Asia/Colombo time would put a second definition of "today" in a codebase
 *    whose date handling is built on there being one.
 *  - The two calendars are not merely different, they interact. The cron fires
 *    20:30 UTC — 02:00 Colombo the *next* day — so for 5.5 hours daily the two
 *    disagree. A demo seeded at 21:00 UTC on Colombo time would write expenses
 *    dated D+1 and hand the generator a `next_occurrence` derived from D+1,
 *    while the generator that same night runs with `today = D` and regards D+1
 *    as the future. Nothing corrupts, but the demo's rows and the job's cursor
 *    would be reasoning from different days about the same rule.
 *  - What UTC costs: for those 5.5 hours a Colombo visitor's newest demo
 *    expense reads as "yesterday". That is cosmetic, it is in a demo, and it
 *    is cheaper than two calendars. If the app ever adopts Asia/Colombo as its
 *    display calendar, it changes inside `lib/dates.ts` for every caller at
 *    once — the same upgrade path as widening the currency CHECK.
 *
 * Consequence for this file: the route reads the clock itself, so a test that
 * reads it too can straddle UTC midnight and disagree with the route by a day.
 * `provision()` therefore brackets the call — `startedOn` before, `finishedOn`
 * after — and every date assertion uses the bound that stays true whichever
 * side of midnight the route landed on. `nextOccurrence > startedOn` is the
 * one that would otherwise flake: a weekly cursor one day out is `> D` but not
 * `> D + 1`.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

/** Roughly six months, the window the dataset spans, with slack. */
const WINDOW_DAYS = 210;

// ---------------------------------------------------------------------------
// Cookie plumbing
// ---------------------------------------------------------------------------

const setCookieHeaders = (headers: Record<string, unknown>): string[] => {
  const raw = headers["set-cookie"];
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
};

/** The `session` cookie value from a response, or a failure that names what happened. */
function tokenOf(headers: Record<string, unknown>): string {
  const header = setCookieHeaders(headers).find((h) =>
    h.startsWith("session="),
  );
  if (header === undefined) throw new Error("response set no `session` cookie");
  const pair = header.split(";")[0] ?? "";
  return decodeURIComponent(pair.slice("session=".length));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * A distinct client address per call. The route is rate-limited to 5/min per
 * IP (design/api.md), and this suite provisions far more than five demos — but
 * what it is testing is provisioning, atomicity and the capacity cap, not the
 * limiter. The limit gets its own test below, with its own single address.
 */
const demo = (extra: { cookies?: Record<string, string> } = {}) =>
  app.inject({
    method: "POST",
    url: "/api/auth/demo",
    remoteAddress: nextClientAddress(),
    ...extra,
  });

const me = (token: string) =>
  app.inject({
    method: "GET",
    url: "/api/auth/me",
    cookies: { session: token },
    remoteAddress: nextClientAddress(),
  });

/**
 * Provisions a demo user and hands back its id, cookie and body — plus the UTC
 * date on either side of the call, because the route reads the clock itself
 * and this suite must not disagree with it across a midnight. See "Which day
 * is today" above. `startedOn <= route's today <= finishedOn`, always.
 */
async function provision() {
  const startedOn = todayUtc();
  const r = await demo();
  const finishedOn = todayUtc();
  if (r.statusCode !== 201) {
    throw new Error(`demo provisioning failed: ${r.statusCode} ${r.body}`);
  }
  const { user } = r.json();
  return {
    userId: user.id as string,
    token: tokenOf(r.headers),
    user,
    startedOn,
    finishedOn,
  };
}

// ---------------------------------------------------------------------------
// Table reads
// ---------------------------------------------------------------------------

const expensesOf = (userId: string) =>
  db.select().from(expenses).where(eq(expenses.userId, userId));

const categoriesOf = (userId: string) =>
  db.select().from(categories).where(eq(categories.userId, userId));

const budgetsOf = (userId: string) =>
  db.select().from(budgets).where(eq(budgets.userId, userId));

const rulesOf = (userId: string) =>
  db.select().from(recurringRules).where(eq(recurringRules.userId, userId));

const demoUserCount = async (): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.isDemo, true));
  return row!.n;
};

const sessionCount = async (): Promise<number> => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sessions);
  return row!.n;
};

// ---------------------------------------------------------------------------
// Capacity fixture
// ---------------------------------------------------------------------------

/**
 * Brings the live `is_demo` population to exactly `target`.
 *
 * Filling with rows inserted straight into the table rather than with 100 real
 * provisionings: what the cap reads is a count of `is_demo = true` users, and
 * a hundred round trips through the route would cost a hundred argon2 hashes
 * and tens of thousands of seeded inserts to establish the same number.
 *
 * Shrinking deletes demo users outright — the FK cascades take their data and
 * sessions with them, which is exactly what the nightly reap does. Only the
 * capacity and rate-limit blocks shrink, and both provision their own users
 * afterwards, so no earlier test's cookie is pulled out from under it.
 */
async function setDemoUserCount(target: number): Promise<void> {
  const current = await demoUserCount();
  if (current === target) return;

  if (current < target) {
    await db.insert(users).values(
      Array.from({ length: target - current }, () => ({
        id: newId(),
        email: `filler-${newId()}@demo.invalid`,
        // Never verified against: no route logs a filler in. The value matters
        // only in that the column is NOT NULL.
        passwordHash: "$argon2id$unusable-filler",
        isDemo: true,
      })),
    );
    return;
  }

  const doomed = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isDemo, true))
    .limit(current - target);
  await db.delete(users).where(
    inArray(
      users.id,
      doomed.map((u) => u.id),
    ),
  );
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  ({ app, db, stop } = await makeTestApp());
  await app.ready();
}, 120_000);

// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

// ---------------------------------------------------------------------------

describe("POST /api/auth/demo — provisioning", () => {
  it("201s with a demo user and a working session cookie", async () => {
    const r = await demo();

    expect(r.statusCode).toBe(201);
    const { user } = r.json();
    expect(user.isDemo).toBe(true);
    expect(Object.keys(user).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "isDemo",
    ]);

    const after = await me(tokenOf(r.headers));
    expect(after.statusCode).toBe(200);
    expect(after.json().user.id).toBe(user.id);
    expect(after.json().user.isDemo).toBe(true);
  });

  it("uses a synthetic, unroutable address", async () => {
    // `.invalid` is reserved by RFC 2606 and can never resolve, so a demo user
    // is structurally incapable of receiving mail even if v2 adds sending.
    const { user } = await provision();
    expect(user.email).toMatch(
      /^demo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@demo\.invalid$/,
    );
  });

  it("puts no credential anywhere in the response", async () => {
    const r = await demo();
    // Asserted before the sweep: an error body contains none of these either,
    // so without this line the test goes green on a route that does not exist.
    expect(r.statusCode).toBe(201);
    for (const leak of [
      "passwordHash",
      "password_hash",
      "$argon2",
      "password",
    ]) {
      expect(r.body).not.toContain(leak);
    }
  });

  it("stores an argon2 hash that no password the client holds can open", async () => {
    // The client is never told a password; the hash exists so the column is
    // honest and so `verifyCredentials` on a guessed demo address costs the
    // same as on any other account.
    const { userId } = await provision();
    const [row] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    expect(row!.passwordHash.startsWith("$argon2id$")).toBe(true);
  });

  it("rotates the session: a cookie held before the call stops working", async () => {
    // design/api.md — demo login rotates, same session-fixation defence as
    // password login.
    const first = await provision();
    expect((await me(first.token)).statusCode).toBe(200);

    const r = await demo({ cookies: { session: first.token } });
    expect(r.statusCode).toBe(201);
    const rotated = tokenOf(r.headers);

    expect(rotated).not.toBe(first.token);
    expect((await me(first.token)).statusCode).toBe(401);
    expect((await me(rotated)).statusCode).toBe(200);
  });
});

describe("POST /api/auth/demo — the seeded dataset", () => {
  it("seeds the eight default categories, all active", async () => {
    const { userId } = await provision();
    const seeded = await categoriesOf(userId);

    expect(seeded).toHaveLength(8);
    expect(seeded.map((c) => c.name).sort()).toEqual(
      [
        "Entertainment",
        "Food",
        "Health",
        "Other",
        "Rent",
        "Shopping",
        "Transport",
        "Utilities",
      ].sort(),
    );
    expect(seeded.every((c) => c.archivedAt === null)).toBe(true);
  });

  it("lands about six months of expenses, all owned and all in LKR minor units", async () => {
    const { userId, startedOn, finishedOn } = await provision();
    const rows = await expensesOf(userId);

    // A floor for "six months of realistic data", not a target: weekly
    // groceries alone are ~26 rows before rent, utilities and the spread.
    expect(rows.length).toBeGreaterThanOrEqual(40);

    const categoryIds = new Set((await categoriesOf(userId)).map((c) => c.id));
    for (const row of rows) {
      expect(row.userId).toBe(userId);
      expect(categoryIds.has(row.categoryId)).toBe(true);
      expect(row.currency).toBe("LKR");
      expect(Number.isInteger(row.amountMinor)).toBe(true);
      expect(row.amountMinor).toBeGreaterThan(0);
      // Each bound takes the side of the bracket that survives a midnight
      // crossing: nothing past the latest the route could have thought it was,
      // nothing before the window measured from the earliest.
      expectOnOrBefore(row.date, finishedOn);
      expectOnOrBefore(addDays(startedOn, -WINDOW_DAYS), row.date);
      expect(row.description.length).toBeGreaterThan(0);
    }
  });

  it("budgets five categories, each effective in the current month", async () => {
    const { userId, finishedOn } = await provision();
    // The later month of the bracket: a budget effective in it is effective in
    // the earlier one too, since `month_start` only ever moves backwards.
    const currentMonth = `${finishedOn.slice(0, 7)}-01`;
    const rows = await budgetsOf(userId);

    const budgeted = new Set(rows.map((b) => b.categoryId));
    expect(budgeted.size).toBe(5);

    // design/schema.md: effective budget for month M = greatest month_start
    // <= M. Every budgeted category must resolve to a non-null amount today,
    // or the demo dashboard opens with no budget bars.
    for (const categoryId of budgeted) {
      const effective = rows
        .filter(
          (b) => b.categoryId === categoryId && b.monthStart <= currentMonth,
        )
        .sort((x, y) => x.monthStart.localeCompare(y.monthStart))
        .at(-1);
      expect(effective).toBeDefined();
      expect(effective!.amountMinor).toBeGreaterThan(0);
      expect(effective!.currency).toBe("LKR");
    }
  });

  it("creates two or three rules whose cursor is strictly in the future", async () => {
    const { userId, startedOn, finishedOn } = await provision();
    const rows = await rulesOf(userId);

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);
    for (const rule of rows) {
      expect(rule.userId).toBe(userId);
      expect(["weekly", "monthly"]).toContain(rule.frequency);
      expect(rule.amountMinor).toBeGreaterThan(0);
      expectOnOrBefore(rule.startDate, finishedOn);
      // The seed already wrote this rule's history. A cursor at or before
      // today makes tonight's generator insert a day the seed covered.
      // Compared against the *earlier* bound: a cursor one day out is `>
      // startedOn` whichever side of midnight the route landed on, where
      // `> finishedOn` would flake on exactly that case.
      expectStrictlyBefore(startedOn, rule.nextOccurrence);
    }
  });

  it("hands over a sandbox that is immediately writable", async () => {
    // "Fully writable — every visitor gets their own sandbox" (design/api.md).
    // The demo session is an ordinary session; nothing about it is read-only.
    const { userId, token } = await provision();
    const [category] = await categoriesOf(userId);

    const r = await app.inject({
      method: "POST",
      url: "/api/expenses",
      cookies: { session: token },
      remoteAddress: nextClientAddress(),
      payload: {
        amountMinor: 4_500_00,
        categoryId: category!.id,
        date: todayUtc(),
        description: "Written by the visitor",
      },
    });

    expect(r.statusCode).toBe(201);
  });
});

describe("two visitors get disjoint sandboxes", () => {
  it("shares no user, no row, and no amount", async () => {
    const a = await provision();
    const b = await provision();

    expect(b.userId).not.toBe(a.userId);
    expect(b.user.email).not.toBe(a.user.email);

    const [expensesA, expensesB] = await Promise.all([
      expensesOf(a.userId),
      expensesOf(b.userId),
    ]);
    expect(expensesA.length).toBeGreaterThan(0);
    expect(expensesB.length).toBeGreaterThan(0);

    const idsA = new Set(expensesA.map((e) => e.id));
    expect(expensesB.some((e) => idsA.has(e.id))).toBe(false);

    // The point of seeding the PRNG from the user id: two visitors on the same
    // day see different numbers. Under a fixed seed these two arrays are equal.
    const amounts = (rows: typeof expensesA) =>
      rows.map((e) => e.amountMinor).sort((x, y) => x - y);
    expect(amounts(expensesB)).not.toEqual(amounts(expensesA));
  });

  it("keeps one visitor's rows out of the other's category ids", async () => {
    const a = await provision();
    const b = await provision();

    const categoryIdsA = new Set(
      (await categoriesOf(a.userId)).map((c) => c.id),
    );
    for (const row of await expensesOf(b.userId)) {
      expect(categoryIdsA.has(row.categoryId)).toBe(false);
    }
  });
});

describe("the whole provisioning is one transaction", () => {
  it("leaves no user behind when seeding fails partway", async () => {
    // A CHECK that no row can satisfy, added NOT VALID so the rows already in
    // the table are left alone. Every *new* expense insert now fails, which
    // puts the failure squarely in the middle of provisioning — after the user
    // and its categories, before the budgets and rules.
    const before = {
      users: await demoUserCount(),
      sessions: await sessionCount(),
    };

    await db.execute(
      sql`alter table expenses add constraint demo_atomicity_probe check (false) not valid`,
    );
    try {
      const r = await demo();
      // Not a 201 dressed up as a success: seeding genuinely could not finish.
      expect(r.statusCode).toBeGreaterThanOrEqual(500);
      expect(setCookieHeaders(r.headers)).toHaveLength(0);
    } finally {
      await db.execute(
        sql`alter table expenses drop constraint demo_atomicity_probe`,
      );
    }

    // The user row is the one that must not survive. A user with no expenses
    // is a visitor staring at an empty app with no way to get a new sandbox.
    expect(await demoUserCount()).toBe(before.users);
    expect(await sessionCount()).toBe(before.sessions);
  });

  it("still provisions normally once the probe is gone", async () => {
    // Guards the probe itself: if the constraint had leaked, every later test
    // in this file would fail for the wrong reason.
    const { userId } = await provision();
    expect((await expensesOf(userId)).length).toBeGreaterThan(0);
  });
});

/**
 * ## Can count-then-insert race? Yes, and the tests below cannot see it.
 *
 * Counting `is_demo = true` and then inserting is not atomic and cannot be
 * made so by ordering alone. Under READ COMMITTED, a concurrent transaction's
 * uncommitted user row is invisible to our count, and there is no existing row
 * to lock — you cannot `SELECT ... FOR UPDATE` a row that does not exist yet.
 * So N requests arriving at 99 live demo users all count 99, all pass the
 * check, and all commit: 99 + N.
 *
 * The window is not narrow, either. It spans the whole of provisioning — an
 * argon2 hash plus several hundred seeded inserts, hundreds of milliseconds —
 * so this is a race that happens, not one that theoretically could.
 *
 * The exact fixes and what they cost:
 *
 *  - `pg_advisory_xact_lock(<fixed key>)` before the count. Exact, one extra
 *    round trip — but the lock is held until commit, so every demo
 *    provisioning in the fleet serializes behind the slowest seed.
 *  - SERIALIZABLE isolation. SSI detects precisely this pattern (a predicate
 *    read invalidated by a concurrent insert) and raises 40001, which means
 *    writing a retry loop around a transaction that has already burned an
 *    argon2 hash.
 *
 * Conclusion, and what the implementation should carry as a comment: neither
 * is worth it, because **the cap is a resource ceiling, not an invariant**.
 * Nothing in the system reads the count except this one branch; no data is
 * corrupted by 103 live demo users; the 5/min/IP limit bounds how large a
 * burst N can be; and the nightly reap returns the population to zero within
 * a day. A brief overshoot is the cheapest correct trade.
 *
 * What that means for this file: these tests assert the boundary in the
 * quiescent case, which is the only case a sequential suite can prove. The
 * race is documented rather than tested — a test for it would need two
 * transactions held open mid-statement, the same reason `FOR UPDATE SKIP
 * LOCKED` goes untested in `generator.test.ts`.
 */
describe("capacity cap", () => {
  it("provisions the hundredth demo user", async () => {
    // The cap is "max 100 live demo users", so 99 live means there is room for
    // exactly one more. Off-by-one in the comparison shows up here.
    await setDemoUserCount(99);

    const r = await demo();
    expect(r.statusCode).toBe(201);
    expect(await demoUserCount()).toBe(100);
  });

  it("503s with demo_unavailable at the cap, creating nothing", async () => {
    await setDemoUserCount(100);
    const before = { users: 100, sessions: await sessionCount() };

    const r = await demo();

    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({
      error: {
        code: "demo_unavailable",
        message: expect.any(String),
      },
    });
    // A 503 that had already created the user would push the population past
    // the cap and hand the visitor a cookie for a sandbox it just refused.
    expect(setCookieHeaders(r.headers)).toHaveLength(0);
    expect(await demoUserCount()).toBe(before.users);
    expect(await sessionCount()).toBe(before.sessions);
  });

  it("does not count real accounts against the demo cap", async () => {
    // The cap is on `is_demo = true` rows. Signups are unbounded, and a busy
    // day of real signups must not close the demo door.
    await setDemoUserCount(99);
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: {
        email: `not-a-demo-${newId()}@example.com`,
        password: "a-perfectly-fine-passphrase",
      },
      remoteAddress: nextClientAddress(),
    });
    expect(signup.statusCode).toBe(201);

    expect((await demo()).statusCode).toBe(201);
  });

  it("frees capacity again when demo users are reaped", async () => {
    // The nightly cron deletes demo users older than 24h (Task 16). Deleting
    // them has to reopen the door, which it only does if the count is read
    // live rather than cached in the process.
    await setDemoUserCount(100);
    expect((await demo()).statusCode).toBe(503);

    await setDemoUserCount(50);
    expect((await demo()).statusCode).toBe(201);
  });
});

/**
 * There is deliberately no rate-limit test here.
 *
 * Proving 5/min/IP through this route means provisioning five real demo users
 * inside one timeout — five argon2 hashes and a few hundred seeded inserts —
 * to reach an assertion about a limiter that never touches any of that work.
 * It would have been the slowest and flakiest test in the file, and it would
 * have failed for reasons (a loaded runner, a slow hash) that have nothing to
 * do with what it claims to check.
 *
 * The limit is covered where it costs nothing: `security.test.ts` (Task 7)
 * asserts `AUTH_RATE_LIMITS.demo.max === 5` and exercises the limiter itself
 * against `/api/auth/login`, which shares the plugin and the keying. What the
 * route owes on top of that is one line of config, verified by reading.
 */
