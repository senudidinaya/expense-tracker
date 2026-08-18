import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from "../../src/lib/crypto.js";
import {
  commonPasswordCount,
  isCommonPassword,
} from "../../src/lib/password-blocklist.js";

describe("password hashing", () => {
  it("produces an argon2id hash, never the password itself", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("correct horse");
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(
      true,
    );
    expect(await verifyPassword(hash, "correct horse battery stapl")).toBe(
      false,
    );
  });

  it("salts, so the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);
    expect(a).not.toBe(b);
  });

  it("returns false rather than throwing on a hash it cannot parse", async () => {
    // A corrupted or truncated column value must read as "wrong password", not
    // as a 500 — the caller is a login route and has no better answer.
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
  });
});

describe("session tokens", () => {
  it("returns a token plus its sha256, and the two are not the same string", () => {
    const { token, tokenHash } = createSessionToken();
    expect(tokenHash).not.toBe(token);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries 256 bits of entropy in a URL-safe cookie value", () => {
    const { token } = createSessionToken();
    // base64url of 32 bytes: 43 chars, no padding, cookie-safe alphabet.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("never repeats", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => createSessionToken().token),
    );
    expect(tokens.size).toBe(200);
  });

  it("hashSessionToken agrees with what createSessionToken returned", () => {
    const { token, tokenHash } = createSessionToken();
    expect(hashSessionToken(token)).toBe(tokenHash);
  });
});

describe("common-password blocklist", () => {
  it("rejects list members", () => {
    expect(isCommonPassword("password1234")).toBe(true);
    expect(isCommonPassword("qwertyuiop")).toBe(true);
  });

  it("is case-insensitive — capitalising a common password does not save it", () => {
    expect(isCommonPassword("Password1234")).toBe(true);
    expect(isCommonPassword("PASSWORD1234")).toBe(true);
  });

  it("accepts a password that is not on the list", () => {
    expect(isCommonPassword("velvet-thicket-lantern-92")).toBe(false);
  });

  it("holds a list large enough to be worth consulting", () => {
    // A floor, not the exact count: regenerating the wordlist from a newer
    // source should not break this, but shipping a stub, an empty file, or a
    // list truncated to a handful of entries should.
    expect(commonPasswordCount).toBeGreaterThan(3000);
  });
});
