## Appendix. Extra evidence

### A.1 Money invariants on the live database (30 Oct, 23:05 Bahrain)

The checkout load test's invariants (`perf/checkout/invariants.sql`) were run over **every** link, not just load-test ones, plus three ledger-wide checks. The query ran inside a read-only session (`SET default_transaction_read_only = on`). Scope: 77,766 payment links, 14,834 transactions, 56,134 ledger entries and 2 refunds.

| Invariant | Result |
|---|---|
| Every ledger entry group balances (debits = credits) | **holds** |
| No transaction refunded beyond its captured amount | **holds** |
| No paid settlement batch with a negative payout | **holds** |
| No payment link left reserved | **holds** |
| No captured sale behind an unpaid link | **holds** |
| No authorization left open (card held, no sale) | **holds** |
| Every paid link has exactly its captured transaction | 2 rows flagged, both expected (below) |

The two flagged rows are our live refund rehearsal. One link's sale is `refunded` (25,000 fils) and the other `partially_refunded` (40,000 fils). Each was captured for exactly its link's amount. The check predates refunds and only accepts the status `captured`, so it should also accept the two refund statuses. With that change it holds for every link.

### A.2 Full test suite on fresh databases

`tools/suite.sh` (30 Oct, 23:10 Bahrain) migrates throwaway databases from scratch and runs every package. The Go tests ran with `DATABASE_URL` set, so the DB-backed tests actually ran rather than skipping themselves.

| Package | Tests | Failures |
|---|---|---|
| `packages/money` | 40 | 0 |
| `packages/events` | 4 | 0 |
| `apps/api` | 570 | 0 |
| `apps/web` | 15 | 0 |
| `apps/reporting` (own database) | 19 | 0 |
| `scripts` | 8 | 0 |
| `db` (includes the fresh-database migration test) | 8 | 0 |
| **TypeScript total** | **664** | **0** |
| Go settlement (`go test -p 1 ./...`) | 7 packages | all `ok` |
| Typechecks (api, admin, web, scripts, db) | 5 | 0 |
| `go vet` | | clean |

Known-failure baseline: **empty**. Every test that used to fail (the 11 refund tests blocked by FP-300, the flaky backoff test, the 4 reporting tests polluted by a shared database) now passes.
