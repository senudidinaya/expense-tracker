import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 9, Step 1 — filtered, keyset-paginated expense list with first-page totals.
 *
 * Two properties drive nearly every test here.
 *
 * The first is why the cursor exists at all. `OFFSET n` counts rows at read
 * time, so a row inserted or removed ahead of the window shifts every later
 * page: the walker sees a row twice, or never sees it. A keyset cursor names a
 * *position* in the sort — "everything after (date, id)" — which no concurrent
 * write can move. "keyset stability" below proves that difference rather than
 * assuming it.
 *
 * The second is that a position is not a permission. The cursor is base64url
 * JSON on purpose, so a client can decode and edit it; the repository still
 * puts `user_id` in the WHERE. That is the one place keyset pagination could
 * leak across users, so it is tested from the outside, with a cursor this file
 * forges by hand rather than one the server issued.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;

interface ExpenseDto {
  id: string;
  categoryId: string;
  amountMinor: number;
  date: string;
  description: string;
  notes: string | null;
}

interface ListBody {
  items: ExpenseDto[];
  nextCursor: string | null;
  totalCount?: number;
  totalAmountMinor?: number;
}

interface Actor {
  api: ReturnType<typeof asUser>;
  categoryId: (name: string) => string;
}

/**
 * A signed-up user with their seeded categories resolved. Every describe block
 * takes its own: signup seeds the eight default categories per user, so a fresh
 * actor is a fresh, empty expense list — which is what lets these suites assert
 * on whole responses instead of filtering someone else's rows out first.
 */
async function actor(label: string): Promise<Actor> {
  const api = asUser(app, await signupUser(app, label));
  const cats = (await api.get("/api/categories")).json().items as {
    id: string;
    name: string;
  }[];
  return {
    api,
    categoryId: (name) => {
      const found = cats.find((c) => c.name === name);
      if (!found) throw new Error(`no seeded category named "${name}"`);
      return found.id;
    },
  };
}

interface SeedRow {
  date: string;
  amountMinor?: number;
  description?: string;
  category?: string;
}

/** Creates one expense and returns it, failing loudly rather than returning junk. */
async function add(a: Actor, row: SeedRow): Promise<ExpenseDto> {
  const r = await a.api.post("/api/expenses", {
    date: row.date,
    amountMinor: row.amountMinor ?? 1_000,
    description: row.description ?? `expense on ${row.date}`,
    categoryId: a.categoryId(row.category ?? "Food"),
  });
  if (r.statusCode !== 201) {
    throw new Error(`seeding ${row.date} -> ${r.statusCode} ${r.body}`);
  }
  return r.json().expense as ExpenseDto;
}

/** Sequential on purpose: ids are UUIDv7, so creation order is the id tiebreak. */
async function seed(a: Actor, rows: SeedRow[]): Promise<ExpenseDto[]> {
  const created: ExpenseDto[] = [];
  for (const row of rows) created.push(await add(a, row));
  return created;
}

async function list(a: Actor, query = ""): Promise<ListBody> {
  const r = await a.api.get(`/api/expenses${query}`);
  if (r.statusCode !== 200) {
    throw new Error(`list "${query}" -> ${r.statusCode} ${r.body}`);
  }
  return r.json() as ListBody;
}

