# 0007. Console balance rebuild reads the ledger (supersedes 0004)

- **Status:** Proposed
- **Date:** 2026-10-30
- **Supersedes:** 0004
- **Related:** FP-203, docs/bugs/points/39-console-rebuild-wrong-balance.md

## Context

ADR-0004 asked for two things: a console button fast enough for an HTTP
request, and a figure that agrees with the CLI's ledger rebuild "whenever
the cache is consistent". It met the speed goal by reading
`merchant_payable_position`: the gross of every scheme line ever exported.
That figure has no fees, refunds, payouts or credits, so it can never agree
with the ledger. FP-203 (Alpha Retail's balance went from 135K to 7K after a
rebuild) is the result.

## Decision

The console rebuild computes the same quantity as the CLI, the
`merchant_payable` net in `ledger_entries`. It keeps 0004's speed
requirement by doing it in one grouped read and one bulk upsert, not a query
per merchant.

## Consequences

- The two rebuild paths agree by construction.
- Manual "Adjust balance" corrections stay cache-only (ADR-0006) and are
  still overwritten by a rebuild, as before.
- `merchant_payable_position` is no longer used by the rebuild.
