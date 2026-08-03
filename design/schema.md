# Data Model — v1 (Final)

Expense Tracker. Six tables. PostgreSQL.

Conventions:

- The first migration runs `CREATE EXTENSION IF NOT EXISTS citext;` before
  any table DDL.
- All `id` columns: `uuid`, UUIDv7 generated in the app layer, `PRIMARY KEY`.
- All `timestamptz` columns default to `now()`.
- Money is stored as integer minor units (`bigint`), never float. Single
  currency (LKR) in v1; every money-bearing table carries a `currency`
  column with `CHECK (currency = 'LKR')` — widening the check adds
  currencies without a column change.
- Every user-data query is scoped by `user_id` from the session, enforced in
  the repository layer. `user_id` is denormalized onto `expenses` and
  `budgets` so ownership checks and hot indexes never need a join.

---

## users

| Column        | Type        | Null     | Default | Constraints        |
|---------------|-------------|----------|---------|--------------------|
| id            | uuid        | NOT NULL | —       | PK                 |
| email         | citext      | NOT NULL | —       | UNIQUE             |
| password_hash | text        | NOT NULL | —       | argon2id output    |
| is_demo       | boolean     | NOT NULL | false   |                    |
| created_at    | timestamptz | NOT NULL | now()   |                    |

---

## sessions

| Column     | Type        | Null     | Default | Constraints                              |
|------------|-------------|----------|---------|------------------------------------------|
| id         | uuid        | NOT NULL | —       | PK                                       |
| token_hash | text        | NOT NULL | —       | UNIQUE — SHA-256 hex of the cookie token; raw token never persisted |
| user_id    | uuid        | NOT NULL | —       | FK → users(id) ON DELETE CASCADE         |
| expires_at | timestamptz | NOT NULL | —       |                                          |
| created_at | timestamptz | NOT NULL | now()   |                                          |

Indexes:

- `sessions_user_id_idx` ON `(user_id)` — "log out everywhere" and demo reset delete by user.
- `sessions_expires_at_idx` ON `(expires_at)` — sweep of expired rows.

---

## categories

| Column      | Type        | Null     | Default | Constraints                          |
|-------------|-------------|----------|---------|--------------------------------------|
| id          | uuid        | NOT NULL | —       | PK                                   |
| user_id     | uuid        | NOT NULL | —       | FK → users(id) ON DELETE CASCADE     |
| name        | text        | NOT NULL | —       | CHECK (char_length(name) BETWEEN 1 AND 50) |
| archived_at | timestamptz | NULL     | —       | NULL = active                        |
| created_at  | timestamptz | NOT NULL | now()   |                                      |

Indexes:

- `categories_user_name_active_uq` UNIQUE ON `(user_id, lower(name)) WHERE archived_at IS NULL`
  — no duplicate active names; an archived "Travel" does not block creating a
  new "Travel".

Categories are archived, never hard-deleted, so history and reports stay
intact.

---

## expenses

| Column            | Type        | Null     | Default | Constraints                                   |
|-------------------|-------------|----------|---------|-----------------------------------------------|
| id                | uuid        | NOT NULL | —       | PK                                            |
| user_id           | uuid        | NOT NULL | —       | FK → users(id) ON DELETE CASCADE              |
| category_id       | uuid        | NOT NULL | —       | FK → categories(id) ON DELETE RESTRICT        |
| recurring_rule_id | uuid        | NULL     | —       | FK → recurring_rules(id) ON DELETE SET NULL   |
| amount_minor      | bigint      | NOT NULL | —       | CHECK (amount_minor > 0)                      |
| currency          | char(3)     | NOT NULL | 'LKR'   | CHECK (currency = 'LKR')                      |
| date              | date        | NOT NULL | —       | date-only, no time component                  |
| description       | text        | NOT NULL | —       | CHECK (char_length(description) BETWEEN 1 AND 200) |
| notes             | text        | NULL     | —       | CHECK (notes IS NULL OR char_length(notes) <= 2000) |
| created_at        | timestamptz | NOT NULL | now()   |                                               |
| updated_at        | timestamptz | NOT NULL | now()   | set by app on update                          |

`bigint` for `amount_minor`: `int4` caps a single expense at ~LKR 21.4M in
cents; plausible real expenses (vehicle purchase) exceed it, and sums
certainly do.

Indexes:

- `expenses_user_date_idx` ON `(user_id, date DESC, id DESC)` — list view + keyset pagination.
- `expenses_user_cat_date_idx` ON `(user_id, category_id, date)` — aggregates, budget status.
- `expenses_rule_date_uq` UNIQUE ON `(recurring_rule_id, date) WHERE recurring_rule_id IS NOT NULL`
  — hard database guarantee the generator can never double-insert an
  occurrence date, regardless of generator bugs or concurrent runs.

---

## budgets

