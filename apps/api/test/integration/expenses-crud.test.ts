import { plusOneYear, todayIsoDate } from "@expense/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 8, Step 2 — expenses CRUD.
 *
 * The money rule is the one worth stating out loud: `amountMinor` is an integer
 * count of minor units, so 10.5 is not "nearly right", it is a different type of
 * value and the server rejects it rather than rounding. `Math.round(x * 100)`
 * here would be the bug, not the fix — by the time a float arrives it is already
 * lossy.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;
let api: ReturnType<typeof asUser>;
let foodId: string;

interface ExpenseDto {
  id: string;
  categoryId: string;
  recurringRuleId: string | null;
  amountMinor: number;
  currency: string;
  date: string;
  description: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Adds a day to a `YYYY-MM-DD` string, in UTC. */
const dayAfter = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const A_VALID_EXPENSE = () => ({
  amountMinor: 125_000,
  categoryId: foodId,
  date: todayIsoDate(),
  description: "Lunch at the canteen",
});

async function create(
  overrides: Record<string, unknown> = {},
): Promise<ExpenseDto> {
  const r = await api.post("/api/expenses", {
    ...A_VALID_EXPENSE(),
    ...overrides,
  });
  if (r.statusCode !== 201) {
    throw new Error(`create -> ${r.statusCode} ${r.body}`);
  }
  return r.json().expense as ExpenseDto;
}

/** Creates an archived category and returns its id. */
async function archivedCategory(name: string): Promise<string> {
  const created = await api.post("/api/categories", { name });
  const { id } = created.json().category as { id: string };
  const archived = await api.patch(`/api/categories/${id}`, { archived: true });
  expect(archived.statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();

  api = asUser(app, await signupUser(app, "spender"));

  const categories = (await api.get("/api/categories")).json().items as {
    id: string;
    name: string;
  }[];
  foodId = categories.find((c) => c.name === "Food")!.id;
}, 120_000);

afterAll(() => stop?.());

describe("POST /api/expenses", () => {
  it("401s without a session", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/expenses",
      payload: A_VALID_EXPENSE(),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("201s echoing the dto, with the server-derived fields filled in", async () => {
    const body = { ...A_VALID_EXPENSE(), notes: "with a colleague" };
    const r = await api.post("/api/expenses", body);

    expect(r.statusCode).toBe(201);
    const { expense } = r.json();
    expect(expense).toMatchObject({
      amountMinor: body.amountMinor,
      categoryId: body.categoryId,
      date: body.date,
      description: body.description,
      notes: body.notes,
      currency: "LKR",
      recurringRuleId: null,
    });
    expect(typeof expense.id).toBe("string");
    expect(Object.keys(expense).sort()).toEqual([
      "amountMinor",
      "categoryId",
      "createdAt",
      "currency",
      "date",
      "description",
      "id",
      "notes",
      "recurringRuleId",
      "updatedAt",
    ]);
  });

  it("stores notes as null when omitted", async () => {
    const expense = await create();
    expect(expense.notes).toBeNull();
  });

  it("keeps the amount an exact integer across the round trip", async () => {
    // 2^53 - 1 is the ceiling the wire contract stops at; a float would have
    // rounded this long before it got here.
    const expense = await create({ amountMinor: 9_007_199_254_740_991 });
    expect(expense.amountMinor).toBe(9_007_199_254_740_991);

    const listed = (await api.get("/api/expenses")).json()
      .items as ExpenseDto[];
    expect(listed.find((e) => e.id === expense.id)?.amountMinor).toBe(
      9_007_199_254_740_991,
    );
  });

  it("400s on a non-integer, zero, or negative amount", async () => {
    for (const amountMinor of [10.5, 0, -5]) {
      const r = await api.post("/api/expenses", {
        ...A_VALID_EXPENSE(),
        amountMinor,
      });
      expect(r.statusCode, `amountMinor: ${amountMinor}`).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });

  it("400s on an amount sent as a decimal string", async () => {
    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      amountMinor: "1250.00",
    });
    expect(r.statusCode).toBe(400);
  });

  it("allows a date exactly one year ahead and 400s one day past it", async () => {
    const boundary = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      date: plusOneYear(),
    });
    expect(boundary.statusCode).toBe(201);

    const tooFar = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      date: dayAfter(plusOneYear()),
    });
    expect(tooFar.statusCode).toBe(400);
    expect(tooFar.json().error.code).toBe("validation_failed");
  });

  it("400s on a date the calendar does not have", async () => {
    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      date: "2026-02-31",
    });
    expect(r.statusCode).toBe(400);
  });

  it("400s on an empty description", async () => {
    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      description: "",
    });
    expect(r.statusCode).toBe(400);
  });

  it("400s when the category is archived", async () => {
    const id = await archivedCategory("Retired");

    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      categoryId: id,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("404s when the category does not exist", async () => {
    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      categoryId: "0195f3aa-0000-7000-8000-000000000000",
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });

  it("ignores client-supplied server-derived fields rather than accepting them", async () => {
    const r = await api.post("/api/expenses", {
      ...A_VALID_EXPENSE(),
      id: "0195f3aa-0000-7000-8000-000000000001",
      userId: "0195f3aa-0000-7000-8000-000000000002",
      currency: "USD",
      recurringRuleId: "0195f3aa-0000-7000-8000-000000000003",
    });

    expect(r.statusCode).toBe(201);
    const { expense } = r.json();
    expect(expense.id).not.toBe("0195f3aa-0000-7000-8000-000000000001");
    expect(expense.currency).toBe("LKR");
    expect(expense.recurringRuleId).toBeNull();
  });
});

