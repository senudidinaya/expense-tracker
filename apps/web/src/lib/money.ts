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
