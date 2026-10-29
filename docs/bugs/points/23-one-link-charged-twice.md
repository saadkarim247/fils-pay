# 23 · One payment link can charge two buyers

**Severity:** Critical (customers double-charged; incident 2026-05-14) · **Area:** `apps/api/src/paymentLinks/pay.ts`

**What's wrong.** A payment link is single-use, but two buyers paying at
around the same time can both be charged. Each is told "paid".

**Why it's wrong.** Paying a link runs four steps: reserve the link,
authorize, capture, finalize.
- **The reservation has no owner.** If one buyer's request runs past the
  reservation timeout (a slow acquirer), a second buyer "re-claims" the
  link as stale. Both go on to authorize **and capture**.
- **The loser's error is swallowed.** Its finalize matches 0 rows, but the
  code still answers 200 "paid", treating it as an "unreachable" invariant
  violation. FH flagged that it is reachable; MK called it unreachable.
- **One buyer can reopen another's reservation.** A failing buyer's
  release can put another buyer's live reservation back to `active`.
- CHANGELOG 1.6.0 claims the incident was fixed by de-duplicating
  callbacks. Callbacks only write notes; they were never the cause.

**Spread / what it breaks.** Any link under load or with slow acquirer
responses: two cards captured for one order, refunds and chargebacks, and
the link's record points at only one of the payments.

**Fix.**
- **New migration** `0075_payment_links_reservation_owner.sql` adds
  `reservation_id`. Each claim gets a fresh id.
- **Commit before capture.** After authorize succeeds, one atomic UPDATE
  marks the link paid, but only if this request still holds the
  reservation. Only then is the card captured.
- **A buyer who lost the link voids its authorization** (no money moves,
  the hold is released) and gets 409. Release and undo touch only the
  caller's own reservation.
- **If capture fails, the commit is undone** and the authorization is
  voided.

**Tests.** New file `apps/api/src/paymentLinks/linkOneBuyer.test.ts`. It
forces the overlap: reservation timeout 0 s, 150–250 ms acquirer latency,
two buyers at once.
- Exactly one card is captured; responses are 200 and 409, and the link
  points at the captured payment.
- The loser's authorization is voided, with no active hold left.
- A buyer after payment gets 409 and is not charged.
- A declined card leaves the link payable.

Before the fix: two captures and two 200s, the incident reproduced. After
it, all pass (3 of 3 runs), along with all 28 payment-link tests. Full
suite (fresh database): no new failures.
