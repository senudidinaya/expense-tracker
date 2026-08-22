import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/lib/cursor.js";

/**
 * Task 9, Step 1 — the keyset cursor.
 *
 * The cursor is deliberately readable: base64url JSON, no signature, no
 * encryption. That is a decision, not an oversight — it encodes a *position*
 * in a sort order, `(date, id)`, and a position is not a capability. The
 * repository still scopes every query to the session's `user_id`, so the worst
 * a client can do by editing its own cursor is page through its own rows from
 * somewhere else. `expenses-list.test.ts` holds that test.
 *
 * What this file pins down is the other half: a cursor that is not a
 * well-formed position must come back `null` — never a throw, never a partial
 * object the query layer would then interpolate.
 */

const A_CURSOR = {
  date: "2025-06-15",
  id: "0197a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
};

describe("encodeCursor", () => {
  it("round-trips a (date, id) position", () => {
    expect(decodeCursor(encodeCursor(A_CURSOR))).toEqual(A_CURSOR);
  });

  it("emits base64url, so it survives a query string unescaped", () => {
    // Not merely cosmetic: `+`, `/` and `=` from standard base64 all need
    // percent-encoding in a URL, and a client that forgets turns `+` into a
    // space. base64url has none of the three.
    expect(encodeCursor(A_CURSOR)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("decodeCursor", () => {
  it("rejects a tampered cursor rather than throwing", () => {
    const tampered = `${encodeCursor(A_CURSOR)}xyz`;
    expect(decodeCursor(tampered)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["not base64 at all", "!!!not-base64!!!"],
    ["base64 of something that is not JSON", base64url("hello")],
    ["JSON that is not an object", base64url("[1,2,3]")],
    [
      "an object missing `id`",
      base64url(JSON.stringify({ date: "2025-06-15" })),
    ],
    [
      "an object missing `date`",
      base64url(JSON.stringify({ id: A_CURSOR.id })),
    ],
    [
      "a date that is not a real calendar date",
      base64url(JSON.stringify({ date: "2025-02-31", id: A_CURSOR.id })),
    ],
    [
      "a date in the wrong format",
      base64url(JSON.stringify({ date: "15/06/2025", id: A_CURSOR.id })),
    ],
    [
      "an id that is not a uuid",
      base64url(JSON.stringify({ date: "2025-06-15", id: "1; drop table" })),
    ],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });

  it("returns null for an absurdly long string without parsing it", () => {
    // A cursor is ~60 bytes. Anything past the cap is not a cursor a server
    // ever issued, so it is rejected on length rather than handed to JSON.parse.
    expect(decodeCursor("A".repeat(100_000))).toBeNull();
  });
});

function base64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
