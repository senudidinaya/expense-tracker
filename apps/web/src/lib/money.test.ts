import { describe, expect, it } from "vitest";
import { formatLKR } from "./money";

describe("formatLKR", () => {
  it("renders minor units as two decimal places", () => {
    expect(formatLKR(5)).toBe("Rs 0.05");
  });

  it("renders thousands with a group separator", () => {
    expect(formatLKR(125000)).toBe("Rs 1,250.00");
  });

  it("groups every three digits at millions", () => {
    expect(formatLKR(100000000)).toBe("Rs 1,000,000.00");
  });

  // Zero is a real amount, not an absence. A dash for "nothing here" is a
  // decision for the surrounding UI (EmptyState), not for the formatter.
  it("renders zero as an amount, not a placeholder", () => {
    expect(formatLKR(0)).toBe("Rs 0.00");
  });

  // Negatives only ever arise from deltas (this month vs last). The sign leads
  // so the value reads as "minus one thousand rupees", and it stays an ASCII
  // hyphen so a copied figure pastes into a spreadsheet as a number.
  it("puts the minus sign before the currency symbol", () => {
    expect(formatLKR(-125000)).toBe("-Rs 1,250.00");
  });

  it("keeps a leading zero in the minor part of a negative", () => {
    expect(formatLKR(-5)).toBe("-Rs 0.05");
  });

  it("does not lose precision at large amounts", () => {
    expect(formatLKR(999999999999)).toBe("Rs 9,999,999,999.99");
  });

  it("renders a value whose minor part is a multiple of ten", () => {
    expect(formatLKR(1250)).toBe("Rs 12.50");
  });

  // Money is integer minor units everywhere. A float reaching the formatter
  // means it was already lossy upstream; rounding here would hide that.
  it("rejects non-integer input", () => {
    expect(() => formatLKR(12.5)).toThrow(TypeError);
  });

  it("rejects NaN", () => {
    expect(() => formatLKR(Number.NaN)).toThrow(TypeError);
  });
});
