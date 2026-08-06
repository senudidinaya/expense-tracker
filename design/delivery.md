# Frontend, Testing, CI & Deployment — v1 (Final)

Companion to `design/schema.md` and `design/api.md`.

## Frontend stack

- React 18 + Vite + TypeScript (`apps/web`).
- **Server state:** TanStack Query — all API data flows through it (caching,
  invalidation, optimistic updates). No Redux/Zustand; there is no client
  state complex enough to justify one.
- **Routing:** React Router, route-level code splitting.
- **Forms:** react-hook-form + zod resolvers using the exact schemas from
  `packages/shared` — client and server validate with the same code.
- **Styling:** Tailwind CSS v4 with a design-token layer implementing the
  Linear direction: dark-first (light theme included), near-monochrome
  gray scale, single accent color, 8px spacing grid, dense data tables,
  `Inter` self-hosted (CSP is self-only; no font CDN),
  `font-variant-numeric: tabular-nums` on all numeric UI.
- **Charts:** small in-repo SVG chart layer (line + horizontal bars). No
  external chart library — keeps the bundle lean and the CSP strict.
- **Money display:** a single `formatLKR(amountMinor)` utility (unit
  tested); no component formats money by hand.

## Pages (5)

1. **Auth** (`/login`, `/signup`) — email+password forms, inline validation
   errors from shared schemas, "Try the demo" button (calls
   `POST /api/auth/demo`), redirect-back after login.
2. **Expenses** (`/expenses`) — the workhorse screen:
   - Dense table: date, category, description (notes indicator), amount
     (right-aligned, tabular).
   - Filter bar: date-range picker, category multi-select, search box
     (debounced `q`).
   - Keyset-paginated infinite scroll (cursor from the API).
   - First-page totals (count + sum) shown above the table.
   - Slide-over panel for add/edit; add is optimistic (rolls back on
     error). Delete with undo-style confirm.
   - CSV export button — downloads `export.csv` honoring current filters.
3. **Dashboard** (`/`) — global date-range picker (defaults to current
   month); summary stat row (total, count, average, delta vs previous
   period); spend-vs-budget bars per category (current month); monthly
   trend line (default 6 months); category breakdown; top-5 expenses.
4. **Budgets** (`/budgets`) — month picker; per-category rows showing
   effective budget (with "since &lt;month&gt;" provenance), spent, remaining,
   percent bar; inline edit; clear-budget action (sets null forward).
5. **Settings** (`/settings`) — two panels:
   - Categories: add, rename, archive/unarchive; archived shown collapsed.
   - Recurring rules: list with next-occurrence date; create/edit/delete;
     "future occurrences only" copy on the form.

## Component approach

- `src/components/ui/` — small primitive kit (Button, Input, Select,
  Dialog/SlideOver, Table, DateRangePicker, EmptyState, Skeleton), styled
  with the token layer; no external component library.
- `src/features/<domain>/` — expenses, budgets, categories, recurring,
  reports, auth: each holds its route components, query hooks
  (`useExpenses`, `useBudgetStatus`, …), and feature-local components.
- Query hooks are the only place `fetch` happens (thin typed client over
  the shared schemas); components never build URLs.
- Every page designs its empty, loading (skeleton), and error states
  explicitly.
- Auth: `GET /api/auth/me` bootstraps an auth context at app start; any
  401 from the API triggers redirect-to-login preserving the return path.

## Testing — scope per layer

**Unit (Vitest, no I/O):**

- Month-end clamp + next-occurrence computation — including the required
  Jan 31 → Feb 28 → Mar 31 anchor-preservation case, weekly stepping,
  end_date termination.
- Effective-budget resolution (greatest month_start <= M; NULL = cleared).
- `formatLKR` (grouping, minor-unit rendering).
- CSV row encoding (quoting, commas, quotes-in-values, BOM).
- Cursor encode/decode round-trip.
- Password common-list check.

**Component (Vitest + Testing Library, jsdom — apps/web):**

- Optimistic-insert rollback on the expenses page: optimistic row visible
  before the mutation resolves; on server error the cache is restored to
  its pre-mutation snapshot and the error surfaces.
- Filter state → query-param serialization (`filtersToSearchParams`):
  round-trips through the shared `listExpensesQuery` schema; used by both
  the list hook and the CSV-export link.

**API integration (Vitest + real Postgres — testcontainers locally,
service container in CI; schema-per-suite isolation: each suite migrates
into its own Postgres schema via `search_path`, so suites run in parallel
against one database — full mechanics in design/plan.md Task 3):**

- Auth: signup (dup email 409), login (opaque 401), logout, session
  expiry + sliding refresh + 90-day absolute cap, token rotation.
