# 73 · Under load, failed checkouts leave buyers charged-but-not-sold

**Severity:** Critical (money state wrong under load; found by the load test) · **Area:** `apps/api/src/paymentLinks/pay.ts`

**What's wrong.** Paying a link runs: reserve the link → authorize the card
→ mark the link paid → capture. Each step undid the earlier ones when it
*returned* a failure (a decline, a lost reservation), but not when it
*threw*. Under load the database pool runs out and a step throws "timeout
exceeded when trying to connect". The load test (20–40 checkouts/s) left:

| State left behind | Count |
|---|---|
| Link **paid**, money only **authorized** (merchant thinks it sold; buyer's card held; nothing captured) | 73 |
| Authorization with **no link** (buyer's card held for nothing) | 41 |
| Link stuck **reserved** (buyer got a 500) | 276 |

**Why it's wrong.** A payment flow must never stop half-way with money
committed on one side and not the other. The code handled the polite
failure path and nothing else.

**Spread / what it breaks.** Every payment-link checkout once the API is
busy, which is exactly when the judges' load test runs. Merchants ship
goods that were never paid; buyers see holds on their cards.

**Fix.** Each step after the claim wraps its call: if it throws, the step
runs the same undo as its returned-failure branch, then rethrows the
original error.
- Authorize throws → release the reservation.
- Committing the link throws → void the authorization and release.
- Capture throws → un-commit the link and void.

If the undo fails as well, it is logged loudly for manual repair (bug 74
cleans up anything still left).

**Tests.** New file `apps/api/src/paymentLinks/payFailureCompensation.test.ts`
injects the real "timeout exceeded when trying to connect" failure at each
stage through a fault-injecting pool:
- After a failure the link is `active` with any authorization `voided`.
- The buyer can then pay normally.

Before the fix: the link was left `reserved`, and the retry got 409. After
it, all pass, with the existing payment-link tests. Load test: every
invariant holds at 10–60 checkouts/s.
