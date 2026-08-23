import { describe, expect, it } from "vitest";
import {
  csvRow,
  minorToDecimalString,
  neutralizeFormula,
} from "../../src/lib/csv.js";

/**
 * Task 10, Step 1 — the CSV primitives.
 *
 * Three separate concerns live in `lib/csv.ts`, and they are tested apart
 * because they fail apart:
 *
 *  - `csvRow` is RFC 4180 and nothing else: quote when the field contains a
 *    quote, a comma or a line break; double an embedded quote.
 *  - `minorToDecimalString` is the *only* place on the server where integer
 *    minor units become a decimal representation, so it is the only place the
 *    money-is-integers rule could be broken. It must not do float arithmetic.
 *  - `neutralizeFormula` is the spreadsheet-injection guard.
 */

describe("csvRow", () => {
  it("leaves a plain field unquoted", () => {
    expect(csvRow(["2025-01-31", "Food", "Coffee"])).toBe(
      "2025-01-31,Food,Coffee",
    );
  });

  it("quotes a field containing a comma", () => {
    expect(csvRow(["a,b", "c"])).toBe('"a,b",c');
  });

  it("quotes a field containing a quote and doubles the quote", () => {
    expect(csvRow(['he said "hi"'])).toBe('"he said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(csvRow(["line one\nline two"])).toBe('"line one\nline two"');
  });

  it("quotes a field containing a carriage return", () => {
    // CR alone still breaks a naive line-splitting parser, and RFC 4180 names
    // CR as well as LF, so it is quoted on its own and not only as part of CRLF.
    expect(csvRow(["a\rb"])).toBe('"a\rb"');
  });

  it("passes unicode through unchanged", () => {
    // The file is UTF-8 with a BOM; nothing here escapes or transliterates.
    expect(csvRow(["කෝපි", "Ræv", "☕"])).toBe("කෝපි,Ræv,☕");
  });

  it("emits an empty field for an empty string, without quoting it", () => {
    // `notes` is nullable and becomes "" — an empty unquoted field is how a
    // CSV says "no value", and quoting it would say the same thing in a way
    // some parsers read as a one-character string.
    expect(csvRow(["2025-01-31", "", "x"])).toBe("2025-01-31,,x");
  });

  it("emits a single field with no trailing separator", () => {
    expect(csvRow(["only"])).toBe("only");
  });

  it("does not terminate the row", () => {
    // The caller joins rows with CRLF; a row that carried its own terminator
    // would double it or leave the streaming writer guessing.
    expect(csvRow(["a", "b"])).not.toMatch(/[\r\n]$/);
  });
});

describe("minorToDecimalString", () => {
  it("converts whole rupees", () => {
    expect(minorToDecimalString(125_000)).toBe("1250.00");
  });

  it("keeps a leading zero for sub-rupee amounts", () => {
    expect(minorToDecimalString(5)).toBe("0.05");
    expect(minorToDecimalString(1)).toBe("0.01");
    expect(minorToDecimalString(0)).toBe("0.00");
    expect(minorToDecimalString(99)).toBe("0.99");
    expect(minorToDecimalString(100)).toBe("1.00");
  });

  /**
   * The reason this function exists instead of `(n / 100).toFixed(2)`.
   *
   * A double has 53 bits of mantissa, so dividing a large integer by 100 lands
   * on the nearest representable double rather than the exact quotient — and
   * `toFixed` then faithfully prints the wrong number. Both values below are
   * legal `amount_minor`s (the CHECK caps a row at 2^53 - 1) and both come out
   * one cent short through a float. That is the lossy money the
   * integer-minor-units rule exists to prevent, arriving at the very last step.
   */
  it.each([
    [9_007_199_254_740_099, "90071992547400.99", "90071992547400.98"],
    [8_999_999_999_999_999, "89999999999999.99", "89999999999999.98"],
  ])("is exact at %d, where a float loses a cent", (minor, exact, viaFloat) => {
    expect(minorToDecimalString(minor)).toBe(exact);
    // Pinned so the test states the bug it is preventing rather than describing
    // it: this is what the obvious implementation would have returned.
    expect((minor / 100).toFixed(2)).toBe(viaFloat);
    expect(exact).not.toBe(viaFloat);
  });

  it("is exact at the largest amount a single row may hold", () => {
    expect(minorToDecimalString(Number.MAX_SAFE_INTEGER)).toBe(
      "90071992547409.91",
    );
  });

  /**
   * The behavioural tests above can only catch a float implementation that
   * happens to be wrong on the values they name; this one catches the whole
   * class. `Function.prototype.toString` gives back the function's own source,
   * so the assertion is about the code that actually ran, not about a file that
   * might not be the one imported.
   */
  it("does no float arithmetic at all", () => {
    const source = minorToDecimalString
      .toString()
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const forbidden of [
      /\/\s*100/, // division by 100
      /\*\s*100/, // multiplication by 100
      /\.toFixed\b/,
      /\bparseFloat\b/,
      /Math\s*\.\s*round\b/,
      /Math\s*\.\s*floor\b/,
      /Math\s*\.\s*trunc\b/,
      /\be[+-]?\d/i, // exponent notation, e.g. 1e2
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("rejects a value that is not an exact integer", () => {
    // Reached only if something upstream already broke — every amount comes
    // from a `bigint` column behind `CHECK (amount_minor > 0)`. Throwing beats
    // printing "12.5" and calling it money.
    expect(() => minorToDecimalString(12.5)).toThrow(RangeError);
    expect(() => minorToDecimalString(2 ** 53)).toThrow(RangeError);
    expect(() => minorToDecimalString(Number.NaN)).toThrow(RangeError);
  });

  it("keeps the sign in front of a negative amount", () => {
    // No expense can be negative today (`CHECK (amount_minor > 0)`), but the
    // digits-and-a-decimal-point trick silently drops the sign if the sign is
    // not handled, so it is handled and pinned rather than left to a later
    // refunds feature to discover.
    expect(minorToDecimalString(-5)).toBe("-0.05");
    expect(minorToDecimalString(-125_000)).toBe("-1250.00");
  });
});

/**
 * CSV injection (a.k.a. formula injection).
 *
 * "=cmd|'/c calc'!A1" is a perfectly valid expense description — 200 characters
 * of free text is the only rule the API applies to it — and it is also a DDE
 * formula that Excel offers to execute when the exported file is opened. The
 * same is true of anything starting with `=`, `+`, `-` or `@`, and of the
 * leading tab/CR that some spreadsheets strip before parsing the rest.
 *
 * **The decision: neutralise, at the CSV boundary only.** A leading `'` makes
 * the cell inert text in every spreadsheet, and nothing in the stored data or
 * in any JSON response changes — `GET /api/expenses` still returns the
 * description byte-for-byte. Quoting the field is *not* an alternative: RFC
 * 4180 quotes are consumed by the parser, and Excel evaluates what is left.
 *
 * The cost is that the CSV is a report, not a backup: a description that
 * genuinely begins with `-` comes back with an apostrophe in front of it if
 * anyone re-imports the file. That is accepted deliberately. The export exists
 * to be opened in a spreadsheet (it carries a UTF-8 BOM for exactly that
 * reason), there is no import feature for it to round-trip through, and the
 * alternative is shipping a file that can run commands on the user's machine.
 */
describe("neutralizeFormula", () => {
  it.each(["=", "+", "-", "@"])(
    "prefixes an apostrophe to a field starting with %s",
    (lead) => {
      expect(neutralizeFormula(`${lead}SUM(A1:A9)`)).toBe(`'${lead}SUM(A1:A9)`);
    },
  );

  it("neutralises the DDE payload that motivated this", () => {
    expect(neutralizeFormula("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it("neutralises a leading tab or carriage return", () => {
    expect(neutralizeFormula("\t=1+1")).toBe("'\t=1+1");
    expect(neutralizeFormula("\r=1+1")).toBe("'\r=1+1");
  });

  it("leaves ordinary text alone", () => {
    for (const text of ["Coffee", "", "3 for 2 offer", "a-b", "x=y", "e@x.com"])
      expect(neutralizeFormula(text)).toBe(text);
  });

  it("does not stack apostrophes on text that already has one", () => {
    // A leading `'` is already inert, so prefixing another would grow by one
    // character on every pass through an export/import cycle.
    expect(neutralizeFormula("'=1+1")).toBe("'=1+1");
  });
});
