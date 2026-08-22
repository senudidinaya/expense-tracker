import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 8, Step 2 — categories CRUD.
 *
 * The rules under test come from design/api.md: the list carries active and
 * archived alike (flagged, because archived categories stay selectable in
 * filters and reports), duplicate *active* names are a 409, and archiving is
 * always allowed while unarchiving into a taken name is not.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;
let api: ReturnType<typeof asUser>;

interface CategoryDto {
  id: string;
  name: string;
  archivedAt: string | null;
  createdAt: string;
}

const list = async (): Promise<CategoryDto[]> => {
  const r = await api.get("/api/categories");
  expect(r.statusCode).toBe(200);
  return r.json().items as CategoryDto[];
};

const byName = async (name: string) =>
  (await list()).find((c) => c.name === name);

/** Creates a category and returns it, failing loudly rather than at the assertion. */
async function create(name: string): Promise<CategoryDto> {
  const r = await api.post("/api/categories", { name });
  if (r.statusCode !== 201) {
    throw new Error(`create("${name}") -> ${r.statusCode} ${r.body}`);
  }
  return r.json().category as CategoryDto;
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();
  api = asUser(app, await signupUser(app, "cats"));
}, 120_000);

afterAll(() => stop?.());

describe("GET /api/categories", () => {
  it("401s without a session", async () => {
    const r = await app.inject({ method: "GET", url: "/api/categories" });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("returns the seeded set, all active", async () => {
    const items = await list();
    expect(items).toHaveLength(8);
    expect(items.every((c) => c.archivedAt === null)).toBe(true);
    expect(items.map((c) => c.name)).toContain("Food");
  });
});

describe("POST /api/categories", () => {
  it("201s with the created category", async () => {
    const r = await api.post("/api/categories", { name: "Books" });

    expect(r.statusCode).toBe(201);
    const { category } = r.json();
    expect(category.name).toBe("Books");
    expect(category.archivedAt).toBeNull();
    expect(typeof category.id).toBe("string");
    expect(new Date(category.createdAt).getTime()).not.toBeNaN();
    // The response is exactly the DTO — no user_id, no internal columns.
    expect(Object.keys(category).sort()).toEqual([
      "archivedAt",
      "createdAt",
      "id",
      "name",
    ]);
  });

  it("409s on a duplicate active name", async () => {
    await create("Gifts");
    const again = await api.post("/api/categories", { name: "Gifts" });

    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("conflict");
  });

  it("treats the duplicate check as case-insensitive", async () => {
    await create("Travel");
    const again = await api.post("/api/categories", { name: "TRAVEL" });
    expect(again.statusCode).toBe(409);
  });

  it("400s on an empty name and on one over 50 characters", async () => {
    for (const name of ["", "x".repeat(51)]) {
      const r = await api.post("/api/categories", { name });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });
});

describe("PATCH /api/categories/:id", () => {
  it("renames", async () => {
    const created = await create("Hoby");
    const r = await api.patch(`/api/categories/${created.id}`, {
      name: "Hobby",
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().category).toMatchObject({
      id: created.id,
      name: "Hobby",
      archivedAt: null,
    });
    expect(await byName("Hoby")).toBeUndefined();
  });

  it("409s on renaming onto another active name", async () => {
    await create("Pets");
    const other = await create("Plants");

    const r = await api.patch(`/api/categories/${other.id}`, { name: "Pets" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("conflict");
    // The failed rename left the row alone.
    expect((await byName("Plants"))?.id).toBe(other.id);
  });

  it("archives, and the row stays in the list with archivedAt set", async () => {
    const created = await create("Gadgets");

    const r = await api.patch(`/api/categories/${created.id}`, {
      archived: true,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().category.archivedAt).not.toBeNull();

    const stillListed = (await list()).find((c) => c.id === created.id);
    expect(stillListed).toBeDefined();
    expect(stillListed?.archivedAt).not.toBeNull();
  });

  it("archiving is always allowed, even when the name is taken by an active row", async () => {
    // Archive one, create an active row with the same name, then archive that
    // one too: the partial unique index only covers active rows, so nothing here
    // may collide.
    const first = await create("Snacks");
    await api.patch(`/api/categories/${first.id}`, { archived: true });
    const second = await create("Snacks");

    const r = await api.patch(`/api/categories/${second.id}`, {
      archived: true,
    });
    expect(r.statusCode).toBe(200);
  });

  it("unarchives", async () => {
    const created = await create("Repairs");
    await api.patch(`/api/categories/${created.id}`, { archived: true });

    const r = await api.patch(`/api/categories/${created.id}`, {
      archived: false,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().category.archivedAt).toBeNull();
  });

  it("409s when unarchiving would collide with an active category of the same name", async () => {
    const archived = await create("Laundry");
    await api.patch(`/api/categories/${archived.id}`, { archived: true });
    // The name is free again while it is archived, so a new active row takes it.
    await create("Laundry");

    const r = await api.patch(`/api/categories/${archived.id}`, {
      archived: false,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("conflict");

    // Still archived — the failed unarchive is not a partial write.
    const row = (await list()).find((c) => c.id === archived.id);
    expect(row?.archivedAt).not.toBeNull();
  });

  it("applies a rename and an archive in the same request", async () => {
    const created = await create("Tempp");

    const r = await api.patch(`/api/categories/${created.id}`, {
      name: "Temp",
      archived: true,
    });

    expect(r.statusCode).toBe(200);
    expect(r.json().category).toMatchObject({ id: created.id, name: "Temp" });
    expect(r.json().category.archivedAt).not.toBeNull();
  });

  it("404s on an id that is not a category of this user", async () => {
    const r = await api.patch(
      "/api/categories/0195f3aa-0000-7000-8000-000000000000",
      { name: "Nope" },
    );
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
  });

  it("400s on an id that is not a uuid", async () => {
    const r = await api.patch("/api/categories/not-a-uuid", { name: "Nope" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });
});
