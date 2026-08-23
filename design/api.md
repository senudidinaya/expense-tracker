# API, Auth & Security — v1 (Final)

Companion to `design/schema.md`.

## Conventions

- All routes under `/api`. JSON in/out unless noted (CSV export).
- Every request/response body is validated by zod schemas exported from
  `packages/shared` (wired with `fastify-type-provider-zod`). The frontend
  imports the same schemas — one contract, no drift.
- Amounts cross the wire as **integer minor units** (`amountMinor: number`),
  never decimals. Formatting to "Rs 1,250.00" is a frontend concern.
- Dates cross the wire as ISO `YYYY-MM-DD` strings; months as `YYYY-MM`.
- IDs are UUID strings.
- **Auth requirement:** every route requires a valid session except
  `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/demo`,
  and `GET /health`. Unauthenticated requests to protected routes → `401`.
- All list/aggregate queries are scoped to the session's `user_id` in the
  repository layer. Requesting another user's resource id → `404` (not
  `403` — existence is not leaked).

## Aggregated money and the exact-integer ceiling

`amountMinor` is capped per row at 2^53 − 1, the largest integer a JSON number
carries exactly. Nothing caps a *sum* of legal rows: two at the cap already
exceed it.

Every endpoint that aggregates money follows the same rule:

- The sum is kept as text from Postgres and range-checked before conversion.
  Reading it as a number first destroys the evidence of the overflow.
- Past the ceiling, the money field is **omitted from the response**, never
  rounded. Rounding is exactly the lossy money the integer-minor-units rule
  exists to prevent.
- Counts are unaffected — `count(*)` is bounded by the row count — and still
  come back, so a response with an omitted total is distinguishable from one
  that was never computed.

Applies to `GET /api/expenses` first-page totals and to every reports endpoint.

This is unreachable with real spending — 2^53 minor units is roughly 90 trillion
rupees — but it is the boundary the per-row cap implies, and five endpoints
deciding it separately would decide it differently.

## Error envelope

Every non-2xx response:

```json
{ "error": { "code": "validation_failed", "message": "human-readable", "details": { } } }
```

Stable codes: `validation_failed` (400), `unauthorized` (401),
`forbidden` (403 — used only for the CSRF origin mismatch; cross-user
access is always `not_found`), `not_found` (404), `conflict` (409),
`rate_limited` (429), `internal` (500), `demo_unavailable` (503).
`details` appears only for `validation_failed`
(zod issue list) and is never a stack trace.

## Sessions

- Token: 256-bit random (crypto), sent as cookie
  `session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/`.
  (`Secure` omitted only in local dev over http.)
- DB stores SHA-256 hex of the token (`sessions.token_hash`), never the raw
  token.
- Expiry: 30 days, sliding — refreshed (new `expires_at`) when the session
  is used more than 24h after last refresh — **capped at an absolute
  lifetime of 90 days from `created_at`**: sliding refresh never extends
  `expires_at` beyond `created_at + 90 days`, so a stolen token cannot be
  refreshed indefinitely.
- Login and demo-login **rotate** the token (new session row, old cookie
  invalid) — session-fixation defense.
- Logout deletes the session row and clears the cookie.
- Passwords: argon2id. Login runs argon2 verification even when the email
  does not exist (timing uniformity), and returns the same error either way.

## CSRF

Same-origin deployment (SPA served by the API) makes this tractable:

1. `SameSite=Lax` cookie — browsers won't attach it to cross-site POSTs.
2. Origin check — all mutating methods (POST/PATCH/PUT/DELETE) verify the
   `Origin` header matches the configured app origin; mismatch or absence
   (non-browser clients aside) → `403` with error code `forbidden`.

No CSRF token dance needed; both layers documented in the security ADR.

## Rate limits (@fastify/rate-limit)

| Scope                        | Limit        | Keyed by |
|------------------------------|--------------|----------|
| `POST /api/auth/login`       | 10 / min     | IP       |
| `POST /api/auth/signup`      | 10 / min     | IP       |
| `POST /api/auth/demo`        | 5 / min      | IP       |
| Everything else (global)     | 300 / min    | IP       |

429 responses use the error envelope with `retry-after` header.

## Headers / CSP (@fastify/helmet)

Strict CSP, self-only: `default-src 'self'`; no CDN assets (fonts
self-hosted, charts rendered without external scripts). Plus the standard
helmet set (nosniff, frame-deny, referrer-policy, HSTS in production).
Request body size capped at 32 KB.

