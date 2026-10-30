# 49 · The March residue sweep charges merchants and posts again on every run

**Severity:** High (wrong ledger postings; doubles on re-run) · **Area:** `scripts/reconcile_march.ts`

**What's wrong.** Finance's one-off script writes off March's scheme
rounding residue: the 0–9 fils per line that never reach the card scheme.
It has two problems.
1. **It charges the merchant.** It debits each merchant's payable balance,
   so merchants are charged for the scheme's own rounding.
2. **It isn't safe to re-run.** Every run posts the whole sweep again.

**Why it's wrong.**
- ADR-0002 defines the posting: **credit `card_scheme_clearing`, debit
  `scheme_rounding_residue`**. The merchant is not involved. The script
  debited `merchant_payable` and credited the residue account, the wrong
  account and the wrong direction.
- Each run made a random entry group id and never checked for an earlier
  run, despite AM's note in the code ("re-running is safe, entry_group_id
  dedupes it"). Finance has re-run it as a "dry run" (meeting notes,
  3 July), and the script has no dry-run mode.

**Spread / what it breaks.** Every merchant with March residue had their
balance reduced, and every repeat run reduced it again.
`scheme_rounding_residue` moved the opposite way to what finance clears
against the scheme statement.

**Fix.**
- **Legs per ADR-0002.** The sweep posts credit `card_scheme_clearing` and
  debit `scheme_rounding_residue`, and no merchant leg.
- **Deterministic id.** Each merchant's March sweep gets an entry group id
  derived from the merchant and month. A merchant already swept is skipped
  and logged as such.
- **Advisory lock.** Two runs at the same time serialise on it, so they
  can't both post.

**Tests.** New file `scripts/reconcile_march.behaviour.test.ts`. It runs
the real script against its own fresh database. The March captures have
7 + 3 fils of residue; there is also one with none and one in April.
- The first run posts 10 to clearing and 10 to residue, with no merchant
  legs.
- A second run posts nothing more.

Before the fix no ADR-0002 legs were posted (the merchant was debited
instead). After it, both pass, along with the existing script tests. Full
suite (fresh database): no new failures.

**Clean-up needed in production.** Reverse every earlier sweep posting
(described "March 2026 scheme rounding residue sweep") before re-running
the corrected script once.

**Still open.** The script picks transactions by their creation time, in a
UTC month (ADR-0003 allows a UTC month for one-off scripts). Finance's
unexplained 4.75 BD March gap probably comes from the Bahrain-midnight
boundary; that's a judgement call for finance, so this fix doesn't change
it.
