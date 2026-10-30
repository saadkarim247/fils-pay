# FilsPay: a short guide to the codebase

A readable map of how FilsPay fits together and what each part does. The full per-file reference is in
`filspay-contracts.md` / `.tex`. This guide covers only what you need to find your way around.

> **Money is always an integer number of fils.** 1 BD = 1000 fils. Anything named `…Fils` or `…_fils` is fils.

---

## The big picture

```
  Merchant dashboard (web)        Admin console (admin)        Buyer (checkout page, in web)
            │                              │                              │
            └──────────────┬───────────────┴──────────────────────────────┘
                           ▼
                    API  (apps/api, TypeScript)
          payments · links · refunds · auth · admin · webhooks
                           │
                           ▼
        ┌──────────────── Postgres (one shared database) ────────────────┐
        │  transactions · ledger_entries · settlement_batches · outbox   │
        └────────────────────────────────────────────────────────────────┘
              ▲                          ▲                        ▲
   Settlement (Go)               Reporting worker          Webhook dispatcher
   daily close & payouts         outbox → analytics        (inside the API)
                                                           outbox → merchant webhooks
```

**How a payment flows:**
1. **Authorize** → **capture** in the API, against a simulated acquirer.
2. The capture writes ledger entries and an outbox event.
3. Each night the **settlement** service closes the Bahrain business day into a batch per merchant. It computes the fees, writes the scheme (card network) file and pays the merchant.
4. The outbox feeds two consumers: **webhooks** to the merchant and **analytics** rollups.

**Shared ideas:**
- **Ledger.** Every money movement is a set of balanced debit/credit lines (`ledger_entries`).
- **Outbox.** Services announce changes by inserting into `outbox_events` inside the same transaction. A database trigger then wakes up the consumers.
- **Idempotency keys.** Merchants send an `Idempotency-Key` header so retried requests are not run twice.

---

## 1. API service: `apps/api`

The main backend. It is a Fastify server that serves the merchant dashboard, the public checkout, the admin console and the bank's callbacks. It also runs the webhook dispatcher in the background.

**Who can call it:**
- **Merchants:** a session cookie after password + OTP, or an API key (`Authorization: Bearer`).
- **Admins:** a separate admin cookie, with roles `support` < `finance` < `super_admin`.
- **Public:** checkout links, signup, login and the acquirer callback.

| Where | What it does |
|---|---|
| `src/index.ts`, `app.ts`, `config.ts` | Start-up: reads env, creates the DB pool, registers all routes under `/v1/...`, starts the webhook dispatcher. |
| `src/routes/` | One file per URL area (transactions, payment links, refunds, webhooks, admin…). Checks auth, validates input, calls the domain code, maps results to HTTP status codes. |
| `src/payments/` | The payment lifecycle: `authorize`, `capture`, `void`, `processRefund`, plus idempotency-key handling and the merchant-discount adjustment. |
| `src/paymentLinks/` | Payment links: create, cancel, list, and the public "pay by link" flow (reserve → authorize → capture → mark paid). |
| `src/refunds/` | Merchant-facing refund entry point (wraps `processRefund`). **The refund route currently returns 501. Refunds are the unfinished FP-300 feature.** |
| `src/transactions/` | Transaction lists, details, the event timeline, receipts, CSV export. |
| `src/fees/` | Which fee rate applies (effective-dated `fee_schedules`), the platform volume discount, the fee shown in the console. |
| `src/acquirer/` | A fake card acquirer (bank) for development: authorize/capture/refund with simulated delays and outcomes. |
| `src/auth/`, `src/adminAuth/` | Merchant and admin login: passwords, OTP codes, sessions, the auth checks used by routes. |
| `src/apiKeys/` | Issue, list, revoke and verify merchant API keys. |
| `src/onboarding/` | Merchant signup, business profile, KYC document upload and review. |
| `src/admin/` | Business logic behind the admin console: credits, balance adjustments, CSV imports, impersonation, KYC approval, and calls to the settlement service. |
| `src/webhooks/` | Merchant webhook endpoints; the dispatcher that turns outbox events into signed HTTP deliveries; replays; verifying the bank's callbacks. |
| `src/settlement/`, `src/analytics/`, `src/reporting/` | Read-only queries for settlement pages, dashboard charts and transaction reports. |
| `src/lib/`, `src/db/`, `src/plugins/` | Small helpers: errors, crypto, DB transactions, cookies, uploads. |

