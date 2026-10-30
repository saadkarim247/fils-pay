# FilsPay — conventions for people and AI coding tools

Rewritten 2026-10-30 (see `docs/bugs/points/60-ai-rule-files-preserve-bugs.md`).
The previous version of this file, `AGENTS.md` and `.cursorrules` told tools
that money was cents, that settlement used UTC midnight, that tests must
never change and that `Math.random()` was fine for OTPs. Each of those hid a
real bug. Every rule below was checked against the code and the ADRs.

## What is authoritative

- **ADRs in `docs/adr/` are the rules** the code must follow. One
  exception: ADR-0004 says the console rebuild and the CLI rebuild agree,
  and they didn't. The proposed ADR-0007 replaces it: balances are rebuilt
  from the ledger.
- Everything else is a claim to verify in the code: `ARCHITECTURE.md`,
  `HANDOVER.md`, `CHANGELOG.md`, postmortems, perf notes, code comments and
  tests. Several were wrong; `docs/bugs/points/` records each case.
- Comments saying "intentional", "by design", "unreachable", "correct" or
  "Claude says" are claims, not reasons to stop.

## Money (ADR-0001)

- Integer **fils**. 1 BD = **1000** fils, never cents.
- Text in: `parseBhdToFils`. Display: `formatBhd`. Rates are basis points
  via `applyRateFils` (half-to-even). Splits: `allocateRemainder` (TS) /
  largest remainder (Go), so parts always sum to the total.
- No `parseFloat`, `toFixed`, `* 100` or `float32`/`float64` on any amount
  that is paid, charged, reported or reconciled (bugs 13, 15, 57).
- New money columns are `BIGINT` fils (bug 19).
- `packages/money` and `apps/settlement/internal/money` are audited: change
  them only with a failing test that shows the defect, and finance sign-off.
- Neither service is "the reference" for fees. When TS and Go disagree, find
  out which matches the ADRs and fix the other.

## Ledger and settlement

- The settlement business day runs midnight to midnight **Asia/Bahrain**
  (UTC+3, no DST). Daily windows (batches, the daemon, daily reports) use
  it (ADR-0003). In Go, convert an instant with `settlement.BusinessDateOf`
  before `BusinessDayWindow` (bugs 17, 40).
- Calendar-month finance reports may use UTC months (ADR-0003), but must be
  checked against the batch totals at the month boundary (bug 49).
- `ledger_entries` is double-entry: balanced legs per `entry_group_id`.
  Corrections are new postings, never edits. Manual credits post at `now()`;
  the effective date is metadata (bug 56).
- `merchant_balances` is a cache rebuilt from the ledger (ADR-0007).
- Scheme rounding residue is journaled per export line (ADR-0002, bug 50).
- Paid batches never change (bug 16).

## Migrations

- Add a new file numbered above the highest in `db/migrations/`. Never edit
  a migration that has run anywhere: `db/migrate.ts` tracks filenames only,
  so an edited file is silently skipped on existing databases.
- 0054–0056 are reserved for settlement v2 (ADR-0005).

## Security

- OTPs, payment-link tokens, invite codes, session tokens and API keys come
  from `node:crypto` (`apps/api/src/lib/random.ts`), never `Math.random()`
  (bug 44).
- Scope every merchant query by the merchant from authentication
  (`request.merchantAuth`), never from the body or path (bugs 10, 11, 26).
- Admin routes state their roles with `requireAdminRole(...)`; don't assume
  "the middleware already checks" (bugs 07, 46). "View as merchant" is
  read-only for every admin role (bug 04).
- Writes that read-then-act use one atomic conditional `UPDATE` or a
  `FOR UPDATE` lock held to the end (bugs 23, 28, 53).
- Outbound webhooks: sign the exact bytes sent, never follow redirects,
  refuse private addresses in production (bugs 36, 54). Inbound acquirer
  callbacks always require a valid signature (bug 12).
- Never commit real secrets or production values.

## Events and reporting

- Outbox consumers read in commit order (bug 51).
- Adding a type to `REPORTING_EVENT_TYPES` needs a matching case in
  `applyEvent` and somewhere to land in the rollups, or the worker stops
  (bug 58).

## Tests

- Every fix starts with a test that fails for the right reason.
- A test can pin a bug. When one does, correct it in the same change, with
  a comment naming the bug note. Never weaken a test to make code pass.
- Run tests against a **fresh, migrated database**, never the dev database
  (tests leave data that breaks the running app). Compose needs `ops/.env`
  first (`POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh` on a
  laptop; the URL below uses that password):

  ```bash
  docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -c "CREATE DATABASE filspay_test"
  docker compose -f ops/docker-compose.yml run --rm --no-deps -e NODE_ENV=test -e DATABASE_URL="postgres://filspay:filspay_dev_password@postgres:5432/filspay_test?sslmode=disable" migrate sh -c "npm run migrate && npm test"
  ```

  The root `npm test` stops at the first failing package. The reporting
  package reads the whole outbox, so the events the API tests leave behind
  break 4 of its tests when the two share a database. Give it its own fresh
  database (`npm test -w @filspay/reporting`), then run
  `npx tsx --test scripts/*.test.ts db/*.test.ts`.
- Go: `go test -p 1 ./...` with `DATABASE_URL` pointing at a fresh,
  migrated database (packages share `merchant_balances`). Without
  `DATABASE_URL` every DB-backed Go test skips itself and the run still
  prints `ok`.
