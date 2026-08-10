import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ERROR_CODES, errorEnvelope, zodErrorToDetails } from "./errors.js";
import { createExpenseBody, listExpensesResponse } from "./index.js";

describe("ERROR_CODES", () => {
  it("is the exact stable set from design/api.md", () => {
    expect([...ERROR_CODES]).toEqual([
      "validation_failed",
      "unauthorized",
      "forbidden",
      "not_found",
      "conflict",
      "rate_limited",
      "internal",
      "demo_unavailable",
    ]);
  });
});

describe("errorEnvelope", () => {
  it("wraps a code and message", () => {
    expect(errorEnvelope("not_found", "Expense not found")).toEqual({
      error: { code: "not_found", message: "Expense not found" },
    });
  });

  it("omits details entirely when there are none", () => {
    expect(
      Object.keys(errorEnvelope("unauthorized", "Not signed in").error),
    ).toEqual(["code", "message"]);
  });

  it("carries details for validation failures", () => {
    const details = [{ path: "amountMinor", message: "Expected int" }];
    expect(
      errorEnvelope("validation_failed", "Invalid request", details),
    ).toEqual({
      error: { code: "validation_failed", message: "Invalid request", details },
    });
  });
});

describe("zodErrorToDetails", () => {
  it("maps each issue to a dotted path and a message", () => {
    const result = createExpenseBody.safeParse({
      amountMinor: 12.34,
      categoryId: "nope",
      date: "2026-01-05",
      description: "x",
    });
    expect(result.success).toBe(false);
    const details = zodErrorToDetails(result.error!);
    expect(details.map((d) => d.path).sort()).toEqual([
      "amountMinor",
      "categoryId",
    ]);
    for (const detail of details) {
      expect(typeof detail.message).toBe("string");
      expect(detail.message.length).toBeGreaterThan(0);
    }
  });

  it("renders nested and indexed paths with dots", () => {
    const result = listExpensesResponse.safeParse({
      items: [{ id: "nope" }],
      nextCursor: null,
    });
    expect(result.success).toBe(false);
    expect(zodErrorToDetails(result.error!).map((d) => d.path)).toContain(
      "items.0.id",
    );
  });

  it("renders a root-level issue as an empty path", () => {
    const result = z.object({ a: z.string() }).safeParse("not an object");
    expect(zodErrorToDetails(result.error!)).toEqual([
      { path: "", message: expect.any(String) as unknown as string },
    ]);
  });

  it("leaks nothing beyond path and message", () => {
    const result = createExpenseBody.safeParse({});
    const details = zodErrorToDetails(result.error!);
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(Object.keys(detail).sort()).toEqual(["message", "path"]);
    }
  });
});