**Watch out:**
- **Merchant sessions:** the lookup doesn't check that the OTP was completed.
- **Refunds:** the refund code isn't safe to wire up as it is (see the audit notes).
- **Legacy code:** `src/v1/` is never registered and isn't live.

---

## 2. Settlement service: `apps/settlement` (Go)

One Go program that runs as a **daemon** or as a one-off **CLI**. Every day it closes the previous Bahrain business day and pays merchants.

**The daily cycle:**
1. **Close.** Collect the day's captures, compute fees per payment, freeze the totals in `settlement_batches` and write the scheme export lines.
2. **Pay.** Post the payout ledger entries and mark the batch paid. Marketplace merchants are split across sub-merchants.
3. **Notify.** Queue a `settlement.paid` event, which becomes the merchant's "payout sent" webhook.

| Where | What it does |
|---|---|
| `cmd/settlement/main.go` | Entry point. Subcommands: `daemon`, `run-batch`, `rebuild-balances`, `export-scheme-file`. |
| `internal/scheduler/` | The daemon loop that triggers the daily batch and payout notifications. |
| `internal/settlement/` | The core: business-day window, fee calculation, batch close and payout, scheme export, platform volume tier, MDR recalculation. |
| `internal/splits/` | Splitting a marketplace payout between sub-merchants. |
| `internal/ledger/`, `internal/balances/` | Keeping the `merchant_balances` cache up to date and rebuilding it. |
| `internal/internalapi/` | A small private HTTP API the admin console uses (run batch, rebuild balances, recalculate MDR). |
| `internal/money/`, `config/`, `db/` | Fils arithmetic, environment config, database connection. |

**Watch out:**
- Payout amounts are computed with `float32`.
- The daily close actually fires around 03:00 Bahrain time, not midnight.
- The console's "rebuild balances" uses a different, wrong source from the CLI's.

---

## 3. Reporting worker: `apps/reporting`

A background worker with no web server. It listens for outbox events and keeps two summary tables up to date for the dashboard charts: daily volume per merchant (`merchant_daily_volume`) and payout trends (`merchant_payout_trends`).

| Where | What it does |
|---|---|
| `src/index.ts` | Starts the worker, or runs `catch-up` / `rebuild`. |
| `src/consumer/` | Wakes up on database notifications, reads new events after its saved position (cursor), updates the summary tables. |
| `src/cli/` | The worker loop, a one-shot catch-up, and a full rebuild from scratch. |

**Watch out:** it tracks progress by event id, so an event that commits late can be skipped permanently.

---

## 4. Merchant dashboard and checkout: `apps/web` (React)

The merchant's website plus the public payment page buyers see.

| Area | What the merchant (or buyer) can do |
|---|---|
| `/pay/:token`: **Checkout** | The buyer sees the amount and pays by card. Public, no login. |
| `/dashboard/login` | Password, then OTP code. |
| Overview | Charts: volumes, payout trends, top payment links. |
| Transactions | List, details, capture or void a payment. A refund drawer exists but is switched off. |
| Payment links | Create, list, view, cancel links. |
| Settlement | Batches, batch details, reconciliation report. |
| Webhooks | Add endpoints (signing secret shown once), view deliveries, replay. |

Everything goes through `src/api/` (one small client per area) to the API. Display helpers live in `src/format.ts`.

**Watch out:** the amount formatter crashes on negative numbers, such as refunds.

---

## 5. Admin console: `apps/admin` (React)

The internal tool for FilsPay staff. You log in with password + OTP, and screens are shown or hidden by role.

