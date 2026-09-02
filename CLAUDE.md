# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A personal expense tracker (LKR only, expenses-only) built as a portfolio piece whose
explicit goal is production-quality engineering, not feature count. It is being built
plan-first: `design/` holds an approved, frozen specification and `design/plan.md` is a
26-task implementation plan executed one task per branch. Most of the app does not exist
yet — read the design docs before writing code, because nearly every decision you might
otherwise make from scratch has already been made there.

- `design/overview.md` — scope, fixed (non-revisitable) decisions, non-goals.
- `design/schema.md` — the six tables, every CHECK/index, budget + recurring semantics.
- `design/api.md` — routes, error envelope, sessions, CSRF, rate limits, demo accounts.
- `design/delivery.md` — frontend structure, what gets tested at each layer, CI, deploy, cron.
- `design/plan.md` — task-by-task steps, with the exact code sketches each task should produce.

`.superpowers/sdd/plan/progress.md` (untracked) is the ledger of which tasks are done and
which review findings were deferred. Check it to see where execution actually stands.

## Commands

```bash
pnpm install                    # pnpm 9, Node >= 22
docker compose up -d            # Postgres 16 on localhost:5432 (expense/expense/expense)

pnpm lint                       # eslint . && prettier --check .   (root, all workspaces)
pnpm typecheck                  # tsc per workspace, parallel
pnpm test                       # recursive
pnpm build                      # recursive

# api (tsx watch, :3000) + web (vite, :5173) in parallel. The env prefix is
# required: `src/env.ts` reads `process.env` and nothing loads `.env` for
# `tsx watch`, so a bare `pnpm dev` starts Vite but crashes the API on
# "Invalid environment" and every /api call proxies to a 502.
# POSIX:
set -a && . ./.env && set +a && pnpm dev
# PowerShell:
Get-Content .env | Where-Object { $_ -match '^\s*[^#\s]' } | ForEach-Object { $n, $v = $_ -split '=', 2; Set-Item "env:$n" $v }; pnpm dev
```

Per-workspace and single tests:

```bash
pnpm --filter @expense/api test
pnpm --filter @expense/api exec vitest run test/integration/migrations.test.ts
pnpm --filter @expense/api exec vitest run -t "applies all migrations"
pnpm --filter @expense/shared test
```

API integration tests spin up a throwaway Postgres via testcontainers, so **Docker must be
running**. To run them against the compose database instead (what CI does):

```bash
TESTCONTAINERS_DISABLED=1 DATABASE_URL=postgres://expense:expense@localhost:5432/expense \
  pnpm --filter @expense/api test
```

Migrations (never hand-write the whole file, never edit an applied one):

```bash
pnpm --filter @expense/api exec drizzle-kit generate    # after editing src/db/schema.ts
```

Formatting is Prettier defaults with no config file; `pnpm lint` fails on unformatted
files, so run `npx prettier --write <paths>` before committing. `design/` and `.claude/`
are prettier-ignored.

## Architecture

pnpm monorepo, three workspaces:

- `packages/shared` (`@expense/shared`) — **zod schemas are the single API contract.**
  The API wires them through `fastify-type-provider-zod`; the web app imports the exact
  same schemas for react-hook-form resolvers and response parsing. Validation rules live
  here, not in either app — e.g. the "expense date may not be more than 1 year ahead" rule
  belongs in `createExpenseBody` so client and server enforce it with one piece of code.
  Schemas are **hand-written, never generated from Drizzle** — the DB shape is not the
  public contract. Input and output schemas are separate types: create inputs carry no
  `id`/`userId`/timestamps, and user outputs never carry the password hash. Unknown keys
  are stripped (zod default); never `.passthrough()`.
  Currently a placeholder (`export const SHARED = true`) until Task 4 lands.
