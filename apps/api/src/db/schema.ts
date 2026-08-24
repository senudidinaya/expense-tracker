import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  bigint,
  char,
  date,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  // Type is upgraded to citext by the hand-edited migration SQL.
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("categories_user_name_active_uq")
      .on(t.userId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
    check(
      "categories_name_length_check",
      sql`char_length(${t.name}) between 1 and 50`,
    ),
  ],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    recurringRuleId: uuid("recurring_rule_id").references(
      () => recurringRules.id,
      {
        onDelete: "set null",
      },
    ),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    // `$type` is type-level only — no SQL changes, nothing for drizzle-kit to
    // regenerate. It just teaches TypeScript what the CHECK below already
    // guarantees, so the wire contract's `z.literal("LKR")` is satisfied by the
    // column rather than by a cast at the HTTP boundary. Widening the CHECK is
    // the multi-currency upgrade path; this annotation widens with it.
    currency: char("currency", { length: 3 })
      .$type<"LKR">()
      .notNull()
      .default("LKR"),
    date: date("date").notNull(),
    description: text("description").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("expenses_user_date_idx").on(t.userId, t.date.desc(), t.id.desc()),
    index("expenses_user_cat_date_idx").on(t.userId, t.categoryId, t.date),
    uniqueIndex("expenses_rule_date_uq")
      .on(t.recurringRuleId, t.date)
      .where(sql`${t.recurringRuleId} is not null`),
    check("expenses_amount_minor_check", sql`${t.amountMinor} > 0`),
    check("expenses_currency_check", sql`${t.currency} = 'LKR'`),
    check(
      "expenses_description_length_check",
      sql`char_length(${t.description}) between 1 and 200`,
    ),
    check(
      "expenses_notes_length_check",
      sql`${t.notes} is null or char_length(${t.notes}) <= 2000`,
    ),
  ],
);

export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    monthStart: date("month_start").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    // Same `$type` reasoning as `expenses.currency` above.
    currency: char("currency", { length: 3 })
      .$type<"LKR">()
      .notNull()
      .default("LKR"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("budgets_user_cat_month_uq").on(
      t.userId,
      t.categoryId,
      t.monthStart,
    ),
    check(
      "budgets_month_start_check",
      sql`extract(day from ${t.monthStart}) = 1`,
    ),
    check(
      "budgets_amount_minor_check",
      sql`${t.amountMinor} is null or ${t.amountMinor} >= 0`,
    ),
    check("budgets_currency_check", sql`${t.currency} = 'LKR'`),
  ],
);

export const recurringRules = pgTable(
  "recurring_rules",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    // Same `$type` reasoning as `expenses.currency` above.
    currency: char("currency", { length: 3 })
      .$type<"LKR">()
      .notNull()
      .default("LKR"),
    description: text("description").notNull(),
    notes: text("notes"),
    // Same `$type` reasoning as `currency`: the CHECK below fixes the value
    // set, so the narrowing is type-level only — nothing for drizzle-kit.
    frequency: text("frequency").$type<"weekly" | "monthly">().notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    nextOccurrence: date("next_occurrence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("recurring_rules_user_idx").on(t.userId),
    index("recurring_rules_due_idx").on(t.nextOccurrence),
    check("recurring_rules_amount_minor_check", sql`${t.amountMinor} > 0`),
    check("recurring_rules_currency_check", sql`${t.currency} = 'LKR'`),
    check(
      "recurring_rules_description_length_check",
      sql`char_length(${t.description}) between 1 and 200`,
    ),
    check(
      "recurring_rules_notes_length_check",
      sql`${t.notes} is null or char_length(${t.notes}) <= 2000`,
    ),
    check(
      "recurring_rules_frequency_check",
      sql`${t.frequency} in ('weekly', 'monthly')`,
    ),
    check(
      "recurring_rules_end_date_check",
      sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);
