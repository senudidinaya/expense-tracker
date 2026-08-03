# Expense Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the production-quality expense tracker specified in `design/overview.md`, `design/schema.md`, `design/api.md`, `design/delivery.md`.

**Architecture:** pnpm monorepo — `apps/api` (Fastify 5 + Drizzle + Postgres), `apps/web` (React 18 + Vite + Tailwind v4), `packages/shared` (zod schemas = the API contract). One Docker container in prod serves `/api` + SPA same-origin. Nightly GitHub Actions cron runs reap → session sweep → recurring generation directly against the DB.

**Tech Stack:** TypeScript (strict), Fastify 5, fastify-type-provider-zod, Drizzle ORM + drizzle-kit, PostgreSQL 16, argon2, pino, Vitest, testcontainers, Playwright, React 18, TanStack Query, React Router, react-hook-form, Tailwind CSS v4, pnpm 9, Node 22.

## Global Constraints

- Money: integer minor units (`bigint` in DB, `number` over the wire as `amountMinor`), never float, never decimal strings in JSON.
- Single currency `'LKR'`; every money table has `currency char(3)` with `CHECK (currency = 'LKR')`.
- All ids UUIDv7 generated in the app layer (`uuidv7` package).
- Dates over the wire: `YYYY-MM-DD`; months: `YYYY-MM`.
- Error envelope on every non-2xx: `{ error: { code, message, details? } }`; codes: `validation_failed`, `unauthorized`, `not_found`, `conflict`, `rate_limited`, `internal`, `demo_unavailable`.
- Cross-user access returns `404`, never `403`.
- Recurring `frequency` column/field is named `frequency` (not `interval` — Postgres keyword).
- Month-end clamp: always computed from the anchor day-of-month in `start_date`, never from the previously clamped date. Required unit test: Jan 31 → Feb 28 → Mar 31.
- Sessions: raw token in cookie only; DB stores SHA-256; 30-day sliding expiry, 90-day absolute cap from `created_at`.
- E2E is exactly 3 Playwright flows: signup, add expense, see it on dashboard. Do not add more.
- Phase 0 (Tasks 1–3) must be complete before any feature work.
- The ownership-isolation integration test is written in Task 8 (first CRUD task), not deferred.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure (target)

```
.gitattributes  .gitignore  .env.example  docker-compose.yml  Dockerfile
pnpm-workspace.yaml  package.json  tsconfig.base.json
.github/workflows/ci.yml  .github/workflows/nightly.yml
packages/shared/src/{index.ts, schemas/{auth,category,expense,budget,recurring,reports}.ts, errors.ts}
apps/api/src/
  index.ts  app.ts  env.ts
  db/{client.ts, schema.ts, migrate.ts}
  drizzle/          (generated SQL migrations)
  plugins/{auth.ts, security.ts}
  lib/{ids.ts, crypto.ts, cursor.ts, csv.ts, dates.ts}
  domain/{budgets.ts, recurring.ts}
  repos/{users.ts, sessions.ts, categories.ts, expenses.ts, budgets.ts, recurring.ts, reports.ts}
  routes/{auth.ts, categories.ts, expenses.ts, budgets.ts, recurring.ts, reports.ts, health.ts}
  jobs/nightly.ts
  seed/demo-data.ts
apps/api/test/{helpers.ts, unit/*.test.ts, integration/*.test.ts}
apps/web/src/
  main.tsx  App.tsx  router.tsx  api/client.ts
  auth/{AuthContext.tsx, useAuth.ts}
  components/ui/*.tsx  styles/tokens.css
  features/{auth,expenses,budgets,categories,recurring,reports}/...
e2e/*.spec.ts  playwright.config.ts
docs/adr/000{1..4}-*.md  docs/architecture.md
```

---

## Phase 0 — Scaffold, Database, CI (Tasks 1–3; blocks all feature work)

### Task 1: Monorepo scaffold

**Files:**
- Create: `.gitattributes`, `.gitignore`, `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/index.ts`, `apps/web` (via `pnpm create vite`)

**Interfaces:**
- Produces: workspace names `@expense/shared`, `@expense/api`, `@expense/web`; root scripts `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` running recursively.

- [ ] **Step 1: .gitattributes first (before any more files)**

```gitattributes
* text=auto eol=lf
```

- [ ] **Step 2: .gitignore**

```gitignore
node_modules/
dist/
.env
*.tsbuildinfo
playwright-report/
test-results/
```

- [ ] **Step 3: Workspace + root package.json**

`pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Root `package.json` (private): `"packageManager": "pnpm@9.15.0"`, `"engines": {"node": ">=22"}`, scripts:

```json
{
  "lint": "eslint . && prettier --check .",
  "typecheck": "pnpm -r --parallel typecheck",
  "test": "pnpm -r test",
  "build": "pnpm -r build",
  "dev": "pnpm --parallel --filter @expense/api --filter @expense/web dev"
}
```

`tsconfig.base.json`: `strict: true`, `target: ES2022`, `module: NodeNext` (api/shared), `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`.

- [ ] **Step 4: Packages**

- `packages/shared`: name `@expense/shared`, exports `./src/index.ts` (placeholder `export const SHARED = true;` until Task 4). Scripts: `typecheck`, `test: vitest run --passWithNoTests`, `build: tsc -p .`.
- `apps/api`: name `@expense/api`, deps: `fastify@^5`, `drizzle-orm`, `postgres` (driver), `zod`, `fastify-type-provider-zod`, `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/static`, `argon2`, `pino`, `uuidv7`; dev: `tsx`, `vitest`, `@testcontainers/postgresql`, `drizzle-kit`. `src/index.ts` placeholder: `console.log("api");`. Scripts: `dev: tsx watch src/index.ts`, `test: vitest run`, `typecheck: tsc --noEmit`, `build: tsc -p .`.
- `apps/web`: `pnpm create vite apps/web --template react-ts`, rename to `@expense/web`, add `typecheck: tsc --noEmit`, `test: vitest run --passWithNoTests`.
- Root dev-deps: `eslint` (flat config, typescript-eslint), `prettier`.

- [ ] **Step 5: Verify**

Run: `pnpm install && pnpm lint && pnpm typecheck && pnpm build`
Expected: all pass; `pnpm dev` starts Vite and prints `api`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo (shared, api, web)"
```