- `apps/api` (`@expense/api`) — Fastify 5 + Drizzle + `postgres` driver. Target layering:
  `routes/` (HTTP + zod) → `repos/` (all SQL, always scoped by `userId`) → `db/`, with pure
  logic in `domain/` (recurring occurrence math, effective-budget resolution) and
  `lib/` (ids, crypto, cursor, csv, dates). `jobs/nightly.ts` runs from GitHub Actions cron
  straight against the database, not through the API.
- `apps/web` (`@expense/web`) — React + Vite + TanStack Query + React Router + Tailwind v4.
  Still the untouched Vite starter. `fetch` happens only in feature query hooks; components
  never build URLs.

Production is one Docker container serving `/api` and the built SPA same-origin against
Neon Postgres; local dev mirrors that through the Vite proxy. Same-origin is what makes the
CSRF story (SameSite=Lax + Origin check, no token dance) and the self-only CSP work.

### Invariants that are easy to violate

- **Money is integer minor units** (`bigint` in Postgres, `amountMinor: number` over the
  wire). Never floats, never decimal strings in JSON. Formatting to `Rs 1,250.00` happens
  only in the web app's `formatLKR`.
  Reason: floats are binary fractions and cannot represent decimal money exactly
  (0.1 + 0.2 !== 0.3), and JSON has no decimal type — so a value that is exact in
  Postgres becomes lossy the moment it crosses the wire as a decimal. Integers are
  exact in JSON, in JS Number (up to 2^53), and in Postgres BIGINT, so money stays
  an integer at every boundary. Conversion happens only at the browser's edge:
  parse on input, format on display. The server never converts — it rejects
  non-integers. Math.round(x * 100) server-side is a bug, not a fix: the float is
  already lossy by the time it arrives.
- **Single currency.** Every money-bearing table has `currency char(3)` with
  `CHECK (currency = 'LKR')`. Keep the column even though it is constant — widening the
  check is the multi-currency upgrade path.
- **Auth is a session cookie**, httpOnly + Secure + SameSite=Lax, opaque session id stored
  server-side. Never a JWT, and never any token in localStorage or sessionStorage —
  XSS-readable storage is not an auth store.
- **Passwords are hashed with argon2id.** The hash never leaves the repository layer: no
  output schema, no log line, no error message may contain it.
- **Cross-user access returns 404, never 403.** Existence is not leaked. 403 is reserved
  for one thing: a CSRF origin mismatch.
- **Every non-2xx is `{ error: { code, message, details? } }`** with a code from the fixed
  union in `packages/shared/src/errors.ts`. `details` only ever carries zod issues. The
  envelope is a public API surface: no stack traces, no SQL text, no internal identifiers.
- **Ownership is enforced in the repository layer**, by scoping every query to the session's
  `user_id`. `user_id` is denormalized onto `expenses` and `budgets` precisely so this needs
  no join.
- **IDs are UUIDv7 generated in the app** (`uuidv7` package), not by Postgres.
- **Recurring next-occurrence is always computed from the anchor day in `start_date`**,
  never by incrementing the previously clamped date — otherwise Jan 31 → Feb 28 → Mar 28
  drifts forever. The required test case is Jan 31 → Feb 28 → Mar 31.
