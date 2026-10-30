## 1. Summary

**What we found.** 79 confirmed problems, each written up in `docs/bugs/points/`. 11 are Critical, 40 High, 19 Medium and 8 Low. The 79th is the unfinished refunds feature (FP-300).

The worst money bugs:
- Refunds could be paid out of another merchant's sale, above the captured amount, or twice when sent at the same time.
- Settlement still paid out refunded money.
- One payment link could charge several buyers.
- CSV adjustments were posted at a tenth of their value.
- A nightly job could delete every card hold.
- Payouts were computed in float32.
- Each `settlement.paid` was recorded once per webhook delivery.

The worst security bugs: merchant login never needed the OTP, a login could land on another merchant's account, and acquirer callbacks were accepted unsigned.

**What we fixed.** All 79, one commit per bug, each with a test. FP-300 refunds now work end to end: API and dashboard drawer, ledger, settlement netting, reconciliation, a `refund.succeeded` webhook, reports and the timeline. The app is hosted live. We measured about 20 checkouts per second sustained. Above that it turns requests away within milliseconds and shows no errors.

**What we left alone.** We did not correct historical data on any database. We did not renumber the migrations that break ADR-0005. A few judgement calls need the owner's sign-off. All of these are listed in *Decisions and open risks*.

**Main root cause.** The team followed unverified claims instead of the ADRs. Those claims came from planted AI rule files, "intentional" and "Claude says" comments, and docs and tests that locked bugs in place. On top of that, the database guaranteed almost nothing: it had no locks or unique constraints, and the code read a value and then wrote it back. So each mistake stayed in place and was easy to repeat.