### Task 2: Docker Postgres + Drizzle schema + initial migration

**Files:**
- Create: `docker-compose.yml`, `apps/api/drizzle.config.ts`, `apps/api/src/db/schema.ts`, `apps/api/src/db/client.ts`, `apps/api/src/db/migrate.ts`, `apps/api/drizzle/0000_init.sql` (generated then hand-edited), `apps/api/test/integration/migrations.test.ts`, `apps/api/test/helpers.ts`, `.env.example`

**Interfaces:**
- Produces: `db` (drizzle instance) from `db/client.ts` (`createDb(url): { db, sql }`); all six table objects exported from `db/schema.ts` as `users, sessions, categories, expenses, budgets, recurringRules`; `runMigrations(url)` from `db/migrate.ts`; test helper `startTestDb(): Promise<{ url, stop }>` (testcontainers).

- [ ] **Step 1: docker-compose.yml**

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: expense
      POSTGRES_PASSWORD: expense
      POSTGRES_DB: expense
    ports: ["5432:5432"]
    volumes: [dbdata:/var/lib/postgresql/data]
volumes:
  dbdata:
```

`.env.example`:

```bash
DATABASE_URL=postgres://expense:expense@localhost:5432/expense
SESSION_SECRET=change-me-32-chars-minimum-secret
APP_ORIGIN=http://localhost:5173
# SENTRY_DSN=
```

- [ ] **Step 2: Write failing migration test**

`test/helpers.ts`:

```ts
import { PostgreSqlContainer } from "@testcontainers/postgresql";
export async function startTestDb() {
  const c = await new PostgreSqlContainer("postgres:16").start();
  return { url: c.getConnectionUri(), stop: () => c.stop() };
}
```

`test/integration/migrations.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestDb } from "../helpers";
import { runMigrations } from "../../src/db/migrate";
import postgres from "postgres";

let url: string, stop: () => Promise<unknown>;
beforeAll(async () => ({ url, stop } = await startTestDb()), 120_000);
afterAll(() => stop());

it("applies all migrations and creates the six tables + citext", async () => {
  await runMigrations(url);
  const sql = postgres(url);
  const tables = await sql`select table_name from information_schema.tables where table_schema='public'`;
  const names = tables.map(t => t.table_name);
  for (const t of ["users","sessions","categories","expenses","budgets","recurring_rules"])
    expect(names).toContain(t);
  const ext = await sql`select extname from pg_extension`;
  expect(ext.map(e => e.extname)).toContain("citext");
  await sql.end();
});
```

Run: `pnpm --filter @expense/api test` — Expected: FAIL (`runMigrations` missing).

- [ ] **Step 3: Drizzle schema — transcribe design/schema.md exactly**

`src/db/schema.ts`: all six tables using `pgTable`. Key points (full column detail in `design/schema.md` — follow it column-for-column):

```ts
import { pgTable, uuid, text, boolean, timestamp, bigint, char, date, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),            // citext via hand-edited SQL
  passwordHash: text("password_hash").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
// sessions, categories, expenses, budgets, recurringRules follow schema.md:
// - amount_minor: bigint("amount_minor", { mode: "number" })
// - expenses partial unique: uniqueIndex("expenses_rule_date_uq")
//     .on(t.recurringRuleId, t.date).where(sql`recurring_rule_id is not null`)
// - categories partial unique on (user_id, lower(name)) where archived_at is null
// - all CHECK constraints from schema.md via check(...)
// - FK actions: users CASCADE everywhere; categories RESTRICT on
//   expenses/budgets/recurring_rules; recurring_rule_id SET NULL
```

- [ ] **Step 4: Generate + hand-edit migration**

Run: `pnpm --filter @expense/api exec drizzle-kit generate`
Hand-edit `drizzle/0000_init.sql`: prepend `CREATE EXTENSION IF NOT EXISTS citext;` and change `users.email` type to `citext` with a plain `UNIQUE` constraint. Verify every CHECK from schema.md is present; add any drizzle-kit missed as raw SQL.

`src/db/migrate.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
export async function runMigrations(url: string) {
  const sql = postgres(url, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  await sql.end();
}
```

`src/db/client.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
export function createDb(url: string) {
  const sql = postgres(url);
  return { db: drizzle(sql, { schema }), sql };
}
export type Db = ReturnType<typeof createDb>["db"];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @expense/api test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): six-table schema, initial migration with citext, migration test"
```

### Task 3: CI pipeline

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: workflow `ci` with jobs `checks` (lint→typecheck→test→build) and `e2e` (placeholder until Task 21), plus `deploy` job skeleton gated to push-to-main (hook wired in Task 22).

- [ ] **Step 1: ci.yml**

```yaml
name: ci
on:
  pull_request:
  push: { branches: [main] }
jobs:
  checks:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: expense, POSTGRES_PASSWORD: expense, POSTGRES_DB: expense }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U expense" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://expense:expense@localhost:5432/expense
      TESTCONTAINERS_DISABLED: "1"   # tests use DATABASE_URL when set (helpers.ts, Task 5 refinement)
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
  deploy:
    needs: [checks]
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploy hook wired in Task 22"
```

- [ ] **Step 2: Verify**

Push a branch, open a draft PR, confirm `checks` is green and `deploy` is skipped. Note: `helpers.ts` gets a small change in Task 5 so CI uses the service container instead of testcontainers.

- [ ] **Step 3: Commit**

```bash
git add .github && git commit -m "ci: lint/typecheck/test/build pipeline with Postgres service"
```

## Phase 1 — Shared contract & API foundation (Tasks 4–5)

### Task 4: Shared zod schemas + error envelope

**Files:**
- Create: `packages/shared/src/errors.ts`, `packages/shared/src/schemas/common.ts`, `packages/shared/src/schemas/auth.ts`, `packages/shared/src/schemas/category.ts`, `packages/shared/src/schemas/expense.ts`, `packages/shared/src/schemas/budget.ts`, `packages/shared/src/schemas/recurring.ts`, `packages/shared/src/schemas/reports.ts`, `packages/shared/src/index.ts` (re-exports)
- Test: `packages/shared/src/schemas/schemas.test.ts`

**Interfaces:**
- Produces (consumed by every later task): `ErrorCode` union + `errorEnvelope(code, message, details?)`; zod schemas — `signupBody`, `loginBody`, `userDto`; `categoryDto`, `createCategoryBody`, `patchCategoryBody`; `expenseDto`, `createExpenseBody`, `patchExpenseBody`, `listExpensesQuery`, `listExpensesResponse`; `budgetPutBody`, `budgetsGetQuery`, `budgetsGetResponse`; `recurringRuleDto`, `createRecurringBody`, `patchRecurringBody`; `reportRangeQuery`, `summaryResponse`, `byCategoryResponse`, `trendResponse`, `budgetStatusResponse`, `topExpensesQuery`. Types inferred and exported (`type Expense = z.infer<typeof expenseDto>` etc).

- [ ] **Step 1: Write failing tests** — representative assertions:

```ts
import { describe, it, expect } from "vitest";
import { createExpenseBody, listExpensesQuery, signupBody, budgetPutBody } from "..";