## Observability

- pino structured logs; `x-request-id` honored if present, else generated;
  request id included in every log line and echoed in responses.
- 5xx handler logs the stack, returns only the envelope.
- `GET /health` — no auth: DB ping + app version `{ status, version }`;
  used by Render health checks and the uptime pinger.
- Optional Sentry wiring behind `SENTRY_DSN` env var.

---

## Routes

### Auth

| Method | Path              | Auth | Success | Errors |
|--------|-------------------|------|---------|--------|
| POST   | /api/auth/signup  | none | 201 `{ user }` + session cookie | 400, 409 (email taken), 429 |
| POST   | /api/auth/login   | none | 200 `{ user }` + session cookie | 400, 401 (single opaque message), 429 |
| POST   | /api/auth/demo    | none | 201 `{ user }` + session cookie | 429, 503 (`demo_unavailable` — capacity reached) |
| POST   | /api/auth/logout  | yes  | 204, cookie cleared | 401 |
| GET    | /api/auth/me      | yes  | 200 `{ user }` | 401 |

- Signup body: `{ email, password }`. Password: min 8 chars, max 128,
  rejected if in a bundled common-password list (top ~10k). No composition
  rules. Creates user + default categories (seed set: Food, Transport,
  Rent, Utilities, Health, Entertainment, Shopping, Other) in one
  transaction.
- `user` shape: `{ id, email, isDemo, createdAt }`. `password_hash` never
  serialized.
- Demo login (`POST /api/auth/demo`): **provisions a fresh ephemeral demo
  user per visitor** — see "Demo accounts" at the bottom. No credentials in
  the client.

### Expenses

| Method | Path                     | Auth | Success | Errors |
|--------|--------------------------|------|---------|--------|
| GET    | /api/expenses            | yes  | 200 list | 400, 401 |
| POST   | /api/expenses            | yes  | 201 `{ expense }` | 400, 401 |
| PATCH  | /api/expenses/:id        | yes  | 200 `{ expense }` | 400, 401, 404 |
| DELETE | /api/expenses/:id        | yes  | 204 | 401, 404 |
| GET    | /api/expenses/export.csv | yes  | 200 text/csv (streamed) | 400, 401 |

- List query params: `from`, `to` (ISO dates), `categoryIds` (comma-sep
  UUIDs), `q` (ILIKE substring on description, **max 100 chars**; the
  `%term%` scan is knowingly non-indexed — acceptable at v1 per-user data
  volumes, trigram index is the documented upgrade path), `cursor` (opaque,
  encodes `(date, id)` keyset), `limit` (default 50, max 100).
- List response: `{ items: Expense[], nextCursor: string | null, totalCount?: number, totalAmountMinor?: number }`
  — totals computed with the same filters (SQL, not JS), and **returned
  only on the first page** (no `cursor` param); cursor pages omit them.
- Expense shape:
  `{ id, categoryId, recurringRuleId, amountMinor, currency, date, description, notes, createdAt, updatedAt }`.
- POST/PATCH body: `{ amountMinor, categoryId, date, description, notes? }`
  (PATCH: all optional). `amountMinor` integer > 0. `categoryId` must be an
  active category owned by the user. Date must be a valid calendar date;
  future dates allowed (max 1 year ahead — enforced in the shared zod
  schema, so client forms and the API apply the same rule).
- CSV export: RFC 4180, UTF-8 with BOM (Excel), header row
  `date,category,description,notes,amount,currency`; amount as decimal
  string (`1250.00`); same filters as list; streamed, no pagination.

### Categories

| Method | Path                 | Auth | Success | Errors |
|--------|----------------------|------|---------|--------|
| GET    | /api/categories      | yes  | 200 `{ items }` (active + archived, flagged) | 401 |
| POST   | /api/categories      | yes  | 201 `{ category }` | 400, 401, 409 (duplicate active name) |
| PATCH  | /api/categories/:id  | yes  | 200 `{ category }` | 400, 401, 404, 409 |

- Category shape: `{ id, name, archivedAt, createdAt }`.
- PATCH body: `{ name? , archived? }` — rename, archive (`true`), or
  unarchive (`false`). Archiving is always allowed; archived categories
  remain selectable in filters/reports but not in new-expense forms.
  Unarchive fails 409 if an active category now holds the same name.

### Budgets

| Method | Path                        | Auth | Success | Errors |
|--------|-----------------------------|------|---------|--------|
| GET    | /api/budgets?month=YYYY-MM  | yes  | 200 `{ items }` | 400, 401 |
| PUT    | /api/budgets                | yes  | 200 `{ budget }` | 400, 401, 404 |

