### Root causes

The 79 findings come from eight shared causes. Each finding is listed once, under its main cause. Group 1 also kept many of the others alive.

**1. Unverified instructions kept bugs in place**
- *Decision behind it:* The team trusted whatever was loudest in the repo over the ADRs and the brief. Four kinds of source did this:
  - AI rule files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`). They said money is in cents, settlement windows are UTC, float32 is "intentional", Math.random is fine for OTPs, and "never edit a test".
  - Comments that closed bugs by saying "Claude says" or "intentional".
  - Tests that asserted the buggy behaviour.
  - Docs that contradicted the code: ADR-0002 claims residue posting is "implemented", and RUNBOOK says re-running the March script is "safe".
- *Bugs:* 60. The same sources kept these in place: 04, 05, 06, 13, 14, 15, 16, 18, 19, 21, 24, 27, 29, 32, 34, 39, 40, 44, 49, 50, 55, 63.
- *Guard:*
  - We rewrote `CLAUDE.md` with a precedence order: brief, then ADRs, then code, then other docs.
  - Every test we changed cites the ADR or brief rule that justifies it.
  - Proposed: CODEOWNERS review on AI rule files. A CI check that rejects "intentional" or "Claude says" comments unless they cite an ADR.

**2. Money computed outside one integer-fils implementation**
- *Decision behind it:* Each service did its own maths instead of calling the shared money package (ADR-0001). That produced:
  - a cents parser (2 decimals instead of 3)
  - float32 payouts and float estimates
  - int4/int32 counters that overflow
  - each part of a split rounded on its own, so the parts didn't add up to the whole
  - the fee rule written twice, so display, capture, link checkout, reconciliation and Go each used a different rate or order
- *Bugs:* 13, 15, 18, 19, 21, 29, 41, 48, 50, 57, 69.
- *Guard:*
  - Only `parseBhdToFils` / `applyRateFils` / remainder allocation are used for money. Money columns are BIGINT fils.
  - A shared TS and Go table of expected amounts is now checked in both languages' tests (bug 69).
  - Every split is tested so its parts add up exactly to the whole.
  - Proposed: a lint rule that bans `float32`/`float64`/`parseFloat`/`Math.round` in money paths.

**3. Trusting the caller's identity or data**
- *Decision behind it:* The code checked "is this caller allowed?" against the URL path or the request body, not against the row being changed. It trusted what the client sent:
  - the buyer's clock
  - unsigned callbacks
  - display names
  - file names
  - webhook URLs
  - idempotency keys not tied to the transaction
- It also used weak or missing security primitives:
  - Math.random tokens
  - a session view that dropped `authenticated = true`
  - role checks missing on admin routes
- *Bugs:* 02, 03, 04, 05, 06, 07, 08, 10, 11, 12, 22, 26, 36, 38, 44, 45, 46, 47, 54, 59, 61.
- *Guard:*
  - Every query takes `merchant_id` from the session, and a row owned by someone else returns 404.
  - Roles are default-deny on every admin route, and comparisons use IDs, never names.
  - Signatures are mandatory and checked on the exact bytes sent.
  - Times come from the server clock.
  - Tokens come from `crypto`.
  - Each endpoint has a test that tries another merchant's data.

**4. Read-then-write with nothing in the database to stop races**
- *Decision behind it:* The code checked a value, then wrote it back in a separate step. Nothing in the database prevented duplicates: no row locks, no UNIQUE or CHECK constraints, no idempotency keys based on content. "These never overlap" was assumed and never enforced. Multi-step money flows were not all-or-nothing: the acquirer is called, then a failed insert or a crash leaves money half-moved.
- *Bugs:* 14, 20, 23, 24, 25, 27, 28, 37, 43, 49, 53, 66, 70, 73, 74.
- *Guard:*
  - New constraints:
    - `CHECK (refunded_fils <= captured_fils)` (0076)
    - a unique content hash on CSV imports (0074)
    - unique callback notes (0078)
    - unique `settlement.paid` per batch and one disbursement per batch
  - Row locking with `FOR UPDATE`, and relative updates (`refunded_fils = refunded_fils + n`).
  - `ON CONFLICT DO NOTHING`, and replays keep their delivery ID.
  - Compensation when a step throws, plus a recovery pass at boot and every minute.
  - Concurrency tests, and `perf/checkout/invariants.sql` run after load tests.

**5. Derived state not rebuilt from the source of truth**
- *Decision behind it:* Balances, statuses and reports were rebuilt from secondary data instead of the ledger:
  - the console rebuild read scheme export lines (ADR-0004 claimed they agree)
  - MDR recalculation rewrote batches already paid
  - the reporting cursor followed IDs instead of commit order
  - a status recompute flipped test merchants live
- New event types were added at one point and never carried downstream. Refunds reached the ledger but not settlement, reconciliation, webhooks, reports or the UI.
- *Bugs:* 09, 16, 30, 31, 32, 33, 34, 35, 39, 42, 51, 58, 63, 78.
- *Guard:*
  - ADR-0007 (proposed): every balance rebuild reads the ledger.
  - Paid history is immutable.
  - Commit-ordered outbox reading (0079).
  - Proposed: a checklist that each new money event must satisfy. It must be handled in settlement, reconciliation, webhooks, reporting and the UI before it ships.

**6. Bahrain business day and date windows**
- *Decision behind it:* Day boundaries were computed in the server's UTC, which contradicts the Bahrain business day. Date ranges included their end day. Unfinished days could be closed, and effective dates could move past rows. The seed fixtures avoided the 00:00-03:00 Bahrain window, so nothing exposed these bugs.
- *Bugs:* 17, 40, 56, 65.
- *Guard:*
  - One helper builds Bahrain day windows, and every range runs from the start of one day up to, but not including, the next.
  - Closing a day that hasn't ended is refused (409).
  - Tests use captures between 00:00 and 03:00 Bahrain time.

**7. Migration, deploy and secrets hygiene**
- *Decision behind it:* Nobody ran migrations on a fresh database. Reserved numbers were reused, and the runner tracks only filenames. Secrets and seed passwords were committed. Missing `NODE_ENV` silently meant dev mode, which returns the OTP. Uploads were stored inside the container.
- *Bugs:* 01, 62, 68, 71, 72, 76.
- *Guard:*
  - New migrations start at 0073.
  - Startup is refused without an explicit `NODE_ENV`.
  - Secrets live in an untracked `ops/.env` created per deployment (`init-env.sh`).
  - KYC uploads have a volume.
  - Proposed: run migrations on a fresh database in CI, add secret scanning, and checksum migrations.

**8. Performance and resilience**
- *Decision behind it:* No load test was ever run. Hot paths had no indexes, exports and archives were unbounded, and simulator caches grew forever. One bad event or one dead endpoint stalled a whole worker.
- *Bugs:* 52, 55, 64, 67, 75, 77, 79.
- *Guard:*
  - Indexes on the ledger, holds and link lookups (0085, 0086).
  - Streaming and paging, and bounded caches.
  - A bad row is skipped or quarantined instead of retried forever.
  - Live load test with cgroup CPU measurement (`perf/checkout/`).
