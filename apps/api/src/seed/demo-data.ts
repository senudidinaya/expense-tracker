/**
 * The demo dataset: six months of plausible LKR spending, as a pure function.
 *
 * Two parameters, and nothing else. `today` is injected for the same reason the
 * recurring generator's is (Task 14): a function that reads the clock cannot be
 * tested on the 31st of February, and the demo's rules are handed straight to
 * that generator, so the two must be able to agree on what day it is. The
 * caller supplies UTC — see the header of `test/integration/demo.test.ts` for
 * why UTC and not Asia/Colombo.
 *
 * `seed` is the new user's id. design/plan.md said "a fixed PRNG"; review
 * changed it, because a fixed seed gives every demo visitor the same
 * screenshot and two reviewers comparing notes see identical numbers. Seeding
 * from the id keeps this deterministic — one user always gets one dataset, so
 * a reload never reshuffles the data — while two visitors on the same day get
 * different amounts.
 *
 * ## What varies and what does not
 *
 * The SHAPE is fixed: the same eight categories, the same three rules, the
 * same five budgeted categories, the same counts per month. Only amounts and
 * the day-of-month of the scattered lines move with the seed.
 *
 * Counts are deliberately not seeded. A seeded count per month is realistic,
 * but drawn six times per category it has a long enough tail that two visitors
 * could land 40% apart — one seeing a full six months, the next seeing a
 * sparse one. Cadence is part of the shape; jitter belongs in the values.
 *
 * ## The three rules and their history
 *
 * Rent, broadband and the weekly grocery run exist as `recurring_rules`, and
 * their past occurrences are written here as ordinary expenses — generated
 * from `domain/recurring.ts`, so the history sits exactly on the schedule the
 * rule describes. Those expenses carry no `recurring_rule_id`: they are the
 * user's history, not this generator's output, and `expenses_rule_date_uq`
 * would otherwise be the only thing standing between the seed and the nightly
 * job. Instead the rules' `next_occurrence` is set strictly past `today`, so
 * the job's first run has nothing of the seed's to collide with.
 *
 * Rent and broadband bill the same amount every month, so their history uses
 * the rule's amount unchanged. Groceries do not, so the rule carries the
 * typical figure and each past week varies around it — which is also the
 * honest depiction of what a recurring rule is for.
 */

import {
  firstOccurrenceOnOrAfter,
  occurrencesThrough,
  type Schedule,
} from "../domain/recurring.js";
import {
  addDays,
  addMonths,
  daysInMonth,
  monthsBetween,
} from "../lib/dates.js";

/**
 * The subset of the default seed set this dataset uses — which is all of it.
 * Every name here must exist in `DEFAULT_CATEGORY_NAMES` (repos/categories.ts),
 * because the route maps these onto the ids it just seeded and has nowhere to
 * put a name that is not among them.
 */
export type DemoCategoryName =
  | "Food"
  | "Transport"
  | "Rent"
  | "Utilities"
  | "Health"
  | "Entertainment"
  | "Shopping"
  | "Other";

export interface DemoExpense {
  category: DemoCategoryName;
  amountMinor: number;
  date: string;
  description: string;
  notes: string | null;
}

export interface DemoBudget {
  category: DemoCategoryName;
  /** First of a month — `budgets_month_start_check` accepts nothing else. */
  monthStart: string;
  amountMinor: number;
}

export interface DemoRecurringRule {
  category: DemoCategoryName;
  amountMinor: number;
  description: string;
  frequency: "weekly" | "monthly";
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
}

export interface DemoDataset {
  /** Exactly the categories the three lists below refer to, sorted. */
  categories: DemoCategoryName[];
  expenses: DemoExpense[];
  budgets: DemoBudget[];
  recurringRules: DemoRecurringRule[];
}

/** Six calendar months, the current one included. */
const WINDOW_MONTHS = 6;

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/**
 * xmur3: a string hash that mixes every character into the result.
 *
 * The mixing is the point, not the speed. `seed` is a uuidv7, which is
 * time-ordered — two demo users provisioned in the same second share
 * everything but the last few nibbles. Anything that reads a prefix
 * (`parseInt(seed.slice(0, 8), 16)`) hands both of them the identical dataset,
 * which is the exact failure this whole parameter exists to avoid.
 */