it("rejects non-integer and non-positive amounts", () => {
  expect(createExpenseBody.safeParse({ amountMinor: 10.5, categoryId: crypto.randomUUID(), date: "2026-01-05", description: "x" }).success).toBe(false);
  expect(createExpenseBody.safeParse({ amountMinor: 0,  categoryId: crypto.randomUUID(), date: "2026-01-05", description: "x" }).success).toBe(false);
});
it("caps q at 100 chars and limit at 100", () => {
  expect(listExpensesQuery.safeParse({ q: "a".repeat(101) }).success).toBe(false);
  expect(listExpensesQuery.parse({ limit: "100" }).limit).toBe(100);
});
it("password 8..128", () => {
  expect(signupBody.safeParse({ email: "a@b.c", password: "short" }).success).toBe(false);
});
it("budget amount may be null (clear)", () => {
  expect(budgetPutBody.parse({ categoryId: crypto.randomUUID(), month: "2026-08", amountMinor: null }).amountMinor).toBeNull();
});
```

Run: `pnpm --filter @expense/shared test` — Expected: FAIL.

- [ ] **Step 2: Implement** — key shapes (`common.ts`):

```ts
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)));
export const isoMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const amountMinor = z.number().int().positive();
export const uuid = z.string().uuid();
```

`expense.ts` (pattern for the rest — every field per design/api.md):

```ts
export const createExpenseBody = z.object({
  amountMinor, categoryId: uuid, date: isoDate,
  description: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
});
export const patchExpenseBody = createExpenseBody.partial();
export const listExpensesQuery = z.object({
  from: isoDate.optional(), to: isoDate.optional(),
  categoryIds: z.string().transform(s => s.split(",")).pipe(z.array(uuid)).optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const expenseDto = z.object({
  id: uuid, categoryId: uuid, recurringRuleId: uuid.nullable(),
  amountMinor, currency: z.literal("LKR"), date: isoDate,
  description: z.string(), notes: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(),
});
export const listExpensesResponse = z.object({
  items: z.array(expenseDto), nextCursor: z.string().nullable(),
  totalCount: z.number().int().optional(), totalAmountMinor: z.number().int().optional(),
});
```

`errors.ts`:

```ts
export const ERROR_CODES = ["validation_failed","unauthorized","not_found","conflict","rate_limited","internal","demo_unavailable"] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export const errorEnvelope = (code: ErrorCode, message: string, details?: unknown) =>
  ({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
```

`recurring.ts`: `frequency: z.enum(["weekly","monthly"])`, `startDate: isoDate`, `endDate: isoDate.optional()` + `.refine(end >= start)`. `budget.ts`: `budgetPutBody = { categoryId: uuid, month: isoMonth, amountMinor: z.number().int().min(0).nullable() }`. `reports.ts`: `reportRangeQuery = { from: isoDate, to: isoDate }` with `from <= to` refine + 5-year span refine.

- [ ] **Step 3: Run tests** — Expected: PASS. **Step 4: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): zod API contract + error envelope"
```

### Task 5: Fastify app factory, env, health, error handler, security baseline

**Files:**
- Create: `apps/api/src/env.ts`, `apps/api/src/app.ts`, `apps/api/src/routes/health.ts`, `apps/api/src/plugins/security.ts`, `apps/api/src/lib/ids.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/test/helpers.ts`
- Test: `apps/api/test/integration/app.test.ts`

**Interfaces:**
- Produces: `buildApp({ db, env }): FastifyInstance` (zod type provider, pino with request ids honoring `x-request-id`, helmet+CSP self-only, global rate limit 300/min, body limit 32 KB, error handler emitting the envelope); `loadEnv()` (zod-validated `DATABASE_URL`, `SESSION_SECRET` ≥32 chars, `APP_ORIGIN`, optional `SENTRY_DSN`, `PORT` default 3000); `newId()` (uuidv7); test helper `makeTestApp(): Promise<{ app, db, stop }>` — starts DB (testcontainers, or `DATABASE_URL` when `TESTCONTAINERS_DISABLED=1` in CI), runs migrations, builds app.

- [ ] **Step 1: Failing tests**

```ts
it("GET /health -> 200 ok+version", async () => {
  const r = await app.inject({ method: "GET", url: "/health" });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toMatchObject({ status: "ok" });
});
it("unknown route -> 404 envelope", async () => {
  const r = await app.inject({ method: "GET", url: "/api/nope" });
  expect(r.json().error.code).toBe("not_found");
});
it("validation failure -> 400 envelope with details", async () => {
  // any zod-validated route once one exists; use a probe route registered in test
});
```

- [ ] **Step 2: Implement** — `app.ts` core:

```ts
export async function buildApp({ db, env }: { db: Db; env: Env }) {
  const app = fastify({
    logger: { level: "info" },
    genReqId: req => (req.headers["x-request-id"] as string) ?? newId(),
    bodyLimit: 32 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(securityPlugin, { env });     // helmet(CSP self), rate-limit global, cookie
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err))
      return reply.code(400).send(errorEnvelope("validation_failed", "Invalid request", err.validation));
    if (err.statusCode === 429) return reply.code(429).send(errorEnvelope("rate_limited", "Too many requests"));
    req.log.error({ err }, "unhandled");
    return reply.code(500).send(errorEnvelope("internal", "Internal error"));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorEnvelope("not_found", "Not found")));
  await app.register(healthRoutes, { db });
  return app;
}
```

`index.ts`: `loadEnv()` → `runMigrations` (fail-closed: exit 1 on error) → `createDb` → `buildApp` → `listen({ port, host: "0.0.0.0" })`. `helpers.ts`: honor `TESTCONTAINERS_DISABLED` by using `process.env.DATABASE_URL` (create a fresh schema-per-suite via random schema name to keep suites isolated).

- [ ] **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): app factory, env validation, health, error envelope, security baseline`

## Phase 2 — Auth & sessions (Tasks 6–7)

### Task 6: Session + user repos, signup/login/logout/me, auth plugin

**Files:**
- Create: `apps/api/src/lib/crypto.ts`, `apps/api/src/repos/users.ts`, `apps/api/src/repos/sessions.ts`, `apps/api/src/repos/categories.ts` (seed-defaults insert only), `apps/api/src/plugins/auth.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/lib/password-blocklist.ts` (top-10k list, bundled)
- Test: `apps/api/test/integration/auth.test.ts`, `apps/api/test/unit/crypto.test.ts`

**Interfaces:**
- Produces: `hashPassword/verifyPassword` (argon2id); `createSessionToken(): { token, tokenHash }` (256-bit random, sha256 hex); `sessionsRepo.create(userId): token`, `.findValid(tokenHash): { userId, session } | null` (checks expiry; applies sliding refresh >24h capped at `createdAt + 90d`), `.delete(tokenHash)`, `.deleteAllForUser(userId)`; `authPlugin` decorating `req.userId` (throws 401 envelope when absent) + `app.authenticate` preHandler; routes per design/api.md `### Auth` table; `usersRepo.create` seeds the 8 default categories (Food, Transport, Rent, Utilities, Health, Entertainment, Shopping, Other) in the same transaction.
- Consumes: `buildApp` (Task 5), schemas (Task 4).

- [ ] **Step 1: Failing tests** — the full auth matrix:

```ts
it("signup 201 sets httpOnly cookie, creates 8 default categories");
it("signup duplicate email -> 409 conflict");
it("login wrong password and unknown email -> identical 401 body");
it("me without cookie -> 401; with cookie -> user (no passwordHash key)");
it("logout -> 204, cookie cleared, session row gone, me -> 401");
it("login rotates token: old cookie invalid after new login");
it("session absolute cap: session created 91d ago (row backdated) -> 401 even if recently used");
it("common password 'password1234' -> 400 validation_failed");
```

Backdate rows by direct `db.update(sessions)` in the test.

- [ ] **Step 2: Implement.** Cookie: `session`, `httpOnly, sameSite: "lax", path: "/", secure: env.APP_ORIGIN.startsWith("https")`, maxAge 30d. Login runs `verifyPassword` against a fixed dummy hash when the email is unknown (timing uniformity), then returns the same envelope. `auth.ts` route bodies are thin: parse (schemas) → repo call → reply; no SQL in routes.

- [ ] **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): cookie-session auth with rotation, sliding+capped expiry, seeded categories`

### Task 7: CSRF origin check + per-route rate limits

**Files:**
- Modify: `apps/api/src/plugins/security.ts`, `apps/api/src/routes/auth.ts`
- Test: `apps/api/test/integration/security.test.ts`

**Interfaces:**
- Produces: `onRequest` hook — mutating methods (POST/PATCH/PUT/DELETE) with an `Origin` header not equal to `env.APP_ORIGIN` → 403 envelope (`unauthorized` code, message "Origin mismatch"); absent Origin allowed (non-browser clients). Route-level rate limits: login 10/min, signup 10/min, demo 5/min (demo route lands in Task 15 — configure the limiter map now).

- [ ] **Step 1: Failing tests**

```ts
it("POST with wrong Origin -> 403; correct Origin -> passes");
it("GET with wrong Origin -> unaffected");
it("11th login attempt in a minute -> 429 rate_limited envelope");
```

- [ ] **Step 2: Implement** (limits via `@fastify/rate-limit` route config; keyed by IP). **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): CSRF origin verification and auth rate limits`

## Phase 3 — Core CRUD (Tasks 8–10)

### Task 8: Categories + Expenses CRUD, with ownership-isolation tests (NOT deferred)

**Files:**
- Create: `apps/api/src/routes/categories.ts`, `apps/api/src/repos/expenses.ts`, `apps/api/src/routes/expenses.ts`
- Modify: `apps/api/src/repos/categories.ts` (full CRUD), `apps/api/src/app.ts` (register routes)
- Test: `apps/api/test/integration/categories.test.ts`, `apps/api/test/integration/expenses-crud.test.ts`, `apps/api/test/integration/ownership.test.ts`

**Interfaces:**
- Produces: `categoriesRepo.{listAll, create, rename, setArchived}`; `expensesRepo.{create, patch, delete, findById}` — **every repo method's first parameter is `userId` and every WHERE includes it**; routes per design/api.md. `expensesRepo.create/patch` validate `categoryId` belongs to the user and is active (`400` archived / `404` not owned).
- Consumes: `authPlugin` (Task 6), schemas (Task 4).

- [ ] **Step 1: Write the ownership-isolation test FIRST** (`ownership.test.ts`):

```ts
// Setup: signup userA and userB via API; A creates category catA + expense expA.
it("B cannot read A's expense -> 404",            async () => expect((await asB.get(`/api/expenses/${expA.id}`)).statusCode).toBe(404));
it("B cannot PATCH A's expense -> 404",           async () => expect((await asB.patch(`/api/expenses/${expA.id}`, { description: "x" })).statusCode).toBe(404));
it("B cannot DELETE A's expense -> 404 (and it survives)");
it("B cannot use A's categoryId when creating -> 404");
it("B cannot rename/archive A's category -> 404");
it("B PUT budget on A's category -> 404");        // enabled when budgets land (Task 11) — write it.skip now, unskip in Task 11
it("B's expense list never contains A's rows");
```

All must assert `404` with the envelope — never `403` (existence not leaked).

- [ ] **Step 2: Failing CRUD tests** — categories: create/rename/archive/unarchive, dup-active-name 409, unarchive-collision 409, archived excluded from "active" but present with `archivedAt` in list; expenses: create 201 echoes dto, patch partial, delete 204, amountMinor 10.5 / 0 / -5 → 400, future date > 1y → 400, archived category on create → 400.

- [ ] **Step 3: Implement.** Repo pattern (the contract every later repo follows):

```ts
export function expensesRepo(db: Db) {
  return {
    async findById(userId: string, id: string) {
      return db.query.expenses.findFirst({ where: and(eq(expenses.userId, userId), eq(expenses.id, id)) }) ?? null;
    },
    // create/patch/delete same shape; patch sets updatedAt: new Date()
  };
}
```

Routes translate `null` → `404` envelope. Register under `/api` prefix with `app.authenticate` preHandler.

- [ ] **Step 4: Run** — all PASS (isolation suite green except the one `it.skip`). **Step 5: Commit** `feat(api): categories + expenses CRUD with ownership isolation tests`

### Task 9: Expense list — filters + keyset pagination + first-page totals

**Files:**
- Create: `apps/api/src/lib/cursor.ts`
- Modify: `apps/api/src/repos/expenses.ts`, `apps/api/src/routes/expenses.ts`
- Test: `apps/api/test/unit/cursor.test.ts`, `apps/api/test/integration/expenses-list.test.ts`

**Interfaces:**
- Produces: `encodeCursor({ date, id }): string` / `decodeCursor(s): { date, id } | null` (base64url JSON; invalid → null → 400); `expensesRepo.list(userId, { from, to, categoryIds, q, cursor, limit }): { items, nextCursor }` ordered `date DESC, id DESC` using tuple comparison `(date, id) < (cursor.date, cursor.id)`; `expensesRepo.totals(userId, filters): { totalCount, totalAmountMinor }` (SQL `count(*)`, `coalesce(sum(amount_minor),0)`).

- [ ] **Step 1: Failing tests**

```ts
// unit: cursor round-trip; tampered string -> null
// integration:
it("orders date DESC id DESC; page walk yields no dups/gaps across 3 pages of 2");
it("same-date rows paginate stably by id tiebreak");
it("first page includes totals matching filters; cursor page omits both");
it("filters compose: from+to+categoryIds+q");
it("q ILIKEs description, max 100 chars enforced");
```

- [ ] **Step 2: Implement** (`sql\`(date, id) < (${d}, ${id})\`` tuple keyset). **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): filtered keyset-paginated expense list with first-page totals`

### Task 10: CSV export

**Files:**
- Create: `apps/api/src/lib/csv.ts`
- Modify: `apps/api/src/routes/expenses.ts`
- Test: `apps/api/test/unit/csv.test.ts`, `apps/api/test/integration/export.test.ts`

**Interfaces:**
- Produces: `csvRow(fields: string[]): string` (RFC 4180: quote when field contains `",\n`; double embedded quotes); `minorToDecimalString(n): string` (`125000` → `"1250.00"`); `GET /api/expenses/export.csv` — streams, header `date,category,description,notes,amount,currency`, UTF-8 BOM first, `content-disposition: attachment; filename="expenses.csv"`, same filters as list, no pagination.

- [ ] **Step 1: Failing tests** — unit: quoting matrix (`a,b`, `he said "hi"`, newline, unicode); `minorToDecimalString(5)` → `"0.05"`; integration: BOM present (`body[0..2] === EF BB BF`), rows match filters, category name (not id) in column 2.
- [ ] **Step 2: Implement** (stream via async iterator over repo pages; join rows with `\r\n`). **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): RFC4180 CSV export honoring list filters`

## Phase 4 — Budgets & Reports (Tasks 11–12)

### Task 11: Budgets — effective-from model

**Files:**
- Create: `apps/api/src/domain/budgets.ts`, `apps/api/src/repos/budgets.ts`, `apps/api/src/routes/budgets.ts`
- Modify: `apps/api/test/integration/ownership.test.ts` (unskip budget case)
- Test: `apps/api/test/unit/budgets-domain.test.ts`, `apps/api/test/integration/budgets.test.ts`

**Interfaces:**
- Produces: pure `resolveEffective(rows: { monthStart, amountMinor }[], month): { amountMinor, effectiveFrom } | null` (greatest `monthStart <= month`; NULL amount ⇒ null result with provenance preserved — returns `{ amountMinor: null, effectiveFrom }` distinct from "no row": both render as unbudgeted, provenance differs); `budgetsRepo.effectiveForMonth(userId, month)` (one SQL query: `DISTINCT ON (category_id) ... WHERE month_start <= $month ORDER BY category_id, month_start DESC`, joined to active categories); `.put(userId, categoryId, month, amountMinor|null)` upsert on the unique triple; routes per api.md (`GET /api/budgets?month=`, `PUT /api/budgets`; PUT → 404 not-owned category, 400 archived).

- [ ] **Step 1: Failing unit tests**

```ts
it("no rows -> null");
it("row in earlier month carries forward");
it("later row overrides from its month on; earlier months keep old value");
it("NULL amount clears from that month forward; earlier months unaffected");
it("row in future month does not apply to current");
```

- [ ] **Step 2: Failing integration tests** — PUT then GET across months (set Jan=10000, Mar=NULL, ask Feb → 10000, ask Mar → unbudgeted, ask Apr → unbudgeted); upsert same triple updates; archived category PUT → 400; **unskip the ownership budget case**.
- [ ] **Step 3: Implement.** **Step 4: Run** — PASS incl. full ownership suite. **Step 5: Commit** `feat(api): effective-from budgets with clear-forward semantics`

### Task 12: Reports — five endpoints, all aggregation in SQL

**Files:**
- Create: `apps/api/src/repos/reports.ts`, `apps/api/src/routes/reports.ts`, `apps/api/src/lib/dates.ts`
- Test: `apps/api/test/unit/dates.test.ts`, `apps/api/test/integration/reports.test.ts`

**Interfaces:**
- Produces: `lib/dates.ts` — `monthRange(month): { from, to }`, `prevPeriod(from, to): { from, to }` (immediately preceding period of equal length), `monthsBetween(from, to): string[]` (for zero-fill); `reportsRepo` — `summary(userId, from, to)`, `byCategory(userId, from, to)`, `trend(userId, from, to)` (SQL `date_trunc('month', date)` GROUP BY, zero-filled in JS from `monthsBetween` — filling isn't aggregation), `budgetStatus(userId, month)` (joins `budgetsRepo.effectiveForMonth` + spent per category), `topExpenses(userId, from, to, limit)`; routes per api.md `### Reports` table. Every sum is `coalesce(sum(amount_minor), 0)::bigint` in SQL — no JS summation anywhere.

