import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_BATCH_SIZE } from "../../src/repos/expenses.js";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 10, Step 1 — `GET /api/expenses/export.csv`.
 *
 * The export is the list in another format, and every property tested here is
 * one of the list's properties restated at a second endpoint: the same filters,
 * the same ownership boundary, the same money. A CSV writer is exactly the kind
 * of code that quietly grows its own copy of a WHERE clause, so the row count
 * is pinned against `totalCount` from `GET /api/expenses` rather than against a
 * number this file counted by hand — the two answers cannot drift apart without
 * a test going red.
 *
 * The bytes matter too, and they are checked as bytes: the BOM is asserted as
 * `EF BB BF` on the raw payload, not as a U+FEFF on a decoded string, because
 * the whole point of the BOM is what Excel finds in the file.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;

const HEADER = "date,category,description,notes,amount,currency";

interface Actor {
  api: ReturnType<typeof asUser>;
  categoryId: (name: string) => string;
}

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
  notes?: string;
  category?: string;
}

async function seed(a: Actor, rows: SeedRow[]): Promise<void> {
  for (const row of rows) {
    const payload: Record<string, unknown> = {
      date: row.date,
      amountMinor: row.amountMinor ?? 1_000,
      description: row.description ?? `expense on ${row.date}`,
      categoryId: a.categoryId(row.category ?? "Food"),
    };
    if (row.notes !== undefined) payload.notes = row.notes;

    const r = await a.api.post("/api/expenses", payload);
    if (r.statusCode !== 201) {
      throw new Error(`seeding ${row.date} -> ${r.statusCode} ${r.body}`);
    }
  }
}

const exportCsv = (a: Actor, query = ""): Promise<LightMyRequestResponse> =>
  a.api.get(`/api/expenses/export.csv${query}`);

/** U+FEFF, spelled out: a literal BOM in a source file is invisible to a reader. */
const BOM = String.fromCharCode(0xfeff);

/** The decoded body with the BOM removed, so assertions are about the rows. */
function body(r: LightMyRequestResponse): string {
  if (r.statusCode !== 200) throw new Error(`export -> ${r.statusCode}`);
  const text = r.rawPayload.toString("utf8");
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Rows as fields. A deliberately small parser: it handles quoting because the
 * data under test is quoted, and it would rather throw than guess, so a
 * malformed export fails here instead of silently producing plausible rows.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (c === '"') {
      if (field !== "") throw new Error(`quote inside an unquoted field: ${c}`);
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else if (c === "\n" || c === "\r") {
      throw new Error("a bare LF or CR outside a quoted field is not RFC 4180");
    } else field += c;
  }
  if (quoted) throw new Error("unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Data rows only — the header is asserted separately, once. */
const dataRows = (r: LightMyRequestResponse): string[][] =>
  parseCsv(body(r)).slice(1);

const descriptions = (rows: string[][]) => rows.map((row) => row[2]);

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();
}, 120_000);

afterAll(() => stop?.());

