/**
 * The single money formatter in the app. Nothing else may render an amount:
 * components go through `<MoneyText amountMinor={n} />`, which calls this.
 *
 * Amounts are integer minor units (cents) end to end — Postgres bigint, JSON
 * number, React prop — and become a decimal string exactly once, here, at the
 * browser's edge. See CLAUDE.md "Money is integer minor units".
 */

/**
 * Grouping is pinned to en-US rather than en-LK on purpose: several locales
 * that are plausible for Sri Lanka group in lakhs (1,00,000), and the app
 * ships one deterministic rendering rather than one that depends on which
 * ICU data the browser happens to carry.
 */
const groupRupees = new Intl.NumberFormat("en-US", {
  useGrouping: true,
  maximumFractionDigits: 0,
});

/**
 * `125000` → `"Rs 1,250.00"`.
 *
 * Zero renders as `"Rs 0.00"` — an amount, not a placeholder; a dash for
 * "nothing to show" belongs to the surrounding UI. Negatives render as
 * `"-Rs 1,250.00"`: the sign leads so the value reads correctly aloud, and it
 * is an ASCII hyphen so a copied figure pastes into a spreadsheet as a number.
 * Negatives only arise from deltas (period vs. previous period); an expense
 * itself is never negative.
 *
 * @throws TypeError if given anything but a safe integer. A float here means
 * the value was already lossy upstream, and rounding it would hide that.
 */
export function formatLKR(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(
      `formatLKR expects integer minor units, received ${String(amountMinor)}`,
    );
  }

  const negative = amountMinor < 0;
  const abs = Math.abs(amountMinor);

  // Integer arithmetic only. `abs - minor` is an exact multiple of 100, so the
  // division lands on an integer that IEEE-754 represents exactly.
  const minor = abs % 100;
  const major = (abs - minor) / 100;

  const sign = negative ? "-" : "";
  return `${sign}Rs ${groupRupees.format(major)}.${String(minor).padStart(2, "0")}`;
}

/** Whole rupees, or up to two decimal digits — no sign, no exponent. */
const RUPEES_RE = /^\d+(\.\d{1,2})?$/;

/**
 * Parses what a person typed into a rupee-denominated amount field into
 * integer minor units — the inverse of `formatMinorForInput`. Must reject a
 * third decimal digit rather than round it: rounding here would silently
 * change the amount the user typed.
 *
 * String manipulation only, deliberately: `Number(input) * 100` reintroduces
 * float error at the exact boundary this function exists to remove.
 *
 * The question this answers is "is this a well-formed rupee string, and what
 * integer does it mean" — nothing more. `"0"` parses to `0`; whether zero is
 * an acceptable *value* is a domain rule belonging to the field being filled
 * (`amountMinor` is `.positive()` in `@expense/shared`, and `ExpenseForm`
 * enforces that), not to the parser. A budget or a period-over-period delta
 * may legitimately want to parse `"0"`.
 *
 * @throws TypeError if the input isn't a non-negative rupee amount with at
 * most two decimal places.
 */
export function parseRupeesToMinor(input: string): number {
  const trimmed = input.trim();

  if (!RUPEES_RE.test(trimmed)) {
    throw new TypeError(
      `parseRupeesToMinor expects a rupee amount like "500.00", received ${String(input)}`,
    );
  }

  const [major, fraction = ""] = trimmed.split(".");
  return Number(`${major}${fraction.padEnd(2, "0")}`);
}

/**
 * Formats integer minor units as the two-decimal rupee string an amount
 * input should display (`50000` -> `"500.00"`) — the inverse of
 * `parseRupeesToMinor`.
 *
 * @throws TypeError if given anything but a safe integer.
 */
export function formatMinorForInput(amountMinor: number): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(
      `formatMinorForInput expects integer minor units, received ${String(amountMinor)}`,
    );
  }

  const minor = amountMinor % 100;
  const major = (amountMinor - minor) / 100;
  return `${major}.${String(minor).padStart(2, "0")}`;
}