- [ ] **Step 1: Failing tests** — seed a fixed dataset (3 categories, 2 months, known amounts), assert exact numbers: summary totals + `deltaPct` vs previous period (and `prevPeriodTotalMinor: 0` edge → `deltaPct: null`); by-category shares sum to 1 (±ε); trend zero-fills empty middle month; budget-status pct math incl. unbudgeted (`pct: null`) and over-100% cases; top-expenses limit + ordering; `from > to` → 400; span > 5y → 400.
- [ ] **Step 2: Implement.** **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): report endpoints with SQL aggregation`

## Phase 5 — Recurring expenses (Tasks 13–14)

### Task 13: Occurrence math (pure domain) + rules CRUD

**Files:**
- Create: `apps/api/src/domain/recurring.ts`, `apps/api/src/repos/recurring.ts`, `apps/api/src/routes/recurring.ts`
- Test: `apps/api/test/unit/recurring-domain.test.ts`, `apps/api/test/integration/recurring-crud.test.ts`

**Interfaces:**
- Produces (pure, date strings in/out, no Date-object timezone traps — use `YYYY-MM-DD` string math via a tiny `{y,m,d}` parser in the module):
  - `nextOccurrence(rule: { frequency, startDate }, after: string): string` — smallest occurrence date `> after`. Weekly: `startDate + 7k`. Monthly: **anchor day taken from `startDate` every time, clamped to the target month's last day** — never derived from a previously clamped date.
  - `firstOccurrenceOnOrAfter(rule, date): string` — for no-backfill initialization.
  - `occurrencesThrough(rule, from: string, through: string): string[]` — for generator catch-up, respects `endDate`.
- `recurringRepo.{list, create, patch, delete}` (userId-first, ownership as Task 8); routes per api.md: create initializes `nextOccurrence = firstOccurrenceOnOrAfter(rule, today)`; PATCH recomputes it (never in the past); DELETE relies on FK SET NULL.

- [ ] **Step 1: Failing unit tests — the clamp matrix (REQUIRED by spec):**

```ts
it("Jan 31 -> Feb 28 -> Mar 31 (anchor preserved, no drift)", () => {
  const rule = { frequency: "monthly", startDate: "2026-01-31" } as const;
  const feb = nextOccurrence(rule, "2026-01-31"); expect(feb).toBe("2026-02-28");
  const mar = nextOccurrence(rule, feb);          expect(mar).toBe("2026-03-31");
});
it("leap year: anchor 31 -> 2028-02-29");
it("anchor 30 over February; anchor 29 non-leap");
it("weekly steps 7 days across month/year boundaries");
it("occurrencesThrough respects endDate inclusive and returns [] when from > through");
it("firstOccurrenceOnOrAfter with past startDate lands on today-or-later (no backfill)");
```

- [ ] **Step 2: Implement domain** (monthly: `target = addMonths(anchorMonth, k); day = min(anchorDay, daysInMonth(target))`). **Step 3: Failing CRUD integration tests** (create echoes computed `nextOccurrence`; past `startDate` → first occurrence ≥ today; PATCH frequency recomputes; ownership 404s). **Step 4: Implement routes/repo.** **Step 5: Run** — PASS. **Step 6: Commit** `feat(api): recurring rules with anchor-clamped occurrence math`

### Task 14: Generator — idempotent catch-up

**Files:**
- Create: `apps/api/src/jobs/generate-recurring.ts`
- Test: `apps/api/test/integration/generator.test.ts`

**Interfaces:**
- Produces: `generateRecurring(db, today: string): Promise<{ rulesProcessed, inserted }>` — per rule due (`next_occurrence <= today`), in one transaction per rule: insert expense rows for `occurrencesThrough(rule, next_occurrence, today)` (each `{ ...rule fields, recurringRuleId: rule.id, date: occ }`), advance `next_occurrence` past `today` (or beyond `endDate` ⇒ rule simply never matches again). `ON CONFLICT DO NOTHING` against `expenses_rule_date_uq` as the concurrency backstop.
- Consumes: `occurrencesThrough`, `nextOccurrence` (Task 13).

- [ ] **Step 1: Failing tests**

```ts
it("due rule inserts occurrence, advances next_occurrence");
it("3 missed days on a weekly rule -> catch-up inserts exactly the missed occurrences");
it("running twice inserts nothing the second time (idempotent)");
it("endDate passed -> no insert, next_occurrence advanced beyond endDate");
it("monthly rule catch-up across Feb applies clamp end-to-end");
it("concurrent double-run: simulate by pre-inserting the occurrence row -> DO NOTHING, no throw");
```

- [ ] **Step 2: Implement.** **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): idempotent catch-up recurring generator`

