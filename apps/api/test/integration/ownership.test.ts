import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expenses, recurringRules } from "../../src/db/schema.js";
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

  // Written in Task 8, before `PUT /api/budgets` existed, so that unskipping it
  // in Task 11 was the whole of the change; a TODO would have to be rewritten
  // from scratch, which is how an isolation case quietly never gets one.
  it("cannot PUT a budget on it -> 404", async () => {
    const r = await asB.put("/api/budgets", {
      categoryId: catA.id,
      month: "2026-03",
      amountMinor: 500_000,
    });
    expectNotFound(r);
  });
});

describe("B cannot reach A's recurring rule", () => {
  // Task 13. Created in this describe's own beforeAll — not the file's — so
  // the suites for resources that already exist keep passing while these are
  // still red.
  let ruleA: { id: string; description: string };

  beforeAll(async () => {
    const r = await asA.post("/api/recurring-rules", {
      categoryId: catA.id,
      amountMinor: 250_000,
      description: "A's subscription",
      frequency: "monthly",
      startDate: "2026-01-15",
    });
    expect(r.statusCode).toBe(201);
    ruleA = r.json().rule;
  });

  it("cannot PATCH it -> 404, and the row is untouched", async () => {
    expectNotFound(
      await asB.patch(`/api/recurring-rules/${ruleA.id}`, {
        description: "x",
      }),
    );

    const [row] = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, ruleA.id));
    expect(row?.description).toBe(ruleA.description);
  });

  it("cannot DELETE it -> 404, and it survives", async () => {
    // A throwaway rule of A's, not `ruleA`: if an unscoped delete ever
    // succeeds here, it must not also destroy the fixture the list test below
    // asserts against — that would let the list case pass vacuously exactly
    // when it is needed most.
    const created = await asA.post("/api/recurring-rules", {
      categoryId: catA.id,
      amountMinor: 100_000,
      description: "A's deletable decoy",
      frequency: "weekly",
      startDate: "2026-02-02",
    });
    expect(created.statusCode).toBe(201);
    const throwaway = created.json().rule as { id: string };

    expectNotFound(await asB.delete(`/api/recurring-rules/${throwaway.id}`));

    const [row] = await db
      .select()
      .from(recurringRules)
      .where(eq(recurringRules.id, throwaway.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBe(userA.userId);
  });

  it("cannot use A's categoryId when creating a rule -> 404", async () => {
    expectNotFound(
      await asB.post("/api/recurring-rules", {
        categoryId: catA.id,
        amountMinor: 5_000,
        description: "B borrowing A's category",
        frequency: "weekly",
        startDate: "2026-01-15",
      }),
    );
  });

  it("B's rule list never contains A's rules", async () => {
    const r = await asB.get("/api/recurring-rules");

    expect(r.statusCode).toBe(200);
    const items = r.json().items as { id: string }[];
    expect(items.map((rule) => rule.id)).not.toContain(ruleA.id);
    // B has created none, so the only correct answer is none at all.
    expect(items).toHaveLength(0);
  });

  it("the 404 for A's rule id is indistinguishable from a 404 for no id", async () => {
    const patchOthers = await asB.patch(`/api/recurring-rules/${ruleA.id}`, {
      description: "x",
    });
    const patchNoRow = await asB.patch(`/api/recurring-rules/${NOWHERE_ID}`, {
      description: "x",
    });
    expect(patchOthers.statusCode).toBe(404);
    expect(patchNoRow.statusCode).toBe(404);
    expect(patchNoRow.body).toBe(patchOthers.body);

    const deleteOthers = await asB.delete(`/api/recurring-rules/${ruleA.id}`);
    const deleteNoRow = await asB.delete(`/api/recurring-rules/${NOWHERE_ID}`);
    expect(deleteOthers.statusCode).toBe(404);
    expect(deleteNoRow.statusCode).toBe(404);
    expect(deleteNoRow.body).toBe(deleteOthers.body);
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

/** `expensesRepo.list` with no filters and the default page size. */
const listAll = (userId: string) =>
  expensesRepo.list(db, userId, { limit: 50 });

/**
 * The empty case is where an unscoped query gives itself away. A `WHERE` that
 * forgot `user_id` still looks right for a user who owns rows — it returns
 * theirs plus everyone else's, and a test asserting "contains mine" passes. For
 * a user who owns nothing, the correct answer is `[]` and the unscoped answer is
 * the entire table, so this is the assertion the bug cannot survive.
 */
describe("a repository query for a user that owns nothing returns empty", () => {
  it("expensesRepo.list returns [] for a user id with no rows, while A's row exists", async () => {
    // `list` pages, so the rows are under `items`; the page size is irrelevant
    // to what this asserts, which is who the rows belong to.
    expect((await listAll(userA.userId)).items).toHaveLength(1);

    // A real signed-up user with categories but no expenses...
    expect((await listAll(userB.userId)).items).toEqual([]);
    // ...and an id that is not a user at all. No throw, no rows.
    expect((await listAll(NOWHERE_ID)).items).toEqual([]);
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

  it("PUT /api/budgets with another user's categoryId", async () => {
    // A budget row points at a category, so the same oracle is available here:
    // if "not yours" and "not there" differ, PUT becomes a way to test whether
    // a category id exists without owning it.
    const body = { month: "2026-03", amountMinor: 500_000 };
    const othersRow = await asB.put("/api/budgets", {
      ...body,
      categoryId: catA.id,
    });
    const noRow = await asB.put("/api/budgets", {
      ...body,
      categoryId: NOWHERE_ID,
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