function hashSeed(text: string): number {
  let h = 1_779_033_703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3_432_918_353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2_246_822_507);
  h = Math.imul(h ^ (h >>> 13), 3_266_489_909);
  return (h ^= h >>> 16) >>> 0;
}

/** mulberry32 — a small, fast, fully deterministic 32-bit generator. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Rng = () => number;

/** An integer in `[min, max]`, both inclusive. Money stays integral here. */
const amountBetween = (rng: Rng, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

/** `base`, moved by up to `spread` either way, rounded to whole minor units. */
const jitter = (rng: Rng, base: number, spread: number): number =>
  Math.round(base * (1 + (rng() * 2 - 1) * spread));

/** One of `options`, chosen by the seed. Never empty in practice. */
const pick = <T>(rng: Rng, options: readonly T[]): T =>
  options[Math.floor(rng() * options.length)] ?? options[0]!;

// ---------------------------------------------------------------------------
// The fixed shape
// ---------------------------------------------------------------------------

/**
 * How many scattered (non-rule) lines each category gets per month. Fixed, for
 * the reason in the header. The rule-backed categories get their history from
 * the schedule instead and appear here only for what the rules do not cover —
 * Utilities has a water bill on top of the broadband rule; Food gets nothing,
 * since the weekly rule already covers it.
 */
const MONTHLY_LINES: ReadonlyArray<{
  category: DemoCategoryName;
  count: number;
  min: number;
  max: number;
  descriptions: readonly string[];
}> = [
  {
    category: "Transport",
    count: 4,
    min: 400_00,
    max: 3_500_00,
    descriptions: ["Tuk fare", "Fuel", "Bus pass top-up", "PickMe to office"],
  },
  {
    category: "Utilities",
    count: 1,
    min: 1_800_00,
    max: 4_500_00,
    descriptions: ["Water bill", "Electricity bill"],
  },
  {
    category: "Entertainment",
    count: 2,
    min: 900_00,
    max: 6_500_00,
    descriptions: ["Cinema tickets", "Dinner out", "Concert", "Streaming"],
  },
  {
    category: "Health",
    count: 1,
    min: 1_500_00,
    max: 12_000_00,
    descriptions: ["Pharmacy", "Dental check-up", "Doctor's visit"],
  },
  {
    category: "Shopping",
    count: 2,
    min: 1_200_00,
    max: 22_000_00,
    descriptions: ["Clothes", "Household goods", "Phone accessory", "Shoes"],
  },
  {
    category: "Other",
    count: 1,
    min: 500_00,
    max: 5_000_00,
    descriptions: ["Gift", "Postage", "Miscellaneous"],
  },
];

/**
 * The five budgeted categories and roughly what a month of each costs, so the
 * demo's budget bars sit near — but not exactly on — what was spent. A budget
 * that always matched spending to the rupee would make the feature look staged.
 */
const BUDGET_TARGETS: ReadonlyArray<{
  category: DemoCategoryName;
  base: number;
}> = [
  { category: "Food", base: 60_000_00 },
  { category: "Transport", base: 10_000_00 },
  { category: "Utilities", base: 13_000_00 },
  { category: "Entertainment", base: 9_000_00 },
  { category: "Shopping", base: 25_000_00 },
];

// ---------------------------------------------------------------------------

/**
 * Six months of expenses, five budgets and three recurring rules, all relative
 * to `today` and all determined by `seed`.
 */
export function demoDataset(today: string, seed: string): DemoDataset {
  const rng = makeRng(hashSeed(seed));

  const startMonth = addMonths(today.slice(0, 7), -(WINDOW_MONTHS - 1));
  const windowStart = `${startMonth}-01`;
  const months = monthsBetween(windowStart, today);
  const currentMonth = today.slice(0, 7);

  const expenses: DemoExpense[] = [];

  // -- The three rules, and the history each one implies ---------------------

  // Anchor days are fixed (and all <= 28, so the start date is a real day in
  // every month). The clamping path — an anchor of 29..31 over February — is
  // the generator's business and is tested there; a demo that quietly moved
  // its own rent day would only make the seeded history harder to read.
  const rentSchedule: Schedule = {
    frequency: "monthly",
    startDate: `${startMonth}-03`,
  };
  const broadbandSchedule: Schedule = {
    frequency: "monthly",
    startDate: `${startMonth}-12`,
  };
  const grocerySchedule: Schedule = {
    frequency: "weekly",
    startDate: `${startMonth}-02`,
  };

  const rentAmount = jitter(rng, 85_000_00, 0.06);
  const broadbandAmount = jitter(rng, 7_500_00, 0.1);
  const groceryAmount = jitter(rng, 12_000_00, 0.15);

  for (const date of occurrencesThrough(
    rentSchedule,
    rentSchedule.startDate,
    today,
  )) {
    // Same figure every month: rent is the one line that genuinely does not move.
    expenses.push({
      category: "Rent",
      amountMinor: rentAmount,
      date,
      description: "Apartment rent",
      notes: "Standing transfer to the landlord",
    });
  }

  for (const date of occurrencesThrough(
    broadbandSchedule,
    broadbandSchedule.startDate,
    today,
  )) {
    expenses.push({
      category: "Utilities",
      amountMinor: broadbandAmount,
      date,
      description: "Fibre broadband",
      notes: null,
    });
  }

  for (const date of occurrencesThrough(
    grocerySchedule,
    grocerySchedule.startDate,
    today,
  )) {
    // Groceries are the line that moves week to week, so the history varies
    // around the rule's typical amount rather than repeating it.
    expenses.push({
      category: "Food",
      amountMinor: jitter(rng, groceryAmount, 0.25),
      date,
      description: "Weekly grocery run",
      notes: null,
    });
  }

  // `next_occurrence` strictly after today, on the rule's own anchor grid.
  // Anything at or before today is a date the loops above already wrote, and
  // the nightly job would write it a second time.
  const cursorFor = (schedule: Schedule): string =>
    firstOccurrenceOnOrAfter(schedule, addDays(today, 1));

  const recurringRules: DemoRecurringRule[] = [
    {
      category: "Rent",
      amountMinor: rentAmount,
      description: "Apartment rent",
      frequency: "monthly",
      startDate: rentSchedule.startDate,
      endDate: null,
      nextOccurrence: cursorFor(rentSchedule),
    },
    {
      category: "Utilities",
      amountMinor: broadbandAmount,
      description: "Fibre broadband",
      frequency: "monthly",
      startDate: broadbandSchedule.startDate,
      endDate: null,
      nextOccurrence: cursorFor(broadbandSchedule),
    },
    {
      category: "Food",
      amountMinor: groceryAmount,
      description: "Weekly grocery run",
      frequency: "weekly",
      startDate: grocerySchedule.startDate,
      endDate: null,
      nextOccurrence: cursorFor(grocerySchedule),
    },
  ];

  // -- Everything the rules do not cover ------------------------------------

  /**
   * A day inside `month` that is never in the future: the current month stops
   * at today's day-of-month, earlier months run to their real length. This is
   * also what keeps every generated date a day that exists — the month's own
   * length is the ceiling, so February never sees a 30th.
   */
  const dayIn = (month: string): number => {
    const last =
      month === currentMonth ? Number(today.slice(8, 10)) : daysInMonth(month);
    return 1 + Math.floor(rng() * last);
  };

  for (const month of months) {
    for (const line of MONTHLY_LINES) {
      for (let i = 0; i < line.count; i++) {
        expenses.push({
          category: line.category,
          amountMinor: amountBetween(rng, line.min, line.max),
          date: `${month}-${String(dayIn(month)).padStart(2, "0")}`,
          description: pick(rng, line.descriptions),
          notes: null,
        });
      }
    }
  }

  // -- Budgets ---------------------------------------------------------------

  // One row per category, at the window's first month. design/schema.md
  // resolves the effective budget for month M as the row with the greatest
  // `month_start <= M`, so a single row at the start covers every month of the
  // demo, today's included, with no history to keep consistent.
  const budgets: DemoBudget[] = BUDGET_TARGETS.map(({ category, base }) => ({
    category,
    monthStart: windowStart,
    amountMinor: jitter(rng, base, 0.12),
  }));

  // -- The category list -----------------------------------------------------

  // Derived, never declared: a hand-maintained list drifts the moment a line
  // above is added or removed, and the route uses this to decide which ids it
  // needs. What it names is exactly what the rows reference.
  const categories = [
    ...new Set<DemoCategoryName>([
      ...expenses.map((e) => e.category),
      ...budgets.map((b) => b.category),
      ...recurringRules.map((r) => r.category),
    ]),
  ].sort();

  return { categories, expenses, budgets, recurringRules };
}