describe("PATCH /api/expenses/:id", () => {
  it("applies a partial change and leaves the rest alone", async () => {
    const created = await create({ notes: "original notes" });

    const r = await api.patch(`/api/expenses/${created.id}`, {
      description: "Dinner instead",
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().expense).toMatchObject({
      id: created.id,
      description: "Dinner instead",
      amountMinor: created.amountMinor,
      date: created.date,
      notes: "original notes",
      categoryId: created.categoryId,
    });
  });

  it("advances updatedAt but not createdAt", async () => {
    const created = await create();

    const r = await api.patch(`/api/expenses/${created.id}`, {
      amountMinor: 999,
    });
    const patched = r.json().expense as ExpenseDto;

    expect(patched.createdAt).toBe(created.createdAt);
    expect(new Date(patched.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.updatedAt).getTime(),
    );
    expect(patched.amountMinor).toBe(999);
  });

  it("moves the expense to another of the user's categories", async () => {
    const created = await create();
    const target = (await api.post("/api/categories", { name: "Moved" })).json()
      .category.id as string;

    const r = await api.patch(`/api/expenses/${created.id}`, {
      categoryId: target,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().expense.categoryId).toBe(target);
  });

  it("400s when moving to an archived category", async () => {
    const created = await create();
    const id = await archivedCategory("Retired Too");

    const r = await api.patch(`/api/expenses/${created.id}`, {
      categoryId: id,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("400s on an invalid amount", async () => {
    const created = await create();
    const r = await api.patch(`/api/expenses/${created.id}`, {
      amountMinor: 10.5,
    });
    expect(r.statusCode).toBe(400);
  });

  it("404s on an id that is not an expense of this user", async () => {
    const r = await api.patch(
      "/api/expenses/0195f3aa-0000-7000-8000-000000000000",
      { description: "Nope" },
    );
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });
});

describe("DELETE /api/expenses/:id", () => {
  it("204s with no body, and the row is gone", async () => {
    const created = await create();

    const r = await api.delete(`/api/expenses/${created.id}`);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe("");

    const listed = (await api.get("/api/expenses")).json()
      .items as ExpenseDto[];
    expect(listed.map((e) => e.id)).not.toContain(created.id);
    // And a second delete is a 404, not a second success.
    expect((await api.delete(`/api/expenses/${created.id}`)).statusCode).toBe(
      404,
    );
  });

  it("404s on an id that is not an expense of this user", async () => {
    const r = await api.delete(
      "/api/expenses/0195f3aa-0000-7000-8000-000000000000",
    );
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });
});
