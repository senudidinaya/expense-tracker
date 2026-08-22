import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expenses } from "../../src/db/schema.js";
import { newId } from "../../src/lib/ids.js";
import { categoriesRepo } from "../../src/repos/categories.js";
import { expensesRepo } from "../../src/repos/expenses.js";
import { asUser, makeTestApp, signupUser, type TestUser } from "../helpers.js";

/**
 * Task 8, Step 1 — the ownership-isolation suite, written before the CRUD tests
 * and before a line of the implementation.
 *
 * Two rules it exists to hold:
 *
 *  1. **Every cross-user answer is 404, never 403.** design/api.md reserves 403
 *     for exactly one thing, a CSRF origin mismatch. A 403 on another user's id
 *     confirms the id exists, which is the leak the status code was chosen to
 *     avoid — so "not yours" and "not there" must be indistinguishable, down to
 *     the bytes of the response body.
 *  2. **Scoping lives in the repository layer.** Every query is filtered by the
 *     session's `user_id`; the routes only translate `null` into an envelope.
 *     The list assertions below are the ones an unscoped `SELECT` fails.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

let userA: TestUser;
let userB: TestUser;
let asA: ReturnType<typeof asUser>;
let asB: ReturnType<typeof asUser>;

/** A's private category and expense — the two ids B will be caught reaching for. */
let catA: { id: string; name: string };
let expA: { id: string; description: string };

/**
 * A syntactically valid id that belongs to nobody. It is what "not there" looks
 * like, and the pair of it with one of A's ids is what proves B cannot tell the
 * two apart. Not a literal: a valid UUID is required or the route answers 400
 * from the path schema and never reaches the repository at all.
 */
const NOWHERE_ID = newId();

beforeAll(async () => {
  ({ app, db, stop } = await makeTestApp());
  await app.ready();

  userA = await signupUser(app, "owner-a");
  userB = await signupUser(app, "owner-b");
  asA = asUser(app, userA);
  asB = asUser(app, userB);

  const category = await asA.post("/api/categories", { name: "A Only" });
  expect(category.statusCode).toBe(201);
  catA = category.json().category;

  const expense = await asA.post("/api/expenses", {
    amountMinor: 125_000,
    categoryId: catA.id,
    date: "2026-03-14",
    description: "A's lunch",
    notes: "A's notes",
  });
  expect(expense.statusCode).toBe(201);
  expA = expense.json().expense;
}, 120_000);

// `stop` is undefined if beforeAll threw; calling it would bury the real error.
afterAll(() => stop?.());

/** Every isolation answer is this exact shape — 404 with the not_found envelope. */
const expectNotFound = (r: { statusCode: number; json: () => unknown }) => {
  expect(r.statusCode).toBe(404);
  const body = r.json() as { error: { code: string } };
  expect(body.error.code).toBe("not_found");
  // Never 403: that would confirm the id exists.
  expect(r.statusCode).not.toBe(403);
};

describe("B cannot reach A's expense", () => {
  it("cannot read it — the repository scopes findById by userId", async () => {
    // design/api.md has no `GET /api/expenses/:id`, so the read is asserted at
    // the layer that actually enforces ownership. Routing it through a URL that
    // does not exist would pass on fastify's own 404 and prove nothing.
    expect(
      await expensesRepo.findById(db, userA.userId, expA.id),
    ).not.toBeNull();
    expect(await expensesRepo.findById(db, userB.userId, expA.id)).toBeNull();
  });

  it("cannot PATCH it -> 404", async () => {
    expectNotFound(
      await asB.patch(`/api/expenses/${expA.id}`, { description: "x" }),
    );

    // And the row is untouched — a 404 that still wrote would be worse than a 200.
    const [row] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, expA.id));
    expect(row?.description).toBe(expA.description);
  });

  it("cannot DELETE it -> 404, and it survives", async () => {
    expectNotFound(await asB.delete(`/api/expenses/${expA.id}`));

    const [row] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, expA.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBe(userA.userId);
  });
});

