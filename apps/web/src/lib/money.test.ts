import { describe, expect, it } from "vitest";
import { formatLKR, formatMinorForInput, parseRupeesToMinor } from "./money";

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

// Task 20 BLOCKER 1: ExpenseForm's single `amountMinor` RHF field held minor
// units on reset() but was read as rupees by setValueAs, so an unchanged edit
// sent amountMinor * 100. These two functions are the fix's building blocks —
// one explicit rupees<->minor-units boundary, tested independently of any
// form so the conversion itself cannot be wrong twice.
describe("parseRupeesToMinor", () => {
  it("parses a whole rupee amount", () => {
    expect(parseRupeesToMinor("500")).toBe(50000);
  });

  it("parses one decimal digit", () => {
    expect(parseRupeesToMinor("500.5")).toBe(50050);
  });

  it("parses two decimal digits", () => {
    expect(parseRupeesToMinor("500.50")).toBe(50050);
  });

  it("parses the smallest positive amount", () => {
    expect(parseRupeesToMinor("0.01")).toBe(1);
  });

  it("parses a large amount without losing precision", () => {
    expect(parseRupeesToMinor("1000000")).toBe(100000000);
  });

  it.each(["", "abc", "12.345", "0.145", "-5", "1.2.3", " ", "1e3"])(
    "throws on invalid input %j",
    (input) => {
      expect(() => parseRupeesToMinor(input)).toThrow();
    },
  );

  // "0" is well-formed, so it parses. "must be positive" is a rule about the
  // *field* being filled, not about rupee syntax: `amountMinor` in
  // @expense/shared is `.positive()` and `ExpenseForm` rejects a zero amount
  // there (see ExpenseForm.test.tsx). Keeping that rule out of the parser is
  // what lets a budget or a delta field reuse it.
  it("parses zero — positivity is the field's rule, not the parser's", () => {
    expect(parseRupeesToMinor("0")).toBe(0);
    expect(parseRupeesToMinor("0.00")).toBe(0);
  });

  // Named explicitly, in addition to the table above: the failure mode this
  // guards against is a "fix" that rounds a third decimal digit instead of
  // rejecting it outright. Math.round(12.345 * 100) is 1235 (banker's-adjacent
  // float noise can even land on 1234) — either way, a silently rounded value
  // is a bug this test must catch, not just "any throw."
  it("does not round a third decimal digit — it throws", () => {
    expect(() => parseRupeesToMinor("12.345")).toThrow();
    expect(() => parseRupeesToMinor("0.145")).toThrow();
  });

  it.each([1, 99, 100, 50000, 123456])(
    "round-trips through formatMinorForInput for %i minor units",
    (minor) => {
      expect(parseRupeesToMinor(formatMinorForInput(minor))).toBe(minor);
    },
  );
});

describe("formatMinorForInput", () => {
  it("formats minor units as a two-decimal rupee string", () => {
    expect(formatMinorForInput(50000)).toBe("500.00");
  });
});