| Column       | Type        | Null     | Default | Constraints                                  |
|--------------|-------------|----------|---------|----------------------------------------------|
| id           | uuid        | NOT NULL | —       | PK                                           |
| user_id      | uuid        | NOT NULL | —       | FK → users(id) ON DELETE CASCADE             |
| category_id  | uuid        | NOT NULL | —       | FK → categories(id) ON DELETE RESTRICT       |
| month_start  | date        | NOT NULL | —       | CHECK (extract(day from month_start) = 1)    |
| amount_minor | bigint      | NULL     | —       | CHECK (amount_minor IS NULL OR amount_minor >= 0); NULL = budget cleared from this month forward |
| currency     | char(3)     | NOT NULL | 'LKR'   | CHECK (currency = 'LKR')                     |
| created_at   | timestamptz | NOT NULL | now()   |                                              |
| updated_at   | timestamptz | NOT NULL | now()   |                                              |

Constraints:

- UNIQUE `(user_id, category_id, month_start)`.

Semantics (effective-from model):

- Effective budget for category C in month M = the row with the greatest
  `month_start <= M`. If no such row, or its `amount_minor` is NULL, C is
  unbudgeted for month M.
- Setting or clearing a budget upserts the row at the chosen month; history
  for earlier months is never touched. Calendar months, no rollover, no
  overall cap in v1.

---

## recurring_rules

| Column          | Type        | Null     | Default | Constraints                                   |
|-----------------|-------------|----------|---------|-----------------------------------------------|
| id              | uuid        | NOT NULL | —       | PK                                            |
| user_id         | uuid        | NOT NULL | —       | FK → users(id) ON DELETE CASCADE              |
| category_id     | uuid        | NOT NULL | —       | FK → categories(id) ON DELETE RESTRICT        |
| amount_minor    | bigint      | NOT NULL | —       | CHECK (amount_minor > 0)                      |
| currency        | char(3)     | NOT NULL | 'LKR'   | CHECK (currency = 'LKR')                      |
| description     | text        | NOT NULL | —       | CHECK (char_length(description) BETWEEN 1 AND 200) |
| notes           | text        | NULL     | —       | CHECK (notes IS NULL OR char_length(notes) <= 2000) |
| frequency       | text        | NOT NULL | —       | CHECK (frequency IN ('weekly','monthly')) — named `frequency`, not `interval` (Postgres keyword) |
| start_date      | date        | NOT NULL | —       | anchor date (see semantics)                   |
| end_date        | date        | NULL     | —       | CHECK (end_date IS NULL OR end_date >= start_date); NULL = open-ended |
| next_occurrence | date        | NOT NULL | —       | next date to generate; advanced by generator  |
| created_at      | timestamptz | NOT NULL | now()   |                                               |
| updated_at      | timestamptz | NOT NULL | now()   |                                               |

Indexes:

- `recurring_rules_user_idx` ON `(user_id)`.
- `recurring_rules_due_idx` ON `(next_occurrence)` — generator scans rules due through today.

Semantics:

- Frequencies: `weekly` = every 7 days from `start_date`; `monthly` = same
  day-of-month as `start_date`. Nothing else in v1 (no biweekly, yearly, or
  custom cron).
- Month-end clamp: a rule anchored on the 29th–31st fires on the last day of
  shorter months and returns to its anchor day afterward. **The next
  occurrence is always computed from the anchor day-of-month in
  `start_date`, never by incrementing the previously clamped date** —
  incrementing the clamped date drifts permanently
  (Jan 31 → Feb 28 → Mar 28 → …). Correct sequence: Jan 31 → Feb 28 →
  Mar 31. Never skips a month, never spills into the next month.
  Implemented as a pure function; **a unit test covering
  Jan 31 → Feb 28 → Mar 31 is required.**
- Edits apply to future occurrences only — structurally guaranteed:
  generated occurrences are plain `expenses` rows; editing a rule only
  changes what is generated from `next_occurrence` onward. Generated
  expenses remain individually editable.
- Generation is idempotent catch-up, run by the daily GitHub Actions cron
  directly against the database (the web service being asleep is
  irrelevant). Per rule, in one transaction: while
  `next_occurrence <= today` (and `<= end_date` if set), insert the expense
  and advance `next_occurrence`. A missed cron catches up; a duplicate run
  inserts nothing (backstopped by `expenses_rule_date_uq`).

---

## Foreign-key deletion behavior (summary)

- Deleting a **user** cascades to everything they own.
- **Categories** are never hard-deleted (archive only); `ON DELETE RESTRICT`
  on `expenses`, `budgets`, and `recurring_rules` is a backstop.
- Deleting a **recurring rule** SET NULLs its past expenses (they survive as
  ordinary expenses) and stops future generation.

## v2 non-goals this schema must not block (and does not)

- **CSV import**: dedup key is queryable as
  `(user_id, date, amount_minor, description)` — no schema change needed.
- **Multi-currency**: widen the `currency` CHECKs; amounts already in minor
  units per ISO 4217 exponent.
- **Income tracking**: additive `type` column on `expenses` with default.