const withCursor = (query: string, cursor: string) =>
  `${query}${query.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;

/**
 * Follows `nextCursor` to exhaustion, returning every page it saw. `from`
 * resumes a walk already in progress rather than starting a new one.
 */
async function walk(
  a: Actor,
  query: string,
  from: string | null = null,
): Promise<ListBody[]> {
  const pages: ListBody[] = [];
  let cursor: string | null = from;
  do {
    const page: ListBody = await list(
      a,
      cursor === null ? query : withCursor(query, cursor),
    );
    pages.push(page);
    cursor = page.nextCursor;
    if (pages.length > 20) throw new Error("page walk did not terminate");
  } while (cursor !== null);
  return pages;
}

const ids = (items: ExpenseDto[]) => items.map((e) => e.id);

/**
 * A cursor built the way a curious client would: decode the base64url, edit the
 * JSON, re-encode. Deliberately not `encodeCursor` from `src/lib/cursor.ts` —
 * the point of the isolation test is that an *outsider* can mint any position
 * they like without the server's help.
 */
const forgeCursor = (position: { date: string; id: string }): string =>
  Buffer.from(JSON.stringify(position), "utf8").toString("base64url");

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();
}, 120_000);

afterAll(() => stop?.());

describe("GET /api/expenses", () => {
  it("401s without a session", async () => {
    const r = await app.inject({ method: "GET", url: "/api/expenses" });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });
});

describe("ordering and the page walk", () => {
  let a: Actor;
  let all: ExpenseDto[];

  beforeAll(async () => {
    a = await actor("list-pager");
    // Seeded in ascending date order, so "newest first" is a real reordering
    // rather than insertion order handed back unchanged.
    all = await seed(
      a,
      ["01", "02", "03", "04", "05", "06"].map((d) => ({
        date: `2025-01-${d}`,
      })),
    );
  }, 60_000);

  it("orders date DESC, id DESC", async () => {
    const { items } = await list(a);
    expect(items.map((e) => e.date)).toEqual([
      "2025-01-06",
      "2025-01-05",
      "2025-01-04",
      "2025-01-03",
      "2025-01-02",
      "2025-01-01",
    ]);
  });

  it("walks 3 pages of 2 with no duplicates and no gaps", async () => {
    const pages = await walk(a, "?limit=2");

    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.items.length)).toEqual([2, 2, 2]);
    // The last page ends the walk: there is no seventh row to point at.
    expect(pages[2]!.nextCursor).toBeNull();

    const walked = pages.flatMap((p) => ids(p.items));
    expect(new Set(walked).size).toBe(walked.length); // no duplicates
    expect(walked).toEqual(ids(all).reverse()); // no gaps, and still newest-first
  });
});

describe("same-date rows", () => {
  let a: Actor;
  let all: ExpenseDto[];

  beforeAll(async () => {
    a = await actor("list-sameday");
    // Five rows sharing one date: `date` alone cannot order them, so the walk
    // only terminates correctly if `id` is a real part of the sort key.
    all = await seed(
      a,
      [1, 2, 3, 4, 5].map((n) => ({
        date: "2025-04-09",
        description: `same-day ${n}`,
      })),
    );
  }, 60_000);

  it("paginate stably by the id tiebreak", async () => {
    const pages = await walk(a, "?limit=2");
    const walked = pages.flatMap((p) => ids(p.items));

    expect(new Set(walked).size).toBe(5);
    // ids are UUIDv7, so creation order is id order; newest-first reverses it.
    expect(walked).toEqual(ids(all).reverse());
  });
});

describe("first-page totals", () => {
  let a: Actor;
  let food: string;

  beforeAll(async () => {
    a = await actor("list-totals");
    food = a.categoryId("Food");
    // Seven rows against a page of three, so a total that merely summed the
    // returned page would be visibly wrong rather than coincidentally right.
    await seed(a, [
      { date: "2025-02-01", amountMinor: 100 },
      { date: "2025-02-02", amountMinor: 200 },
      { date: "2025-02-03", amountMinor: 300 },
      { date: "2025-02-04", amountMinor: 400 },
      { date: "2025-02-05", amountMinor: 500 },
      { date: "2025-02-06", amountMinor: 600 },
      { date: "2025-02-07", amountMinor: 700, category: "Transport" },
    ]);
  }, 60_000);

  it("covers every matching row, not just the page", async () => {
    const page = await list(a, "?limit=3");

    expect(page.items).toHaveLength(3);
    expect(page.totalCount).toBe(7);
    expect(page.totalAmountMinor).toBe(2_800);

    // The distinction that assertion is drawing: summing the returned page
    // gives 700+600+500 = 1800, which is what a JS-side total would report.
    const pageSum = page.items.reduce((s, e) => s + e.amountMinor, 0);
    expect(pageSum).toBe(1_800);
    expect(page.totalAmountMinor).not.toBe(pageSum);
  });

  it("applies the same filters as the items", async () => {
    const page = await list(a, `?categoryIds=${food}`);
    expect(page.totalCount).toBe(6);
    expect(page.totalAmountMinor).toBe(2_100);
  });

  it("is 0 / 0 when nothing matches, never absent", async () => {
    const page = await list(a, "?from=2030-01-01&to=2030-12-31");
    expect(page.items).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.totalAmountMinor).toBe(0);
  });

  /**
   * The per-row cap is 2^53 - 1 — the largest integer a JSON number carries
   * exactly — but nothing caps a *sum* of legal rows, and two of them at the
   * ceiling already exceed it. Rounding the total would be exactly the lossy
   * money the integer-minor-units rule exists to prevent, and a 500 would be a
   * lie about whose fault it is, so the amount is omitted while `totalCount`,
   * which cannot overflow, still comes back.
   *
   * Unreachable with real spending (2^53 minor units is ~90 trillion rupees),
   * but it is the boundary the contract actually permits.
   */
  it("omits an amount total that cannot be represented exactly", async () => {
    const big = await actor("list-totals-overflow");
    const ceiling = 9_007_199_254_740_991;
    await seed(big, [
      { date: "2025-02-01", amountMinor: ceiling },
      { date: "2025-02-02", amountMinor: ceiling },
    ]);

    const page = await list(big);
    expect(page.items).toHaveLength(2);
    expect(page.totalCount).toBe(2);
    expect(page.totalAmountMinor).toBeUndefined();
  }, 60_000);

  it("is omitted on cursor pages", async () => {
    const first = await list(a, "?limit=3");
    expect(first.nextCursor).not.toBeNull();

    const second = await list(a, withCursor("?limit=3", first.nextCursor!));
    expect(second.items).toHaveLength(3);
    expect(second.totalCount).toBeUndefined();
    expect(second.totalAmountMinor).toBeUndefined();
  });
});

describe("filters", () => {
  let a: Actor;
  let food: string;
  let transport: string;

  beforeAll(async () => {
    a = await actor("list-filters");
    food = a.categoryId("Food");
    transport = a.categoryId("Transport");
    await seed(a, [
      { date: "2025-03-01", description: "Coffee before the train" },
      { date: "2025-03-10", description: "Coffee and a bun" },
      {
        date: "2025-03-11",
        description: "Train ticket",
        category: "Transport",
      },
      {
        date: "2025-03-12",
        description: "COFFEE, large",
        category: "Transport",
      },
      { date: "2025-03-15", description: "Rice and curry" },
      { date: "2025-03-20", description: "Coffee much later" },
    ]);
  }, 60_000);

  it("filters by from/to inclusively", async () => {
    const { items } = await list(a, "?from=2025-03-10&to=2025-03-12");
    expect(items.map((e) => e.date)).toEqual([
      "2025-03-12",
      "2025-03-11",
      "2025-03-10",
    ]);
  });

  it("filters by categoryIds, comma separated", async () => {
    const { items } = await list(a, `?categoryIds=${transport}`);
    expect(items.map((e) => e.description)).toEqual([
      "COFFEE, large",
      "Train ticket",
    ]);

    const both = await list(a, `?categoryIds=${food},${transport}`);
    expect(both.items).toHaveLength(6);
  });

  it("matches q case-insensitively against description", async () => {
    const { items } = await list(a, "?q=coffee");
    expect(items.map((e) => e.description)).toEqual([
      "Coffee much later",
      "COFFEE, large",
      "Coffee and a bun",
      "Coffee before the train",
    ]);
  });

  it("matches q as a substring anywhere in the description", async () => {
    const { items } = await list(a, "?q=curry");
    expect(items.map((e) => e.description)).toEqual(["Rice and curry"]);
  });

  it("treats % in q as a literal character, not a wildcard", async () => {
    // Unescaped, `%` would make the pattern `%%%` and match every row.
    const { items } = await list(a, `?q=${encodeURIComponent("%")}`);
    expect(items).toEqual([]);
  });

  it("composes from + to + categoryIds + q", async () => {
    const { items } = await list(
      a,
      `?from=2025-03-01&to=2025-03-11&categoryIds=${food},${transport}&q=coffee`,
    );
    // In range and matching q: 03-01 and 03-10. 03-11 is in range but does not
    // match q; 03-12 and 03-20 are out of range.
    expect(items.map((e) => e.date)).toEqual(["2025-03-10", "2025-03-01"]);
  });

  it("400s on a q longer than 100 characters", async () => {
    const r = await a.api.get(`/api/expenses?q=${"x".repeat(101)}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("400s on a limit above 100", async () => {
    const r = await a.api.get("/api/expenses?limit=101");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("400s on a categoryIds entry that is not a uuid", async () => {
    const r = await a.api.get(`/api/expenses?categoryIds=${food},nope`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });
});

describe("cursor handling", () => {
  it("400s on a cursor that is not a valid position", async () => {
    const a = await actor("list-badcursor");
    const r = await a.api.get("/api/expenses?cursor=not-a-cursor");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  }, 60_000);

  /**
   * The cursor is client-readable by design, so the only thing standing between
   * a forged cursor and another user's rows is the `user_id` in the WHERE. A
   * cursor is a position, not an authorization.
   */
  it("returns only the caller's rows when the cursor names another user's row", async () => {
    const owner = await actor("list-owner");
    const attacker = await actor("list-attacker");

    const ownerRows = await seed(owner, [
      { date: "2025-07-10", description: "owner low" },
      { date: "2025-07-12", description: "owner high" },
    ]);
    const attackerRows = await seed(attacker, [
      { date: "2025-07-01", description: "attacker one" },
      { date: "2025-07-02", description: "attacker two" },
    ]);

    const ownerLow = ownerRows[0]!;
    const ownerHigh = ownerRows[1]!;
    // Positioned at the owner's newest row, so a query that honoured the cursor
    // but forgot the user filter would hand back `owner low` — it sorts below.
    const forged = forgeCursor({ date: ownerHigh.date, id: ownerHigh.id });

    const r = await attacker.api.get(withCursor("/api/expenses", forged));
    expect(r.statusCode).toBe(200);

    const body = r.json() as ListBody;
    expect(ids(body.items).sort()).toEqual(ids(attackerRows).sort());
    expect(ids(body.items)).not.toContain(ownerLow.id);
    expect(ids(body.items)).not.toContain(ownerHigh.id);

    // And the owner's own list is untouched by any of it.
    const ownerList = await list(owner);
    expect(ids(ownerList.items).sort()).toEqual(ids(ownerRows).sort());
  }, 60_000);
});

/**
 * The property `OFFSET` does not have. Both tests start a page walk, write a
 * row mid-walk, then ask for page 2 with the cursor page 1 handed back.
 */
describe("keyset stability under concurrent writes", () => {
  it("shows a row inserted between page 1 and page 2 exactly once, skipping nothing", async () => {
    const a = await actor("list-insert-between");
    const before = await seed(a, [
      { date: "2025-05-01", description: "may 1" },
      { date: "2025-05-02", description: "may 2" },
      { date: "2025-05-04", description: "may 4" },
      { date: "2025-05-05", description: "may 5" },
    ]);

    const page1 = await list(a, "?limit=2");
    expect(page1.items.map((e) => e.date)).toEqual([
      "2025-05-05",
      "2025-05-04",
    ]);

    const inserted = await add(a, { date: "2025-05-03", description: "may 3" });

    const rest = await walk(a, "?limit=2", page1.nextCursor);
    const walked = [...ids(page1.items), ...rest.flatMap((p) => ids(p.items))];

    expect(new Set(walked).size).toBe(walked.length); // seen at most once
    expect(walked).toContain(inserted.id); // and not skipped
    expect(walked.sort()).toEqual([...ids(before), inserted.id].sort());
  }, 60_000);

  it("does not shift the page window when a row is inserted ahead of the cursor", async () => {
    // The case OFFSET gets wrong: with `OFFSET 2` a new row at the top pushes
    // everything down one, and page 2 repeats the last row of page 1. The
    // keyset cursor names a fixed position, so the window cannot move.
    const a = await actor("list-insert-ahead");
    await seed(a, [
      { date: "2025-06-01", description: "june 1" },
      { date: "2025-06-02", description: "june 2" },
      { date: "2025-06-03", description: "june 3" },
      { date: "2025-06-04", description: "june 4" },
    ]);

    const page1 = await list(a, "?limit=2");
    expect(page1.items.map((e) => e.date)).toEqual([
      "2025-06-04",
      "2025-06-03",
    ]);

    await add(a, { date: "2025-06-09", description: "june 9, inserted late" });

    const page2 = await list(a, withCursor("?limit=2", page1.nextCursor!));

    expect(page2.items.map((e) => e.date)).toEqual([
      "2025-06-02",
      "2025-06-01",
    ]);
    expect(ids(page2.items)).not.toContain(page1.items[1]!.id);
  }, 60_000);
});