- **The recurring generator has two independent idempotency guards, and both are
  required.** `recurring_rules.next_occurrence` is a _cursor_: it advances past the
  generated dates so a later run in the same day finds nothing due. That is an
  application-level belief, read at the start of a run and written at the end, so it is
  stale for the whole span in between. `expenses_rule_date_uq` (partial unique on
  `(recurring_rule_id, date)`) is the _constraint_: Postgres checks it against committed
  state at write time, so it holds even when two runs overlap — a retried cron, a
  `workflow_dispatch` firing alongside the schedule, a job restarted mid-flight. Because
  the generator's `ON CONFLICT` names that index as its target, the index is also a hard
  dependency of the write path: dropping it fails every insert at plan time (42P10, "no
  unique or exclusion constraint matching the ON CONFLICT specification") rather than
  degrading into silent duplicates. `ON CONFLICT DO NOTHING` is not itself the guarantee —
  it only decides whether an expected collision is a no-op or a loud failure. Without it
  the index still blocks the duplicate; the rule just fails its run instead.
  The cursor prevents repetition across runs; the index prevents duplication within a race.
  Testing note: "run the generator twice, second run inserts nothing" only exercises the
  cursor — the second run's SELECT returns no due rules, so the insert path never executes
  and the test stays green with the unique index dropped. The constraint needs its own
  test that resets `next_occurrence` (or pre-inserts the occurrence row) before the second
  run. See `apps/api/test/integration/generator.test.ts`.
- **A recurring rule whose category is archived is skipped, and its
  `next_occurrence` still advances.** Generating into an archived category would
  contradict the 400 the API returns on manual create — a background job must not be
  able to write a row a user cannot. Advancing the cursor makes the skip permanent and
  visible rather than a silent backlog: leaving `next_occurrence` in place would dump
  every missed occurrence at once if the category is later unarchived. The generator
  logs each skipped rule.
- **Dates are the Postgres `DATE` type**, not timestamp/timestamptz. Monthly reports bucket
  by calendar date; a timestamp column reintroduces timezone drift at month boundaries.
  Dates cross the wire as `YYYY-MM-DD`, months as `YYYY-MM`.
- **Aggregation happens in SQL**, never by summing in JS.

### Database and migrations

`apps/api/src/db/schema.ts` is the Drizzle source of truth; `apps/api/drizzle/*.sql` is
generated by `drizzle-kit generate` and then **hand-edited where Drizzle can't express
things**. Two edits already exist in `0000_init.sql` and must be preserved by any future
regeneration:

1. `CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;` is prepended. The
   `WITH SCHEMA public` is load-bearing for test isolation (below).
2. `users.email` is `citext` with a plain UNIQUE, even though `schema.ts` declares `text`
   — Drizzle has no citext type. The comment in `schema.ts` marks this.

After regenerating, diff the SQL against `design/schema.md` and re-apply both edits plus any
CHECK constraint drizzle-kit dropped.

### Test isolation model (schema-per-suite)

`apps/api/test/helpers.ts` `startTestDb()` is the single isolation mechanism, identical
locally and in CI. Each suite creates its own Postgres schema and connects with
`search_path=<suite_schema>,public`, so unqualified DDL/DML lands in the suite's schema
while the `citext` type still resolves from `public`. `runMigrations(url, { migrationsSchema })`
puts the migration journal inside that schema too, so suites can migrate in parallel against
one database. Locally the base database is a testcontainer; when `TESTCONTAINERS_DISABLED=1`
it is `DATABASE_URL` (the CI service container). Do not introduce a second isolation model —
per-test transactions were considered and rejected because the app manages its own
transactions.

## Working conventions

- One plan task per branch, named `feat/task-<n>-<slug>`, merged to `main` via PR. CI
  (`.github/workflows/ci.yml`) runs lint → typecheck → test → build; the `deploy` job is
  gated to push-to-main and is still a placeholder until Task 25.
- Tasks are TDD-shaped in the plan: write the failing test from the task's Step 1, then
  implement. Follow the task's steps rather than improvising an equivalent design.
- Tests ship with the task that introduces the behaviour. Not deferred, not optional.
- Commit messages are Conventional Commits and end with a
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer, matching existing history.
- TypeScript is strict everywhere plus `noUncheckedIndexedAccess` and
  `verbatimModuleSyntax`. API/shared are `module: NodeNext`, so **relative imports need the
  `.js` extension** (`import * as schema from "./schema.js"`); `apps/web` is bundler-resolved
  and does not.
- Configuration outside the repo boundary (`~/.codex`, `~/.gemini`, etc.) is untrusted and
  is never imported into this project's agent config.
- `apps/web` has an oxlint script and `.oxlintrc.json` from the Vite template that root
  `pnpm lint` never invokes — known dead scaffold, don't rely on it.