## Phase 6 — Demo accounts & nightly job (Tasks 15–16)

### Task 15: Ephemeral demo provisioning

**Files:**
- Create: `apps/api/src/seed/demo-data.ts`
- Modify: `apps/api/src/routes/auth.ts`, `apps/api/src/repos/users.ts`
- Test: `apps/api/test/integration/demo.test.ts`, `apps/api/test/unit/demo-data.test.ts`

**Interfaces:**
- Produces: `demoDataset(today: string): { categories, expenses, budgets, recurringRules }` — deterministic-shape generator, ~6 months of realistic LKR data relative to `today` (rent 85,000_00 monthly recurring, groceries weekly ~12,000_00 with jitter seeded from a fixed PRNG, utilities/transport/entertainment spread, budgets for 5 categories, 2–3 rules); `POST /api/auth/demo` per api.md: count live demo users → ≥100 ⇒ 503 `demo_unavailable`; else create user (`is_demo`, email `demo-<uuid>@demo.invalid`, random unusable hash), insert dataset, issue session — one transaction, 201.
- Consumes: sessions (Task 6), rate limit 5/min (configured Task 7).

- [ ] **Step 1: Failing tests** — unit: dataset spans ~6 months ending today, all amounts positive ints, only default category names; integration: demo login 201 + cookie + `isDemo: true`; two demo logins get disjoint userIds and disjoint data; capacity: insert 100 demo users → 503 envelope `demo_unavailable`.
- [ ] **Step 2: Implement.** **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): per-visitor ephemeral demo accounts with seeded dataset`

### Task 16: Nightly job — reap → sweep → generate; local seed script

**Files:**
- Create: `apps/api/src/jobs/nightly.ts`, `apps/api/src/jobs/seed-local.ts`, `.github/workflows/nightly.yml`
- Test: `apps/api/test/integration/nightly.test.ts`

**Interfaces:**
- Produces: `runNightly(db, now): Promise<{ reaped, sweptSessions, rulesProcessed, inserted, failures: string[] }>` — steps **in order**: (1) delete demo users `created_at < now - 24h` (cascades), (2) delete sessions `expires_at < now`, (3) `generateRecurring`. Each step in its own try/catch — a failure records to `failures` and the next step still runs; the CLI wrapper `nightly.ts` logs counts and **`process.exit(1)` if `failures.length > 0`**. Workflow: `schedule: cron "30 20 * * *"` (02:00 Asia/Colombo) + `workflow_dispatch`, runs `pnpm --filter @expense/api exec tsx src/jobs/nightly.ts` with `DATABASE_URL` from secrets.
- Consumes: `generateRecurring` (Task 14).

- [ ] **Step 1: Failing tests** — old demo user reaped with all data, fresh one kept; expired session gone, valid kept; recurring ran; **step-2 failure injected (mock) → steps 1 and 3 still ran and result.failures is non-empty**.
- [ ] **Step 2: Implement + `seed-local.ts`** (dev user `dev@local.test` / `devpassword1` + demo dataset; `pnpm seed` root script). **Step 3: Run** — PASS. **Step 4: Commit** `feat(api): nightly reap/sweep/generate job with fail-loud semantics`

## Phase 7 — Frontend foundation (Tasks 17–18)

### Task 17: Design tokens, UI kit, API client, auth context, router shell

**Files:**
- Create: `apps/web/src/styles/tokens.css`, `apps/web/src/components/ui/{Button,Input,Select,SlideOver,Table,DateRangePicker,EmptyState,Skeleton,MoneyText}.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/auth/AuthContext.tsx`, `apps/web/src/router.tsx`, `apps/web/src/lib/money.ts`, `apps/web/vite.config.ts` (proxy), self-hosted Inter in `apps/web/public/fonts/`
- Test: `apps/web/src/lib/money.test.ts`, `apps/web/src/api/client.test.ts`

**Interfaces:**
- Produces: `formatLKR(amountMinor: number): string` (`125000` → `"Rs 1,250.00"`; the ONLY money formatter — components use `<MoneyText amountMinor={n}/>`); `apiFetch<T>(schema, path, init?): Promise<T>` — prepends `/api`, `credentials: "include"`, parses response with the shared zod schema, throws `ApiError { code, message, status }` from the envelope; on 401 dispatches `auth:expired` event (AuthContext listens → redirect to `/login?next=`); `useAuth(): { user, signup, login, demo, logout }` bootstrapped from `GET /api/auth/me`; router: public `/login`, `/signup`; authed layout (sidebar nav) wrapping `/`, `/expenses`, `/budgets`, `/settings`, route-level `lazy()`.
- Tokens (Linear direction, from design/delivery.md): dark-first `:root` palette — bg `#0e0f11`, surface `#17181b`, border `#26282d`, text `#e6e7e9`, muted `#8a8f98`, accent `#5e6ad2`; light theme via `[data-theme="light"]`; spacing on the 8px grid; `font-variant-numeric: tabular-nums` utility class applied by `MoneyText` and table cells; Inter via `@font-face` (self-hosted — CSP has no font CDN).
- Consumes: shared schemas/types (Task 4).

