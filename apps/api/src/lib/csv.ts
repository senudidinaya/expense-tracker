/**
 * CSV primitives for the expense export. RFC 4180, plus the two things RFC 4180
 * does not cover: how money becomes text, and what a spreadsheet does with text
 * that looks like a formula.
 */

/**
 * The UTF-8 byte-order mark, as bytes rather than as a `﻿` in a template
 * literal — the character is invisible in a source file, and this is a
 * three-byte prefix on a file, not a character in a string.
 *
 * design/api.md asks for it because Excel is the target reader: given a CSV
 * with no BOM, Excel decodes it in the system codepage, and every Sinhala or
 * accented description arrives as mojibake.
 */
export const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** RFC 4180: the record separator is CRLF, not LF. */
export const CSV_EOL = "\r\n";

/** A field needs quoting exactly when it contains a quote, the separator, or a line break. */
const NEEDS_QUOTING = /["\r\n,]/;

/**
 * One record, without its terminator — the caller decides where records end,
 * which is what lets the export write rows into a stream one at a time.
 *
 * This is RFC 4180 and only RFC 4180: it does not neutralise formulas. The two
 * are separate on purpose. Quoting is about a *parser* reading the file back;
 * `neutralizeFormula` is about a *spreadsheet* deciding a cell is executable,
 * and quotes do nothing for the second — the parser strips them and hands the
 * `=` to the formula engine anyway.
 */
export const csvRow = (fields: string[]): string =>
  fields
    .map((field) =>
      NEEDS_QUOTING.test(field) ? `"${field.replaceAll('"', '""')}"` : field,
    )
    .join(",");

/**
 * Integer minor units to a decimal string: `125000` -> `"1250.00"`.
 *
 * The **only** place on the server where money stops being an integer, and it
 * gets there without arithmetic. `(n / 100).toFixed(2)` is the obvious version
 * and it is wrong: a double has 53 bits of mantissa, so dividing a large legal
 * `amount_minor` lands on the nearest representable double rather than the
 * exact quotient, and `toFixed` then prints that faithfully — 9007199254740099
 * comes out a cent short. There is no rounding mode that fixes it, because the
 * information is gone before rounding happens.
 *
 * Decimal digits, on the other hand, are exact: `String` of a safe integer is
 * the integer, and putting a point two places from the right is a text
 * operation. Hence pad, slice, join.
 */
export function minorToDecimalString(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    // Unreachable from the database — `amount_minor` is a `bigint` column under
    // `CHECK (amount_minor > 0)` and the shared schema caps it at the exact
    // integer ceiling. If it happens anyway, something upstream is already
    // broken, and printing "12.5" as if it were money would hide that.
    throw new RangeError(`amountMinor must be a safe integer, got ${minor}`);
  }

  const sign = minor < 0 ? "-" : "";
  // `< 0 ? -minor : minor` rather than `Math.abs`: same answer for an integer,
  // and it keeps this function free of anything that could be read as numeric
  // conversion. Padded to 3 so there is always at least one digit left of the
  // point — 5 becomes "005" becomes "0.05".
  const digits = String(minor < 0 ? -minor : minor).padStart(3, "0");
  return `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Characters a spreadsheet reads as the start of a formula. `=` is the obvious
 * one; `+`, `-` and `@` all begin a formula in Excel too, and a leading tab or
 * CR is stripped by some importers before the rest of the cell is parsed, which
 * puts whatever follows back in first position.
 */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Makes a field inert as a spreadsheet cell by prefixing an apostrophe.
 *
 * `=cmd|'/c calc'!A1` is a legal expense description — 200 characters of free
 * text is the only rule the API applies — and it is also a DDE payload Excel
 * offers to execute when the export is opened. Since the file exists to be
 * opened in a spreadsheet (that is what the BOM is for), the export neutralises
 * it rather than shipping a file that can run commands.
 *
 * The cost, accepted deliberately: the CSV is a report, not a backup. A
 * description that genuinely starts with `-` reads back with an apostrophe in
 * front of it. Nothing stored changes and no JSON response changes — this
 * happens at the CSV boundary and nowhere else, so `GET /api/expenses` still
 * returns the description byte for byte.
 */
export const neutralizeFormula = (field: string): string =>
  field.length > 0 && FORMULA_LEAD.has(field[0]!) ? `'${field}` : field;