describe("B cannot reach A's category", () => {
  it("cannot use A's categoryId when creating an expense -> 404", async () => {
    expectNotFound(
      await asB.post("/api/expenses", {
        amountMinor: 5_000,
        categoryId: catA.id,
        date: "2026-03-14",
        description: "B borrowing A's category",
      }),
    );
  });

  it("cannot rename it -> 404", async () => {
    expectNotFound(
      await asB.patch(`/api/categories/${catA.id}`, {
        name: "B Owns This Now",
      }),
    );

    const stillA = await asA.get("/api/categories");
    const names = (stillA.json().items as { name: string }[]).map(
      (c) => c.name,
    );
    expect(names).toContain(catA.name);
    expect(names).not.toContain("B Owns This Now");
  });

  it("cannot archive it -> 404", async () => {
    expectNotFound(
      await asB.patch(`/api/categories/${catA.id}`, { archived: true }),
    );

    const stillA = await asA.get("/api/categories");
    const mine = (
      stillA.json().items as { id: string; archivedAt: string | null }[]
    ).find((c) => c.id === catA.id);
    expect(mine?.archivedAt).toBeNull();
  });

  // Task 11 lands `PUT /api/budgets`. Written now rather than left as a comment
  // so unskipping is the whole of the change; a TODO would have to be rewritten
  // from scratch, which is how an isolation case quietly never gets one.
  it.skip("cannot PUT a budget on it -> 404 (unskip in Task 11)", async () => {
    const r = await asB.put("/api/budgets", {
      categoryId: catA.id,
      month: "2026-03",
      amountMinor: 500_000,
    });
    expectNotFound(r);
  });
});

describe("lists are scoped, never filtered client-side", () => {
  it("B's expense list never contains A's rows", async () => {
    const r = await asB.get("/api/expenses");

    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string }[];
    expect(items.map((e) => e.id)).not.toContain(expA.id);
    // B has created none, so the only correct answer is none at all.
    expect(items).toHaveLength(0);
  });

  it("B's category list never contains A's categories", async () => {
    const r = await asB.get("/api/categories");

    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string; name: string }[];
    expect(items.map((c) => c.id)).not.toContain(catA.id);
    expect(items.map((c) => c.name)).not.toContain(catA.name);
    // B still has its own seed set — the list is scoped, not empty by accident.
    expect(items).toHaveLength(8);
  });
});

/**
 * The empty case is where an unscoped query gives itself away. A `WHERE` that
 * forgot `user_id` still looks right for a user who owns rows — it returns
 * theirs plus everyone else's, and a test asserting "contains mine" passes. For
 * a user who owns nothing, the correct answer is `[]` and the unscoped answer is
 * the entire table, so this is the assertion the bug cannot survive.
 */
describe("a repository query for a user that owns nothing returns empty", () => {
  it("expensesRepo.list returns [] for a user id with no rows, while A's row exists", async () => {
    expect(await expensesRepo.list(db, userA.userId)).toHaveLength(1);

    // A real signed-up user with categories but no expenses...
    expect(await expensesRepo.list(db, userB.userId)).toEqual([]);
    // ...and an id that is not a user at all. No throw, no rows.
    expect(await expensesRepo.list(db, NOWHERE_ID)).toEqual([]);
  });

  it("categoriesRepo.listAll returns [] for a user id that owns nothing", async () => {
    expect(
      (await categoriesRepo.listAll(db, userA.userId)).length,
    ).toBeGreaterThan(0);
    expect(await categoriesRepo.listAll(db, NOWHERE_ID)).toEqual([]);
  });
});

/**
 * The status code alone is not the whole promise. If "not yours" and "not there"
 * differ in the message, in `details`, in key order — in any byte — the pair of
 * responses is still an existence oracle, and a client can enumerate ids by
 * diffing them.
 */
describe("the 404 for another user's id is indistinguishable from a 404 for no id", () => {
  it("PATCH /api/expenses/:id", async () => {
    const othersRow = await asB.patch(`/api/expenses/${expA.id}`, {
      description: "x",
    });
    const noRow = await asB.patch(`/api/expenses/${NOWHERE_ID}`, {
      description: "x",
    });

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
  });

  it("DELETE /api/expenses/:id", async () => {
    const othersRow = await asB.delete(`/api/expenses/${expA.id}`);
    const noRow = await asB.delete(`/api/expenses/${NOWHERE_ID}`);

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
  });

  it("PATCH /api/categories/:id", async () => {
    const othersRow = await asB.patch(`/api/categories/${catA.id}`, {
      name: "Renamed",
    });
    const noRow = await asB.patch(`/api/categories/${NOWHERE_ID}`, {
      name: "Renamed",
    });

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
  });

  it("POST /api/expenses with another user's categoryId", async () => {
    const body = {
      amountMinor: 5_000,
      date: "2026-03-14",
      description: "probe",
    };
    const othersRow = await asB.post("/api/expenses", {
      ...body,
      categoryId: catA.id,
    });
    const noRow = await asB.post("/api/expenses", {
      ...body,
      categoryId: NOWHERE_ID,
    });

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
  });
});