- [ ] **Step 1: Failing unit tests** — `formatLKR(5)` → `"Rs 0.05"`, `formatLKR(125000)` → `"Rs 1,250.00"`, `formatLKR(100000000)` → `"Rs 1,000,000.00"`; `apiFetch` throws `ApiError` with envelope code on 4xx (mock `fetch`), parses success through schema.
- [ ] **Step 2: Implement** (Tailwind v4 `@theme` from tokens; Vite proxy `/api → http://localhost:3000`). **Step 3: Run + eyeball** `pnpm dev` shows login shell. **Step 4: Commit** `feat(web): tokens, UI kit, typed API client, auth context, router`

### Task 18: Auth pages + demo button

**Files:**
- Create: `apps/web/src/features/auth/{LoginPage,SignupPage}.tsx`

**Interfaces:**
- Consumes: `useAuth`, shared `signupBody`/`loginBody` via react-hook-form zod resolver.
- Produces: working login/signup with inline field errors (from zod) and API error banner (envelope message); "Try the demo" button → `POST /api/auth/demo` → navigate `/`; demo capacity 503 renders its message.

- [ ] **Step 1: Implement** (forms per delivery.md; redirect-back via `?next=`). **Step 2: Verify manually** against local API: signup → lands on `/`; wrong password shows single opaque error; demo button works. **Step 3: Commit** `feat(web): auth pages with demo login`