| Page | Used for |
|---|---|
| Merchants (list + detail) | Search merchants, KYC review and bulk approve, API keys, balance adjustments, credits, impersonate ("view as merchant"). |
| Credits | Approve or reject manual credits; two people are required above a threshold. |
| Settlement | Re-run a batch, rebuild balances, recalculate MDR. |
| Adjustment imports | Upload finance's CSV of balance corrections. |
| Webhooks | Replay batches of webhook deliveries. |

**Watch out:** the console only hides buttons by role. The real permission checks must happen in the API, and some are missing there.

---

## 6. Money package: `packages/money`

The shared rules for handling money in TypeScript. Everything else should use these instead of doing its own arithmetic.

| Function | What it's for |
|---|---|
| `toFils`, `Fils` | Turn a number into a checked fils amount (whole numbers only, no floats). |
| `parseBhdToFils` | Read text like `"4.750"` as 4750 fils. Rejects more than 3 decimals. |
| `formatBhd` | Show fils as `4.750`. |
| `applyRateFils` | Apply a percentage in basis points (e.g. 225 = 2.25%), rounded once, ties to even. |
| `calculateRefundFee` | The share of the original fee to give back on a refund. |
| `allocateRemainder` | Split an amount by weights so the parts always add up exactly. |

---

## 7. Events package: `packages/events`

The list of event types and one helper.

- **Events:** `transaction.captured`, `transaction.voided`, `refund.succeeded`, `settlement.batch_closed`, `settlement.paid`.
- **`enqueueEvent`** adds an event to the outbox. Call it inside the same database transaction as the change it describes.

The Go settlement service writes its events with its own SQL.

---

## 8. Database: `db/`

| Where | What it is |
|---|---|
| `db/migrations/` | 66 SQL files (numbered 0001–0072, some numbers unused) that build the schema in order. |
| `db/migrate.ts` | Applies the migrations not yet run, by file name. |
| `db/seed/` | Fills a database with realistic test data: admins, 8 merchants, transactions, batches. It wipes those tables first. |

**Main groups of tables:**
- **Merchants and users:** merchants, their users, profiles, KYC.
- **Payments:** transactions, their event timeline, holds, idempotency keys.
- **Ledger:** chart of accounts and `ledger_entries` (must balance).
- **Settlement:** batches, scheme export lines, balances cache, splits, payouts.
- **Events:** the outbox, webhook endpoints and deliveries, reporting tables.
- **Security:** passwords, OTP codes, sessions, API keys, plus the admin equivalents and the audit log.
- **Refunds and fees:** refunds, fee schedules, discounts.

**Watch out:** on a brand-new database the migrations stop at 0054, which refers to a table that doesn't exist. This must be fixed before deploying anywhere fresh.

---

## 9. Scripts: `scripts/`

| Script | What it does |
|---|---|
| `expire_holds.ts` | Nightly clean-up of expired card holds. **On a night with nothing to expire it deletes every hold.** |
| `reconcile_march.ts` | One-off finance correction for March 2026 rounding leftovers. Not safe to run twice. |
| `lib/sqlFilter.ts` | Small helper that builds WHERE clauses for the hold script. |

---

## 10. Ops: `ops/`

`docker-compose.yml` runs everything locally:

| Service | Purpose |
|---|---|
| `postgres` | The database (port 5432). |
| `migrate`, `seed` | One-off jobs that set up the schema and test data. |
| `api` | The API on port 3000. |
| `settlement` | The Go daemon; internal API on 8091, not published. |
| `reporting` | The analytics worker. |

**Watch out:**
- `.env.docker` isn't actually loaded by compose.
- The Dockerfiles the services build from aren't in the repo.
- The settlement daemon needs `SETTLEMENT_INTERNAL_TOKEN`, which is never set.
- The seed job re-runs, and wipes data, on every `docker compose up`.

---

## Repository root

- `package.json`: npm workspaces linking the TypeScript apps and packages, plus shared scripts (test, migrate, seed).
- `tsconfig.base.json`: shared TypeScript settings.
- `CLAUDE.md`, `AGENTS.md`, `.cursorrules`: instructions for AI coding tools. **Not trustworthy.** They contradict the brief and the ADRs on money units, time zones and column types.
- `CHANGELOG.md`: release history; several "fixed" claims are not true in the code.