- GET resolves the **effective** budget per active category for the given
  month (greatest `month_start <= month`; NULL amount ⇒ unbudgeted):
  `{ items: [{ categoryId, amountMinor | null, effectiveFrom }] }`.
- PUT body: `{ categoryId, month: "YYYY-MM", amountMinor: number | null }` —
  upserts the row at that month (null clears from that month forward).
  404 if category not owned; 400 if category archived.

### Recurring rules

| Method | Path                      | Auth | Success | Errors |
|--------|---------------------------|------|---------|--------|
| GET    | /api/recurring-rules      | yes  | 200 `{ items }` | 401 |
| POST   | /api/recurring-rules      | yes  | 201 `{ rule }` | 400, 401 |
| PATCH  | /api/recurring-rules/:id  | yes  | 200 `{ rule }` | 400, 401, 404 |
| DELETE | /api/recurring-rules/:id  | yes  | 204 | 401, 404 |

- Rule shape: `{ id, categoryId, amountMinor, currency, description, notes, frequency, startDate, endDate, nextOccurrence, createdAt, updatedAt }`.
- POST body: `{ categoryId, amountMinor, description, notes?, frequency: 'weekly'|'monthly', startDate, endDate? }`.
- **No backfill:** on create, `next_occurrence` initializes to the first
  occurrence `>=` the creation date — a rule with `startDate` in the past
  never mass-inserts history. UI copy states "future occurrences only".
- PATCH recomputes `next_occurrence` from the edited rule, still never in
  the past. Edits affect future occurrences only; already-generated
  expenses are untouched.
- Generation itself is not an API route — it is the cron script
  (see schema.md) writing directly via the repository layer.

### Reports

All aggregation in SQL (`SUM`/`GROUP BY` over `amount_minor`), never in JS.
These endpoints are the seam the future AI-insights feature will consume.

| Method | Path                                   | Auth | Success |
|--------|----------------------------------------|------|---------|
| GET    | /api/reports/summary?from&to           | yes  | 200 `{ totalMinor, count, avgMinor, prevPeriodTotalMinor, deltaPct }` |
| GET    | /api/reports/by-category?from&to       | yes  | 200 `{ items: [{ categoryId, totalMinor, share }] }` |
| GET    | /api/reports/trend?from&to             | yes  | 200 `{ items: [{ month: "YYYY-MM", totalMinor }] }` (zero-filled months) |
| GET    | /api/reports/budget-status?month=      | yes  | 200 `{ items: [{ categoryId, budgetMinor \| null, spentMinor, remainingMinor \| null, pct \| null }] }` |
| GET    | /api/reports/top-expenses?from&to&limit | yes | 200 `{ items: Expense[] }` (limit default 5, max 20) |

All: 400 on invalid ranges (`from > to`, span > 5 years), 401 unauthenticated.
`prevPeriodTotalMinor` compares against the immediately preceding period of
equal length.

### System

| Method | Path    | Auth | Success |
|--------|---------|------|---------|
| GET    | /health | none | 200 `{ status: "ok", version }` (503 if DB unreachable) |

## Demo accounts (per-visitor, ephemeral)

A single shared writable demo account is a public unauthenticated write
surface (one visitor's vandalism is the next visitor's first impression).
Instead:

- `POST /api/auth/demo` provisions a **fresh user** (`is_demo = true`,
  synthetic email `demo-<uuid>@demo.invalid`, unusable random password
  hash) and runs the seed generator into it: ~6 months of realistic LKR
  expenses across the default categories, budgets, and 2–3 recurring
  rules, all dated relative to today. One transaction; then a normal
  session cookie is issued.
- Fully writable — every visitor gets their own sandbox; no shared state.
- **Capacity cap:** max 100 live demo users (`is_demo = true` rows). At
  the cap, demo login returns 503 `demo_unavailable`. Combined with the
  5/min/IP rate limit this bounds worst-case demo data volume.
- **Reaping:** the nightly GitHub Actions cron deletes demo users with
  `created_at < now() - 24h`; FK cascades wipe their data and sessions.
  (Cron order: reap demo users → sweep expired sessions → recurring
  generation. The session sweep is the only mechanism that deletes
  expired session rows; see delivery.md.)
- Demo users cannot change email/password (no such routes in v1) and the
  seed generator is the single source of demo data — no template account
  to maintain.
