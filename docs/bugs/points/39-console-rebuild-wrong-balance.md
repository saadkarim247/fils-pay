# 39 · "Rebuild cached balances" in the console sets every balance wrong

**Severity:** High (FP-203; merchants shown wrong balances) · **Area:** `apps/settlement/internal/ledger/refresh.go`

**What's wrong.** Support uses the admin console button "Rebuild cached
balances" when a merchant's balance looks off. Pressing it overwrites
**every** merchant's balance with a wrong figure.

**Why it's wrong.**
- The button reads `merchant_payable_position`, the gross total of every
  line ever exported to the card scheme. That ignores fees, refunds,
  payouts and credits.
- The CLI rebuild (`settlement rebuild-balances`) walks the ledger and gets
  the right number.
- ADR-0004 required the two paths to "agree whenever the cache is
  consistent". Built on scheme lines, they can never agree.
- The brief's evidence: Alpha Retail's balance went from 135K to 7K after a
  console rebuild, while Yousif's CLI rebuild gives the right number.
- The September export (`merchant-balances-rebuild-2026-09-15.csv`) and the
  FP-203 audit row (`"source":"scheme_export_lines"`) show it in
  production.

**Spread / what it breaks.** Every merchant's displayed and cached balance,
every time support presses the button. The number support then quotes to
merchants is wrong.

**Fix.**
- **Same quantity as the CLI.** The console rebuild now computes the
  merchant's `merchant_payable` net from the ledger.
- **Still fast.** It does this in one grouped query and one bulk upsert,
  which keeps ADR-0004's speed requirement.
- **The ADR is superseded on record.** New `docs/adr/0007` (Proposed) says
  so, rather than leaving ADR-0004's text contradicting the code.

**Tests.** New file `internal/ledger/console_rebuild_test.go`. A merchant
has 12,000 captured and exported, then 300 fee, 2,000 refunded and 9,000
paid out. The CLI says 700, and the console must also say and store 700.
Before the fix the console wrote 12,000.

**Existing test corrected.** The `refresh_test` fixture created a scheme
line with no ledger entries. It now also posts the balanced capture legs
that an exported line implies, so the two existing tests keep their
expected figures (25,000; 21,000) and their intent. The `internalapi`
rebuild test needed no change. All Go tests pass.