## Phase 8 — Feature pages (Tasks 19–20)

### Task 19: Expenses page (table, filters, infinite scroll, slide-over CRUD, export)

**Files:**
- Create: `apps/web/src/features/expenses/{ExpensesPage,ExpenseTable,FilterBar,ExpenseForm,useExpenses.ts}.tsx`, `apps/web/src/features/categories/useCategories.ts`

**Interfaces:**
- Produces: `useExpenses(filters)` — TanStack `useInfiniteQuery` keyed `["expenses", filters]`, page param = cursor; mutations `useCreateExpense` (optimistic insert into first page, rollback on error), `useUpdateExpense`, `useDeleteExpense` (confirm then invalidate); page per delivery.md: dense table (date, category, description + notes dot, right-aligned tabular amount), filter bar (date range, category multi-select incl. archived, debounced 300ms search), first-page totals row, slide-over `ExpenseForm` (shared-schema resolver) for add/edit, delete confirm, "Export CSV" anchor → `/api/expenses/export.csv?<current filters>`.
- Consumes: `apiFetch`, `listExpensesQuery`/`listExpensesResponse` types, UI kit.

- [ ] **Step 1: Implement hooks then page.** Empty/loading/error states explicit (EmptyState with "Add your first expense" CTA; Skeleton rows; error retry). **Step 2: Verify manually** with seeded local data: filter compose, infinite scroll no-dup, optimistic add rollback (kill API mid-add), export downloads filtered CSV. **Step 3: Commit** `feat(web): expenses page`