describe("GET /api/expenses/export.csv", () => {
  it("401s without a session", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/expenses/export.csv",
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("400s on a filter the list would also reject", async () => {
    const a = await actor("export-badfilter");
    const r = await exportCsv(a, "?from=not-a-date");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  }, 60_000);
});

describe("the file itself", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("export-file");
    await seed(a, [
      { date: "2025-01-02", amountMinor: 125_000, description: "Rent share" },
      {
        date: "2025-01-05",
        amountMinor: 5,
        description: "Rounding test",
        notes: "one cent",
        category: "Transport",
      },
    ]);
  }, 60_000);

  it("starts with a UTF-8 BOM", async () => {
    // As bytes: Excel opens a BOM-less UTF-8 CSV in the system codepage and
    // renders every non-ASCII description as mojibake.
    const raw = (await exportCsv(a)).rawPayload;
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("is served as a text/csv attachment named expenses.csv", async () => {
    const r = await exportCsv(a);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/csv(;|$)/);
    expect(r.headers["content-type"]).toMatch(/charset=utf-8/i);
    expect(r.headers["content-disposition"]).toBe(
      'attachment; filename="expenses.csv"',
    );
  });

  it("has the header row from design/api.md", async () => {
    expect(body(await exportCsv(a)).split("\r\n")[0]).toBe(HEADER);
  });

  it("separates rows with CRLF", async () => {
    // RFC 4180 says CRLF, and a bare LF is what Excel on Windows mis-parses.
    const text = body(await exportCsv(a));
    expect(text).toContain("\r\n");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("writes the category name, not its id", async () => {
    const rows = dataRows(await exportCsv(a));
    expect(rows.map((row) => row[1])).toEqual(["Transport", "Food"]);
  });

  it("writes amounts as exact decimal strings and the currency", async () => {
    const rows = dataRows(await exportCsv(a));
    expect(rows.map((row) => [row[4], row[5]])).toEqual([
      ["0.05", "LKR"],
      ["1250.00", "LKR"],
    ]);
  });

  it("writes an empty notes field rather than the word null", async () => {
    const rows = dataRows(await exportCsv(a));
    expect(rows.map((row) => row[3])).toEqual(["one cent", ""]);
  });

  it("orders rows newest first, like the list", async () => {
    const rows = dataRows(await exportCsv(a));
    expect(rows.map((row) => row[0])).toEqual(["2025-01-05", "2025-01-02"]);
  });

  it("is just the header when nothing matches", async () => {
    const r = await exportCsv(a, "?from=2030-01-01&to=2030-12-31");
    expect(r.statusCode).toBe(200);
    expect(body(r)).toBe(`${HEADER}\r\n`);
  });
});

describe("RFC 4180 quoting of real data", () => {
  it("quotes commas, quotes and newlines that came from the user", async () => {
    const a = await actor("export-quoting");
    // Renamed so the escaping is exercised on a category name too — that column
    // is a join result, and it is as user-controlled as the description is.
    const rename = await a.api.patch(
      `/api/categories/${a.categoryId("Food")}`,
      { name: 'Food, "fancy"' },
    );
    expect(rename.statusCode).toBe(200);

    await seed(a, [
      {
        date: "2025-08-01",
        description: 'Dinner, with a "friend"',
        notes: "line one\nline two",
      },
    ]);

    const rows = dataRows(await exportCsv(a));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([
      "2025-08-01",
      'Food, "fancy"',
      'Dinner, with a "friend"',
      "line one\nline two",
      "10.00",
      "LKR",
    ]);

    // And the same values are quoted on the wire rather than merely surviving
    // the parser above.
    expect(body(await exportCsv(a))).toContain(
      '"Food, ""fancy""","Dinner, with a ""friend""","line one\nline two"',
    );
  }, 60_000);
});

/**
 * See the long note on `neutralizeFormula` in `test/unit/csv.test.ts` for the
 * decision and its cost. This is the end-to-end half: a description that is a
 * valid expense and a live DDE payload must leave the API inert in the CSV, and
 * unchanged in JSON.
 */
describe("spreadsheet formula injection", () => {
  const PAYLOAD = "=cmd|'/c calc'!A1";

  it("neutralises a formula description in the CSV but not in the API", async () => {
    const a = await actor("export-injection");
    await seed(a, [
      { date: "2025-09-01", description: PAYLOAD, notes: "@SUM(1+1)" },
    ]);

    const rows = dataRows(await exportCsv(a));
    expect(rows[0]![2]).toBe(`'${PAYLOAD}`);
    expect(rows[0]![3]).toBe("'@SUM(1+1)");
    // No cell in the file may begin with a character a spreadsheet treats as
    // the start of a formula.
    for (const row of rows)
      for (const cell of row) expect(cell[0] ?? "").not.toMatch(/[=+\-@\t\r]/);

    // The stored value is untouched: neutralisation is a property of the CSV
    // rendering, not of the expense.
    const listed = (await a.api.get("/api/expenses")).json().items as {
      description: string;
      notes: string | null;
    }[];
    expect(listed[0]!.description).toBe(PAYLOAD);
    expect(listed[0]!.notes).toBe("@SUM(1+1)");
  }, 60_000);
});

/**
 * The same ownership property `expenses-list.test.ts` proves for the list, at
 * the endpoint that hands back every row at once. A missing `user_id` in the
 * WHERE is invisible on a single-user test database and is a full data breach
 * on a real one — and here it would be the whole table in one response.
 */
describe("ownership", () => {
  it("gives user B none of user A's rows", async () => {
    const a = await actor("export-owner-a");
    const b = await actor("export-owner-b");

    await seed(a, [
      { date: "2025-10-01", description: "A private one", amountMinor: 111 },
      { date: "2025-10-02", description: "A private two", amountMinor: 222 },
    ]);
    await seed(b, [
      { date: "2025-10-03", description: "B only", amountMinor: 333 },
    ]);

    const bRows = dataRows(await exportCsv(b));
    expect(descriptions(bRows)).toEqual(["B only"]);
    expect(body(await exportCsv(b))).not.toContain("A private");

    // A's own export is unaffected, so the scoping is a filter on the caller
    // and not something that happens to return nothing.
    expect(descriptions(dataRows(await exportCsv(a)))).toEqual([
      "A private two",
      "A private one",
    ]);
  }, 60_000);

  it("ignores another user's category id in the filter", async () => {
    const a = await actor("export-catfilter-a");
    const b = await actor("export-catfilter-b");
    await seed(a, [{ date: "2025-11-01", description: "A food" }]);
    await seed(b, [{ date: "2025-11-02", description: "B food" }]);

    // A category B does not own. It must narrow B's export to nothing, never
    // widen it to A's rows.
    const r = await exportCsv(b, `?categoryIds=${a.categoryId("Food")}`);
    expect(body(r)).toBe(`${HEADER}\r\n`);
  }, 60_000);
});

/**
 * The export and the list must answer the same question. `totalCount` is
 * computed by a separate SQL aggregate in the repository, so pinning the row
 * count against it means the CSV's WHERE clause and the list's WHERE clause are
 * checked against each other rather than each against this file's arithmetic.
 */
describe("filters match the list, row for row", () => {
  let a: Actor;
  let food: string;
  let transport: string;

  beforeAll(async () => {
    a = await actor("export-filters");
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
        description: "COFFEE large",
        category: "Transport",
      },
      { date: "2025-03-15", description: "Rice and curry" },
      { date: "2025-03-20", description: "Coffee much later" },
    ]);
  }, 60_000);

  const queries = () => [
    "",
    "?from=2025-03-10&to=2025-03-12",
    `?categoryIds=${transport}`,
    `?categoryIds=${food},${transport}`,
    "?q=coffee",
    `?from=2025-03-01&to=2025-03-11&categoryIds=${food},${transport}&q=coffee`,
    "?from=2030-01-01",
  ];

  it("exports exactly totalCount rows for the same query string", async () => {
    for (const query of queries()) {
      const list = (await a.api.get(`/api/expenses${query}`)).json() as {
        totalCount: number;
      };
      const rows = dataRows(await exportCsv(a, query));
      expect({ query, rows: rows.length }).toEqual({
        query,
        rows: list.totalCount,
      });
    }
  });

  it("exports the same rows, not merely the same number of them", async () => {
    const query = `?from=2025-03-01&to=2025-03-11&categoryIds=${food},${transport}&q=coffee`;
    const list = (await a.api.get(`/api/expenses${query}`)).json() as {
      items: { description: string }[];
    };
    expect(descriptions(dataRows(await exportCsv(a, query)))).toEqual(
      list.items.map((e) => e.description),
    );
  });

  /**
   * The list caps a page at 100 rows; the export has no pagination at all, so a
   * `limit` in the query string is not a smaller file — it is a parameter this
   * endpoint does not have, and zod's default strip drops it.
   */
  it("ignores limit and cursor", async () => {
    const all = dataRows(await exportCsv(a)).length;
    expect(dataRows(await exportCsv(a, "?limit=1")).length).toBe(all);
    expect(dataRows(await exportCsv(a, "?cursor=nonsense")).length).toBe(all);
  });

  it("returns every row when there are more than one page's worth", async () => {
    // Past the list's 100-row page cap and past the repository's internal
    // batch size, so "no pagination" is tested rather than assumed. The batch
    // size is asserted rather than assumed, so raising it fails here loudly
    // instead of quietly turning this into a single-batch test.
    expect(EXPORT_BATCH_SIZE).toBeLessThan(120);
    const many = await actor("export-many");
    const rows = Array.from({ length: 120 }, (_, i) => ({
      date: `2025-06-${String((i % 30) + 1).padStart(2, "0")}`,
      description: `row ${i}`,
    }));
    await seed(many, rows);

    const exported = dataRows(await exportCsv(many));
    expect(exported).toHaveLength(120);
    expect(new Set(descriptions(exported)).size).toBe(120);
  }, 120_000);
});