- Ownership isolation: user A cannot read, update, or delete user B's
  expenses/categories/budgets/rules (explicit 404 assertions).
- Expenses: CRUD, filters, keyset pagination ordering/stability,
  first-page-only totals, validation failures.
- Budgets: effective-from resolution across months, clear-forward, 400 on
  archived category.
- Recurring generator: idempotency (double run inserts nothing), catch-up
  (missed days), clamp behavior end-to-end, no-backfill on past
  start_date, end_date stop, unique-index backstop.
- Demo: provision + capacity cap 503 + reap.
- Rate limiting: 429 envelope on auth routes.
- CSRF: mutating request with wrong/missing Origin → 403.

**E2E (Playwright, exactly 3 flows, run against built app + real DB):**

1. Signup → lands on dashboard.
2. Add expense via slide-over → appears in expenses table.
3. Expense visible on dashboard (summary + category breakdown reflect it).

## CI pipeline (GitHub Actions)

`ci.yml` on pull_request + push to main, stages in order:

1. **Install** — pnpm, frozen lockfile, store cache.
2. **Lint** — ESLint + Prettier check (all workspaces).
3. **Typecheck** — `tsc --noEmit` per workspace.
4. **Unit + integration tests** — Postgres 16 service container;
   migrations applied first (which itself tests the migration path).
5. **Build** — shared, api, web (production build).
6. **E2E** — Playwright against the built output + service-container DB.

Fail any stage → red.

**Deploy trigger, explicit:** deploy is a separate job in the same
workflow with `needs:` on all six stages and
`if: github.event_name == 'push' && github.ref == 'refs/heads/main'` —
it runs only from the push-to-main workflow run. A green PR run never
deploys.

## Deploy (main only)

- **Artifact:** single multi-stage Dockerfile — build workspaces → prune →
  runtime image runs Fastify serving `/api` + built SPA static with
  fallback.
- **Flow:** CI green on main → trigger Render deploy hook. App start
  sequence: run Drizzle migrations (fail-closed — app refuses to start on
  migration error) → listen. Render health check on `GET /health`.
- **Infra:** Render free web service (Docker) + Neon free Postgres.
  `DATABASE_URL`, `SESSION_SECRET` (cookie signing), `APP_ORIGIN`, optional
  `SENTRY_DSN` via Render env. Uptime pinger (cron-job.org or GitHub
  Actions) hits `/health` to soften free-tier cold starts; README notes
  the possible ~30s first load anyway.

## Scheduled job (GitHub Actions cron, nightly + workflow_dispatch)

One script (`apps/api/src/jobs/nightly.ts`) run with `DATABASE_URL`
secret, directly against Neon (web service may be asleep — irrelevant).
Steps **in order**:

1. **Reap demo users** — delete `is_demo = true` users with
   `created_at < now() - 24h` (cascades wipe data + sessions).
2. **Sweep expired sessions** — delete sessions with
   `expires_at < now()` (nothing else deletes them; without this the
   table grows forever).
3. **Recurring generation** — idempotent catch-up per rule (see
   schema.md).

Each step logs counts; the job is safe to run repeatedly.

**Failure semantics:** the three steps run independently — a failure in
one does not prevent the others from running — but any step failure makes
the script **exit non-zero** so the GitHub Actions run is marked failed
and surfaces in notifications. Logging alone is not a failure signal.

## Documentation

- **README.md** — hero screenshot, live demo link (+ demo button note),
  feature list, one-command local setup (`docker compose up` +
  `pnpm dev`), architecture sketch, tech decisions summary linking to
  ADRs.
- **ADRs** (`docs/adr/`), exactly four:
  1. `0001-sessions-over-jwt.md` — httpOnly cookie sessions, not JWT in
     localStorage.
  2. `0002-integer-minor-units-for-money.md` — bigint minor units, never
     float.
  3. `0003-aggregation-in-sql.md` — reports computed by Postgres, not JS.
  4. `0004-ephemeral-demo-users.md` — per-visitor demo sandboxes over a
     shared writable demo account.
- **docs/architecture.md** — system overview: monorepo layout, request
  lifecycle, auth flow diagram, cron design.
- **design/** — these three design docs (schema, api, delivery), committed.

## Local development

- `docker compose up` → Postgres 16 with a named volume.
- `pnpm dev` → API (tsx watch) + Vite dev server (proxy `/api` →
  localhost API) concurrently — same-origin behavior matches production.
- `pnpm seed` → local dev user with the demo dataset generator.
- `.env.example` lists every variable with comments; app fails fast on
  missing required env (validated at boot with zod).