### Task 20: Dashboard, Budgets, Settings pages + SVG charts

**Files:**
- Create: `apps/web/src/components/charts/{LineChart,BarList}.tsx`, `apps/web/src/features/reports/{DashboardPage,useReports.ts}`, `apps/web/src/features/budgets/{BudgetsPage,useBudgets.ts}`, `apps/web/src/features/categories/CategoriesPanel.tsx`, `apps/web/src/features/recurring/{RecurringPanel,RuleForm}.tsx`, `apps/web/src/features/settings/SettingsPage.tsx`

**Interfaces:**
- Produces: `LineChart({ points: {x,y}[] })` and `BarList({ rows: {label, value, max, annotation?}[] })` — plain SVG/div, no chart lib, tabular-nums; Dashboard: date-range picker (default current month) driving `useReports` queries (summary stat row with delta, budget-status BarList, 6-month trend LineChart, by-category BarList, top-5 list); Budgets: month picker, rows of effective budget ("since <month>" provenance from `effectiveFrom`), spent/remaining/pct bar, inline edit (PUT), clear action (PUT null); Settings: categories panel (add/rename/archive/unarchive, archived collapsed) + recurring panel (list with next occurrence, create/edit/delete via `RuleForm`, "future occurrences only" copy).
- Consumes: report/budget/recurring schemas, UI kit, `formatLKR`.

- [ ] **Step 1: Implement charts (unit-testable pure path math ok to skip — visual verify).** **Step 2: Implement pages.** **Step 3: Verify manually** against demo dataset: numbers reconcile with the expenses table (spot-check one category's month total), over-budget renders, clear-budget flows. **Step 4: Commit** `feat(web): dashboard, budgets, settings`

## Phase 9 — E2E, deploy, docs (Tasks 21–23)

### Task 21: Playwright E2E — exactly 3 flows

**Files:**
- Create: `playwright.config.ts`, `e2e/{signup.spec.ts, add-expense.spec.ts, dashboard.spec.ts}`
- Modify: `.github/workflows/ci.yml` (e2e job)

**Interfaces:**
- Consumes: built app (`apps/api` serving built `apps/web` via `@fastify/static` — wire static serving + SPA fallback into `app.ts` here, env `STATIC_DIR`), CI Postgres service.
- Produces: 3 specs, nothing more (spec constraint): (1) signup with unique email → dashboard heading visible; (2) add expense via slide-over → row appears in table; (3) that expense's amount reflected in dashboard summary + category breakdown. CI `e2e` job: `needs: checks`, build → migrate → start server → `playwright test`.

- [ ] **Step 1: Wire static serving + write specs (webServer in playwright.config launches the built server).** **Step 2: Run locally** — 3 PASS. **Step 3: CI green.** **Step 4: Commit** `test(e2e): three smoke flows; api serves built SPA`

### Task 22: Dockerfile + Render/Neon deploy

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `.github/workflows/ci.yml` (deploy job real)

**Interfaces:**
- Produces: multi-stage Dockerfile (pnpm fetch → build all → prune prod → runtime `node:22-slim` running `node apps/api/dist/index.js` with `STATIC_DIR=apps/web/dist`); boot = migrate fail-closed then listen (already Task 5); deploy job replaces echo with `curl -fsS "$RENDER_DEPLOY_HOOK"` (secret), still `needs: [checks, e2e]` + push-to-main condition.
- Manual (documented in README, done by user): create Neon DB + Render service (Docker, health check `/health`), set env (`DATABASE_URL`, `SESSION_SECRET`, `APP_ORIGIN=https://<app>.onrender.com`), add GitHub secrets `RENDER_DEPLOY_HOOK`, `DATABASE_URL` (for nightly), configure uptime pinger on `/health`.

- [ ] **Step 1: Dockerfile + local verify** `docker build . && docker run` against compose Postgres → app serves SPA + API. **Step 2: Wire deploy job.** **Step 3: Deploy, verify live demo flow end-to-end.** **Step 4: Commit** `feat(deploy): production image and Render deploy on main`

### Task 23: README, ADRs, architecture doc

**Files:**
- Create: `README.md`, `docs/adr/0001-sessions-over-jwt.md`, `docs/adr/0002-integer-minor-units-for-money.md`, `docs/adr/0003-aggregation-in-sql.md`, `docs/adr/0004-ephemeral-demo-users.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: everything shipped; content requirements in design/delivery.md `## Documentation`.
- Produces: README (hero screenshot, live link + cold-start note, features, `docker compose up` + `pnpm i && pnpm dev` + `pnpm seed` quickstart, architecture sketch, ADR links); each ADR = Context / Decision / Consequences / Alternatives-rejected (≤1 page); architecture.md: monorepo map, request lifecycle, auth flow diagram (mermaid), cron design.

- [ ] **Step 1: Screenshots from the live demo.** **Step 2: Write docs.** **Step 3: Commit** `docs: README, four ADRs, architecture overview`

---

## Self-Review (performed)

- **Spec coverage:** schema.md → Task 2 (all six tables, citext, checks, indexes); api.md → Tasks 4–12, 15 (all routes incl. demo 503, envelope codes, session caps, CSRF, rate limits, first-page totals, q cap); delivery.md → Tasks 17–23 (pages, tokens, tests per layer, CI gating, nightly order + fail-loud, ADRs, uptime pinger). Ordering constraints honored: Phase 0 = Tasks 1–3 before all feature work; ownership isolation written in Task 8 (first CRUD task) with one explicitly-marked skip unskipped in Task 11.
- **Placeholder scan:** no TBDs; Task 3's deploy echo and Task 8's `it.skip` are deliberate, tracked, and closed in Tasks 22 and 11 respectively.
- **Type consistency:** repo methods are userId-first throughout; `nextOccurrence`/`occurrencesThrough`/`firstOccurrenceOnOrAfter` names match between Tasks 13–16; `formatLKR`, `apiFetch`, `errorEnvelope`, `runMigrations`, `buildApp`, `makeTestApp` used consistently under one name each.
