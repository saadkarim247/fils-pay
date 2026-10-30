## Findings 01–40

Each finding is summarised here. The full write-up, with every test case, is in `docs/bugs/points/NN-*.md`. Each fix is one commit. Line numbers point to the code as it was before that fix.

### 01. A fresh database cannot be migrated — High
**Symptom.** Setting up FilsPay on an empty database stops at `0054_views.sql`, so the 15 migrations after it never run. The services still start, then fail at runtime: merchant sessions, payout disbursements, credit approvals, CSV imports, webhook archives and the refund rules are all missing.
**How found / reproduced.** We read the migrations against ADR-0005, which reserves 0054–0056 for settlement v2. Then we ran `db/migrate.ts` on an empty database. It failed at 0054, and once 0054 was fixed it failed at 0055.
**Root cause.** `0054_views.sql:10-22` builds a view on `settlement_batch_events`, a table no migration creates. `0055` inserts columns and a `'suspense'` kind that `chart_of_accounts` (0007) doesn't have. `db/migrate.ts:51-55` stops at the first failure, so the 0054 failure hid the one in 0055.
**Fix.** The broken view and the broken INSERT are commented out, with an explanation. Neither object was used anywhere. Filenames are unchanged, so databases that already applied them are unaffected (commit `6583411`).
**Verified by.** New `db/migrate.fresh.test.ts`, now part of `npm test`. It migrates a throwaway empty database, checks the late objects exist and the account kinds are allowed, and checks a second run applies nothing.
**Effect on existing data.** None. The change is to the schema only, and databases that already recorded 0054/0055 skip them. Renaming the files out of ADR-0005's reserved range is left as a planned follow-up, because the runner tracks migrations by filename.

### 02. Merchant login never actually requires the OTP — Critical
**Symptom.** A password alone gives full dashboard and API access. The cookie from step 1 of login already works before any one-time code (OTP) is entered.
**How found / reproduced.** A brief hint ("login works without entering the OTP"). Migration 0012 says every login check must test `authenticated = true`, and the code doesn't. Reproduced by signing up, calling `/login`, then calling `/v1/auth/me` and `/v1/transactions` with that cookie: both returned 200.
**Root cause.** `apps/api/src/auth/sessions.ts:89-92`: `lookupSession` reads the `live_sessions` view, which filters only revoked and expired sessions. The `authenticated` check was never added.
**Fix.** Add `AND s.authenticated = true` to the query (commit `0685a87`).
**Verified by.** `apps/api/src/auth/pendingSession.test.ts` (6 tests). The password-only cookie now gets 401 on both endpoints and 200 after OTP. Also checked with curl on the running stack.
**Effect on existing data.** No rows are wrong. Sessions that never finished OTP are rejected from the moment the fix is deployed. What can't be seen from the database is whether a password-only session was misused before the fix. That needs the request logs. No correction was run.

### 03. Login can hand you another merchant's account — High (Critical together with 02)
**Symptom.** Logging in to merchant X with X's password can create the session on a different merchant's user who has the same email.
**How found / reproduced.** Reading the code. The password check and the session creation use different user rows. Reproduced through the real endpoints: an attacker signs up a new merchant with the victim's email and their own password, logs in, and `/me` shows the victim's merchant.
**Root cause.** `apps/api/src/routes/auth.ts:78` replaces the user whose password was checked with `findOtpRecipient(email)`. That function (`auth/users.ts:15-21`) searches every merchant with `LIMIT 1` and no ordering.
**Fix.** Create the OTP challenge and the session for the user whose password was checked. The cross-merchant lookup is deleted (commit `5c5aa3e`).
**Verified by.** `apps/api/src/routes/loginTenant.test.ts` (4 tests, both directions, so the result doesn't depend on row order). Also replayed on the running stack.
**Effect on existing data.** Sessions already issued on the wrong user stay valid until they expire, because the fix doesn't revoke them. The database doesn't record which merchant was chosen at login, so these sessions can't be picked out. We recommend revoking all live merchant sessions once at deploy (`UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL`). This was not run.

### 04. "View as merchant" can move money — High
**Symptom.** An admin who is "viewing as" a merchant can capture and void that merchant's payments. Finance and super-admin staff can also create payment links and webhook endpoints as the merchant.
**How found / reproduced.** HANDOVER says impersonation is always read-only with the `support` role, and the code doesn't follow that. Confirmed in `docs/exports/admin-audit-2026-09.csv`: all 16 super-admin impersonations ran as `owner` and all 16 by finance staff ran as `finance`. Reproduced with a real grant capturing a real authorised payment.
**Root cause.** `apps/api/src/admin/impersonation.ts:88` maps `super_admin → owner` (and finance → finance). Capture and void (`routes/transactions.ts:95,123`) have no role check at all, so even a `support` grant could capture.
**Fix.** Every grant now resolves to `support`. `requireMerchantAuth` refuses any request other than GET/HEAD that carries an impersonation grant, with a 403 (commit `9f4e04d`).
**Verified by.** `apps/api/src/admin/impersonationReadOnly.test.ts`: 12 tests, 4 for each admin role. 7 failed before the fix and all pass after. Also replayed on the running stack.
**Effect on existing data.** Not corrected. Writes made during impersonation are recorded as `merchant_session`, so they look like the merchant's own actions. To find them, line up the 32 owner/finance impersonation windows in the audit export with the captures, voids, links and webhook endpoints created in those windows. Webhook endpoints created that way need checking first, because they can send a merchant's data to an outside URL.

### 05. Rotating an API key leaves the old key working — High
**Symptom.** An admin "rotates" a possibly leaked key and the console says it is revoked. In fact the old key still reads data and takes payments.
**How found / reproduced.** A brief hint ("a key rotation flow doesn't do what you'd expect"). Migration 0037 and the route's own comment both say "revoke + reissue". Reproduced: after rotation, the old key still authorised a new payment (201), and rotating it again created yet another live key.
**Root cause.** `apps/api/src/admin/apiKeys.ts:20` locks the old key `FOR UPDATE`, then never sets `revoked_at` on it. The `revoke_after` column (0056) is never used.
**Fix.** Inside the same transaction, set `revoked_at = now(), revoked_reason = 'rotated'` on the old key (commit `cca2b57`).
**Verified by.** `apps/api/src/admin/apiKeyRotation.test.ts` (5 tests): the old key gets 401, a second rotation gets 409, and the merchant's other keys are untouched. 4 failed before the fix.
**Effect on existing data.** Important: every key rotated before the fix is still live. That is 14 rotations in September alone. The fix applies only to new rotations. One-off correction, not run: `UPDATE api_keys o SET revoked_at = now(), revoked_reason = 'rotated' FROM api_keys n WHERE n.rotated_from_key_id = o.id AND o.revoked_at IS NULL`. Warn the affected merchants first, in case an integration still uses the old key.

### 06. Large-credit approval compares names, not people — High
**Symptom.** Manual credits above 50.000 BD need a second person to approve them. Because the check compares display names, an admin whose name has changed can approve their own credit.
**How found / reproduced.** HANDOVER says the approver is compared by admin user id, and AGENTS.md says by display name. Reproduced end to end: a requester renamed, then approved their own 60.000 BD credit (200), and the money posted to the ledger.
**Root cause.** `apps/api/src/admin/creditApproval.ts:11` compares `approver.displayName === requester.displayName`. Display names (0031) are neither unique nor stable.
**Fix.** Compare `adminUserId`. Names are kept for display only (commit `a418e75`).
**Verified by.** `apps/api/src/admin/creditTwoPerson.test.ts` (5 tests). The renamed requester gets 409 and nothing posts. Two different admins with the same name can approve each other. All 22 existing credit tests still pass.
**Effect on existing data.** Any credit someone approved for themselves is already posted. Find them with `SELECT * FROM credit_requests WHERE approved_by_admin_user_id = requested_by_admin_user_id`. This was not run against production. Finance should review any rows it finds.

### 07. Support staff can pay merchants with manual credits — High
**Symptom.** Any admin, including the lowest role (`support`), can create a manual credit through the API. Credits at or below 50.000 BD post to the merchant's ledger immediately.
**How found / reproduced.** A brief hint ("some admin actions lack role checks"). Found while fixing 06: the function's doc says "a support caller gets a 403", but nothing enforces it. Reproduced: a support admin's 10.000 BD credit returned 201 and posted.
**Root cause.** `apps/api/src/routes/adminCredits.ts:41-78`: the create route sits in a scope that only checks `requireAdminSession`. Approve and reject (`:81-82`) also check the role.
**Fix.** Add `requireAdminRole("finance", "super_admin")` to the create route (commit `49a10ac`).
**Verified by.** `apps/api/src/routes/adminCreditsCreateRole.test.ts` (5 tests). Support gets 403 with no credit and no ledger legs written. Finance and super_admin still work.
**Effect on existing data.** Credits created by support accounts are already posted. Find them by joining `credit_requests.requested_by_admin_user_id` to `admin_users` where the role is `support`. Not run. Finance should decide which of them stand.

### 08. Bulk KYC approve lets unvetted and rejected merchants take payments — High
**Symptom.** "Bulk approve" approves every ticked merchant, including ones that never applied and ones that failed KYC. It also leaves no review record.
**How found / reproduced.** ADMIN.md says only `under_review` merchants are affected. Migration 0016 says KYC approval may only go through `merchant_kyc_reviews`. Reproduced: a rejected merchant swept into a bulk approve then took a card payment (201).
**Root cause.** `apps/api/src/admin/bulkKyc.ts:27` runs one bare `UPDATE merchants SET onboarding_status='approved', kyc_passed=true WHERE id = ANY($1)`. It has no state filter and writes no review rows.
**Fix.** Lock and select only the `under_review` merchants, and approve each one through `recordKycReviewInTx`, with the admin recorded as reviewer (commit `b355b7e`).
**Verified by.** `apps/api/src/admin/bulkKycApprove.test.ts` (7 tests, including rollback when the audit write fails). All 6 behaviour tests failed before the fix.
**Effect on existing data.** Merchants approved this way stay approved and can still take payments. That includes the September bulk run of 6. Find them as approved merchants with no matching `merchant_kyc_reviews` row. Not corrected. Compliance must re-review them, because their state before approval wasn't recorded.

### 09. "Recompute statuses" puts test merchants into real settlement — High
**Symptom.** A support clean-up tool switches sandbox (test) merchants to live. The next settlement run then pays out their test captures as real money.
**How found / reproduced.** A brief hint ("test merchants show up in the real settlement run"). Slack, 19 Sep: Recompute on Gamma returned `testModeCleared: true`, and the audit export has the matching row. Reproduced on seeded Gamma.
**Root cause.** `apps/api/src/routes/adminMerchantsRecompute.ts:28` calls `reconcileSandboxFlag` (`admin/merchantFlags.ts:10-16`). That clears `test_mode` whenever "open authorisations" is 0. The count (`transactionStatusRecompute.ts:29,47`) leaves out `authorized` rows and then counts `authorized` rows, so it is always 0.
**Fix.** Remove the side effect. The tool only recomputes statuses, and `merchantFlags.ts` is deleted (commit `1a870ab`).
**Verified by.** `apps/api/src/routes/adminRecomputeStatuses.test.ts` (5 tests): sandbox merchants stay sandbox, and stale statuses are still fixed. 3 failed before the fix.
**Effect on existing data.** Needs correcting, which we did not do. Find every `transaction_status_recompute` audit row with `testModeCleared: true` (Gamma, 19 Sep). Set `test_mode` back to true on those merchants, and reverse any settlement batches and payouts made to them since then. This needs finance review.

### 10. Any merchant can read a marketplace sub-merchant's transactions — High
**Symptom.** The transactions report accepts any sub-merchant's id, even one in another marketplace, and returns up to 500 of that shop's transactions.
**How found / reproduced.** Reading the reporting scope code. Reproduced with an unrelated merchant's API key asking for Delta Marketplace's child Coral Bay: it got Coral Bay's rows.
**Root cause.** `apps/api/src/reporting/scope.ts:13` checks only that the id is somebody's child in `merchant_split_children`. It never checks that the parent is the caller.
**Fix.** Add `AND parent_merchant_id = $2`, the caller (commit `3e7afc3`).
**Verified by.** `apps/api/src/routes/reportingScope.test.ts` (6 tests, two marketplaces and an outsider). The 3 "cannot read" tests failed before the fix.
**Effect on existing data.** None. The bug exposed data but changed nothing. Whether it was used against real merchants can only be told from access logs, not from the database.

### 11. Any merchant can cancel another merchant's payment links — High
**Symptom.** Merchant B can cancel merchant A's live payment links, and can probe the status of any link.
**How found / reproduced.** The brief's group chat ("merchant A cancelled merchant B's payment link"). Confirmed by reading the code. Reproduced: B's cancel returned 204, and a probe returned 409 with the status `canceled`.
**Root cause.** `apps/api/src/paymentLinks/cancel.ts:16,26` matches the link by id only (`WHERE id = $1 AND status = 'active'`). The route checks only the merchant id in the URL.
**Fix.** Both queries filter on the caller's merchant id. Someone else's link gives 404 (commit `a563baa`).
**Verified by.** `apps/api/src/routes/paymentLinkCancelScope.test.ts`: B gets 404 and the link stays active. The owner can still cancel.
**Effect on existing data.** Links cancelled by another merchant stay cancelled. Nothing records who cancelled a link (`payment_links` has `canceled_at` only), so they can't be found in the database. Merchants who report it can have their link recreated. Not corrected.

### 12. Anyone can post fake fraud verdicts to the acquirer callback — High
**Symptom.** The public acquirer endpoint records "cleared" or "confirmed_fraud" verdicts on a payment's timeline, and staff act on them. Anyone on the internet can post one.
**How found / reproduced.** Reading the code. The route calls the signature its only authentication, but the check fails open. Reproduced: an unsigned request was accepted, and so was a 10-minute-old one.
**Root cause.** `apps/api/src/webhooks/inboundVerify.ts` accepts a missing signature unless a flag (off by default) is set. It never checks the timestamp (parsed at `:26`). It hashes re-serialised JSON instead of the raw body, and uses a compare that is not constant-time. The route never validates `outcome`.
**Fix.** Always require a configured secret and a signature, and reject timestamps more than 5 minutes off. Hash the exact raw body, compare with `timingSafeEqual`, and accept only `cleared` or `confirmed_fraud` (commit `4e5a9c4`).
**Verified by.** `apps/api/src/routes/acquirerCallbackAuth.test.ts` (6 tests). 5 failed before the fix. All 20 callback tests pass.
**Effect on existing data.** Not identifiable. Signatures aren't stored with the notes in `acquirer_callback_notes`, so a forged verdict can't be told from a real one. Any void or refund decided on a callback verdict should be checked against the acquirer's own records before it is trusted. The signing secret that was committed in `ops/.env.docker` must also be treated as leaked and rotated.

### 13. CSV balance corrections post one tenth of the amount — Critical
**Symptom.** Finance's balance-correction CSV posts every amount at one tenth of its value and drops the third decimal: "4.75" posts 0.475 BD, "4.755" posts 0.475, and "0.005" posts nothing.
**How found / reproduced.** The finance memo in the brief ("4.75 BD → 0.475"). Slack #fp-finance, 27 Aug: a 4,141.90 BD sheet posted 414.190 BD. The test reproduces that exact figure.
**Root cause.** `apps/api/src/admin/adjustmentCsvParsing.ts:8` calls `parseDecimalMinor(raw, decimals = 2)` (`lib/decimal.ts`), which treats the amount as cents. FilsPay uses fils, with 3 decimals (ADR-0001).
**Fix.** Parse with the money package's `parseBhdToFils`. It reads 3 decimals and rejects malformed rows, so a bad row fails the whole import. The cents helper is deleted (commit `c797270`).
**Verified by.** `apps/api/src/admin/adjustmentCsvAmount.test.ts` (16 tests, including the 4,141.90 sheet end to end). 12 failed before the fix. 5 old assertions that expected the cents values were corrected.
**Effect on existing data.** Every past import is under-posted. We did not correct this. Each row still has its original text in `raw_amount_text`, so the shortfall per row is exactly `parseBhdToFils(raw_amount_text) − parsed_amount_fils`. Post that as a correcting entry per merchant, after finance review. Watch for the overlap with 20: a file posted twice was under-posted twice.

### 14. The nightly hold job deletes every hold on a quiet night — Critical
**Symptom.** The job meant to mark abandoned card holds as `expired` deletes them instead. On any night when nothing has expired, it deletes every hold in the table.
**How found / reproduced.** HANDOVER says "holds are never deleted", so we read the script. Reproduced by running the real script on a fresh database with two live holds and none expired: 2 holds went to 0.
**Root cause.** `scripts/expire_holds.ts:25,44-45` deletes the expired ids using `buildWhere` (`scripts/lib/sqlFilter.ts:10,20`). That helper skips empty lists, so with no ids the query becomes `DELETE FROM holds`. Selecting first and deleting afterwards also leaves a race (comment at `:42`).
**Fix.** One atomic statement: `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < now()`. The delete helper and its test, which checked only the SQL text, are removed (commit `417580f`).
**Verified by.** `scripts/expire_holds.behaviour.test.ts`, which runs the real script on its own database: the quiet night leaves the count unchanged, an expired hold is kept as `expired`, and a second run changes nothing.
**Effect on existing data.** Deleted holds are gone and can't be restored from the database. The amount reserved on each card is still on the transaction, so live holds could be rebuilt from transactions still in `authorized` that have no hold row. This was not done. Backups taken before a quiet night are the only full record.

### 15. Large payouts are off by fils (32-bit floating point) — High
**Symptom.** Daily payouts above about 16,777 BD are wrong by 1 fil or more, and the error grows with size. Delta Wholesale, 14 Sep, was paid 19,580.119 BD instead of 19,580.120.
**How found / reproduced.** Code read: ADR-0001 says money is never a float, and `.cursorrules` calls the `float32` "intentional". Confirmed in `docs/exports/settlement-batches-2026-09-01_20.csv`, where 13 batches are off by 1–2 fils. The test reproduces the Delta figure exactly.
**Root cause.** `apps/settlement/internal/settlement/payable.go:11`: `netBD := float32(grossFils)/1000 - float32(feeFils)/1000`. A float32 can't hold every whole number above 2^24 (16,777,216 fils).
**Fix.** `return grossFils - feeFils` (commit `7af0d98`).
**Verified by.** `internal/settlement/payable_exact_test.go`: five sizes, a sweep of about 3,000 values, and a real `CloseBatch` of 20,000.123 BD whose stored payout must equal gross − fee. All 3 tests failed before the fix.
**Effect on existing data.** Paid batches are wrong by a fil or two, and those payouts have already been sent. Find them with `SELECT … FROM settlement_batches WHERE status='paid' AND net_payout_fils <> gross_fils - fee_fils` (13 in 1–20 Sep). The differences should be paid out or recovered per merchant. Not corrected: finance must decide.

### 16. "Recalculate MDR" rewrites batches that were already paid — High
**Symptom.** After a merchant's fee rate (MDR) changes, the recalculation tool also rewrites the fee and payout of batches that were already paid. Those records then show amounts that were never sent.
**How found / reproduced.** The finance memo ("MDR recalculation changes batches that were already closed/paid out"). The run on Delta Marketplace on 11 Sep rewrote 9 paid batches by −41.870 BD. Reproduced: a paid batch's payout went from 39,000 to 38,800.
**Root cause.** `apps/settlement/internal/settlement/recalculate_mdr.go:67` selects `status <> 'open'`, which includes paid batches, then runs `UPDATE settlement_batches SET fee_fils, net_payout_fils` (`:109`) and posts adjustment legs.
**Fix.** Recalculate only `status = 'closed'` batches, which are closed but not yet paid (commit `c82f321`).
**Verified by.** `internal/settlement/recalculate_mdr_paid_test.go`: the paid batch is unchanged and the unpaid one moves to the new fee. The 4 existing MDR tests still pass.
**Effect on existing data.** Not corrected. The 9 Delta Marketplace batches, and any other paid batch a past run touched, now show figures that don't match what was sent to the bank, and they carry adjustment legs that no payout ever collected. Restore each one's fee and payout from the payout or bank records and reverse those legs. Any real fee difference should be carried into a future batch. This needs finance review.

### 17. The daily settlement close runs at 03:00 Bahrain time, not midnight — High
**Symptom.** Every merchant's batch, scheme file and payout runs about three hours late each day.
**How found / reproduced.** The brief's group chat ("daily close runs at 3am"). In `docs/exports/settlement-batches-2026-09-01_20.csv`, all 80 batches were paid between 03:05 and 03:09 Bahrain time. Reproduced with fixed clock times: at 00:20 the daemon picked the wrong day, and at 00:10 it was already "due".
**Root cause.** `apps/settlement/internal/scheduler/daemon.go:79-81` passes `time.Now().UTC()` to `BusinessDayWindow`. That function (`settlement/window.go:44`) reads the calendar date in the zone it is given, which is UTC. The comment at `:78` says it converts to Bahrain time; it doesn't.
**Fix.** A new `BusinessDateOf(instant)` gives the Bahrain calendar date, and the daemon uses it. The "is it due?" decision is now a small pure function (commit `57a190d`).
**Verified by.** `internal/scheduler/due_test.go`: 6 clock cases, including the grace period and New Year's Day. 4 failed before the fix.
**Effect on existing data.** None. Batch contents were always correct, because the day boundaries themselves were right. Only the time of the run was wrong.

### 18. The fee rate shown is not the rate charged — High
**Symptom.** The admin console shows Alpha Retail at 245 bps, but captures are charged 225 bps. A rate scheduled for the future also showed as current.
**How found / reproduced.** The finance memo ("245 bps shown but payments go through at 225"). Seeded Alpha Retail has 225 bps from 1 Aug plus a 245 bps March correction entered on 15 Aug. The test compares the displayed rate with the fee a real capture posts.
**Root cause.** `apps/api/src/fees/currentFeeScheduleDisplay.ts:36` picks the most recently *entered* row (`ORDER BY created_at DESC`) with no effective-date filter. Capture uses the latest row whose effective date has arrived. In Go, `fee_schedule.go:32` breaks same-day ties by row order.
**Fix.** The display uses capture's rule: `effective_from <= now() ORDER BY effective_from DESC, created_at DESC`. Go now orders ties by `created_at`, so it matches capture (commit `3b9eec9`).
**Verified by.** `apps/api/src/fees/feeDisplayMatchesCharge.test.ts` (4 cases) and `internal/settlement/fee_schedule_tiebreak_test.go`. Before the fix: 245 shown against 225 charged, and Go picked 230 instead of 210.
**Effect on existing data.** Captures were charged correctly, so no capture fees are wrong. The one possible exception is a batch settled when a merchant had two rates starting on the same day, because Go may have used the other row. Check with `SELECT merchant_id, effective_from FROM fee_schedules GROUP BY 1,2 HAVING count(*) > 1`. Not run. Rates quoted to merchants from the console may have been wrong.

### 19. The platform volume discount switches itself off (32-bit overflow) — High
**Symptom.** Once the platform has processed 2,000,000 BD, every merchant gets 15 bps off their rate. About 147,000 BD later the running total wraps to a large negative number, and the discount silently stops for everyone.
**How found / reproduced.** Code read. The column is `INTEGER`, and comments falsely claim it is 64-bit or `BIGINT`. Reproduced: a counter at 2,100,000,000 plus a 100,000 BD batch became −2,094,967,296.
**Root cause.** `db/migrations/0049_platform_stats.sql`: `total_processed_fils INTEGER`, which holds at most about 2,147,483 BD. `apps/settlement/internal/settlement/platform_volume.go:13-26` adds to it as `int32`.
**Fix.** New migration `0073_platform_stats_bigint.sql` widens the column to BIGINT. Go uses `int64`, and TypeScript reads the BIGINT text with `Number()` (commit `2f6be7c`).
**Verified by.** `internal/settlement/platform_volume_overflow_test.go` (the counter reaches 2,200,000,000 and the tier stays on) and `apps/api/src/fees/platformVolumeOverflow.test.ts`.
**Effect on existing data.** The migration keeps whatever value is stored. If production's counter has already wrapped, it is negative now and stays wrong. Recompute it from captured volume. Every capture and batch priced while it was wrapped was overcharged 15 bps and needs a finance refund. We don't know whether production reached the wrap point, and we didn't correct anything.

### 20. The same balance-correction file can be applied twice — High
**Symptom.** Uploading the same adjustment CSV again posts every row a second time, as real ledger legs.
**How found / reproduced.** ADMIN.md admits it ("no duplicate detection yet"), and a code comment wrongly claims a unique filename blocks it. In `docs/exports/admin-audit-2026-09.csv`, `aug-adjustments-v3-FINAL.csv` (31 rows) was applied twice by the same person, 22 seconds apart. Reproduced by uploading the same file twice: both posted.
**Root cause.** `db/migrations/0065_adjustment_imports.sql:8,14`: `adjustment_imports` has no uniqueness of any kind. The only index is a non-unique one on the uploader.
**Fix.** Migration `0074` adds `content_sha256` with a partial unique index. The fingerprint is (merchant, exact fils, reason) per row, sorted, so a renamed or re-sorted copy matches. A duplicate gets 409 before any leg is posted, even when two uploads race (commit `0c8b213`).
**Verified by.** `apps/api/src/admin/adjustmentImportDuplicate.test.ts` (6 tests: renamed copy, CRLF, two at once, changed amount, rollback). 4 failed before the fix.
**Effect on existing data.** The September double application is still in the ledger and should be reversed with one correcting entry per merchant. Not done. Past imports have no hash (NULL), so the new check doesn't cover them and can't stop an old file being uploaded again. Correct for 13 at the same time, because those postings were also 10 times too small.

### 21. Payment-link sales miss the merchant's negotiated discount — High
**Symptom.** Merchants with a fee discount get it on API captures but not on payment-link sales. A 10 BD link sale at 250 bps with a 20% discount was charged 0.250 BD instead of 0.200.
**How found / reproduced.** Code read: the code comment saying the discount had "moved into capture.ts" was false. Reproduced by comparing an API capture and a real link payment for the same merchant: 200 fils against 250.
**Root cause.** `apps/api/src/paymentLinks/pay.ts:115`: the link flow calls `captureTransaction` but never `applyCaptureDiscountAdjustment`, which only the API route calls (`routes/transactions.ts:110-115`).
**Fix.** Call `applyCaptureDiscountAdjustment` after a link capture succeeds. It is the same idempotent step the API route uses (commit `602019b`).
**Verified by.** `apps/api/src/paymentLinks/linkDiscount.test.ts` (2 tests, with and without a discount).
**Effect on existing data.** Every past link sale by a merchant with a discount is missing its rebate, so those merchants were overcharged. The adjustment is idempotent, so it could be run once for each past link capture that lacks a discount entry. That backfill was not done, and finance should approve it first.

### 22. Reusing a capture key "succeeds" without capturing the payment — High
**Symptom.** If a merchant sends the same `Idempotency-Key` for a different transaction, the API replays the first transaction's 200 reply. The second payment is never captured, but the merchant is told it was.
**How found / reproduced.** Code read against migration 0019, which says the fingerprint covers the transaction id. Reproduced: capturing B with A's key returned 200 with A's response body, and B stayed authorised.
**Root cause.** `apps/api/src/payments/capture.ts:92`: the request fingerprint covers only the amount, not the transaction id.
**Fix.** Include `transactionId` in the fingerprint. Reuse on another transaction now gets 422 `idempotency_key_reused` (commit `5387edf`).
**Verified by.** `apps/api/src/payments/captureIdempotencyScope.test.ts` (3 tests): reuse is refused, a real retry replays, and a fresh key captures.
**Effect on existing data.** No ledger rows are wrong. The affected payments simply were never captured, and their authorisations have expired. The replayed request wrote no row of its own, so the database can't list them. Merchants would find them as orders marked paid with no capture. Not corrected.

### 23. One payment link can charge two buyers — Critical
**Symptom.** A single-use link paid by two buyers at about the same time charges both cards, and both are told "paid". This is incident 2026-05-14.
**How found / reproduced.** The incident notes, plus a code comment where FH says the case "IS reachable" and MK says it is "unreachable". CHANGELOG 1.6.0 blames duplicate callbacks, which only write notes. Reproduced with a 0-second reservation timeout, 150–250 ms of acquirer delay and two buyers at once: two captures and two 200s.
**Root cause.** `apps/api/src/paymentLinks/pay.ts:68-72` lets a second buyer take over a reservation once it looks stale. The final step (`:149`) doesn't check who holds the reservation, a 0-row finalize still answers "paid" (`:157-169`), and one buyer can release another's reservation.
**Fix.** Migration `0075` gives each reservation an owner id. The link is committed as paid, only if this buyer still holds it, before the card is captured. The losing buyer's authorisation is voided and they get 409 (commit `351cab5`).
**Verified by.** `apps/api/src/paymentLinks/linkOneBuyer.test.ts`: exactly one capture, the loser's authorisation voided, no active hold left. 3 of 3 runs pass.
**Effect on existing data.** Double charges that already happened are still in place. A link stores only one payment, and there is no `payment_link_id` on transactions, so the second charge can't be found by a simple query. It has to be matched by amount and time against the acquirer statement, starting with the 2026-05-14 case. Each one found then needs a refund. Not done.

### 24. Payouts get duplicate notifications and duplicate disbursement records — Critical
**Symptom.** One paid batch can produce several "payout sent" (`settlement.paid`) events and several disbursement rows. Each disbursement row is an instruction to the payout rail. This is incident 2026-08-21.
**How found / reproduced.** The incident review in ADMIN.md. Its own note says the two deliveries had different event ids, which contradicts its "replay" explanation. Code comments falsely claim a unique index exists. Reproduced with four notify runs at once over 12 paid batches: 4 events per batch.
**Root cause.** `apps/settlement/internal/settlement/payout_notify.go:37` checks `NOT EXISTS`, then inserts, with no lock. `apps/api/src/webhooks/dispatcher.ts:160-162` wrote the disbursement as a side effect of each webhook delivery: once per endpoint and per replay, and never for a merchant with no webhook endpoint.
**Fix.** The disbursement is recorded inside `PayoutBatch`/`PayoutSplitBatch`, under the batch lock, exactly once. Delivery only notifies, and notify takes the batch row lock and checks again (commit `c0f764d`).
**Verified by.** `internal/settlement/payout_disbursement_test.go` (one disbursement per batch, one event under concurrency) and `apps/api/src/webhooks/settlementPaidNoDisbursement.test.ts`.
**Effect on existing data.** Not corrected, in both directions. Duplicate `settlement.paid` events and duplicate disbursement rows from before the fix are still there. That is also why no unique index was added: it couldn't be built over them. Batches paid to merchants with no webhook endpoint have no disbursement row at all. Finance must check duplicates against the payout rail before deleting any. Missing rows can be added from `settlement_batches` where the status is paid.

### 25. A refund without a reason sends the money but records nothing — Critical
**Symptom.** A refund with no reason fails only after the acquirer has already returned the money. No refund row is written, the ledger is unchanged, and the idempotency key stays stuck.
**How found / reproduced.** Fixing 01 meant migration 0070 actually ran, and 11 existing refund tests then failed on `chk_refunds_reason_not_null`. Reproduced by refunding with no reason.
**Root cause.** `apps/api/src/payments/processRefund.ts:189` passes `input.reason ?? null`. An explicit NULL skips 0070's `'unspecified'` default and fails its check, and the insert runs after the acquirer call.
**Fix.** The reason is normalised first: a missing or blank reason becomes `'unspecified'`, and the same value goes into the fingerprint and the row (commit `12b2cbf`).
**Verified by.** `apps/api/src/refunds/refundReason.test.ts` (4 tests). The 11 existing refund tests that had been failing pass again.
**Effect on existing data.** None in production. Refunds were never exposed (`POST /v1/refunds` returned 501 until FP-300), and in production 0070 could only apply on a database that got past 01. On any test database, refunds that hit this left no row. Only the acquirer's records show them.

### 26. A merchant can refund another merchant's sale — Critical
**Symptom.** Merchant B can refund merchant A's transaction. A's customer gets the money back, and A's balance is debited. B can also get round A's refund hold.
**How found / reproduced.** A TODO in the test file ("another merchant's transactionId should also 404. currently refunds it"); the test guarding this had been deleted. Reproduced: B's refund of A's sale succeeded.
**Root cause.** `apps/api/src/refunds/initiateMerchantRefund.ts:62-73` looks the transaction up by id only and passes on the transaction's own merchant. `processRefund.ts:73-78` also matches by id only. The refund hold is checked against the caller.
**Fix.** Both lookups match `id AND merchant_id = <authenticated merchant>`. Anyone else's transaction gives 404 (commit `71a8ebe`).
**Verified by.** `apps/api/src/refunds/refundScope.test.ts` (4 tests): no refund row, no ledger legs, and `refunded_fils` stays 0.
**Effect on existing data.** None in production, because refunds were not exposed (501). If a test database has any, they can be found with a query: `refunds.created_by_id` records who started each refund, so check it against the transaction's merchant.

### 27. A refund can return more than was ever captured — Critical
**Symptom.** On a payment that was only partly captured (authorise 10 BD, capture 4 BD), a full 10 BD refund is accepted. A "refund the rest" with no amount returned 8.5 BD when only 2.5 BD was left.
**How found / reproduced.** A brief hint ("refund more than was charged?") and a code read. Reproduced with authorise 10,000 and capture 4,000 fils: the 10,000 refund succeeded.
**Root cause.** `apps/api/src/payments/processRefund.ts` (around `:90`, before the earlier fixes) computes refundable as authorised − refunded instead of captured − refunded. The database had no limit (0043 left it to the application).
**Fix.** Refundable is captured − refunded. Migration `0076` adds `CHECK (refunded_fils <= captured_fils) NOT VALID` as a backstop (commit `cb044bc`).
**Verified by.** `apps/api/src/refunds/refundCeiling.test.ts` (3 tests: 422 over the limit, exact limit, remainder). All 3 failed before the fix.
**Effect on existing data.** None in production, because refunds were not exposed. The constraint is `NOT VALID` on purpose, so existing rows aren't re-checked. `SELECT id FROM transactions WHERE refunded_fils > captured_fils` lists any that break the rule; on production it should come back empty.

### 28. Simultaneous refunds all pay out, and the books lose track — Critical
**Symptom.** Five 3 BD refunds of a 10 BD sale sent at the same time all paid out, 15 BD in total. The ledger reversed 15 BD, but the transaction said only 3 BD was refunded. This is FP-209.
**How found / reproduced.** Ticket FP-209 ("normal payments don't have this problem"). Capture locks the row while it calls the acquirer, and refund doesn't. Reproduced with 60–120 ms of acquirer delay and five refunds at once: 5 of 5 succeeded.
**Root cause.** `apps/api/src/payments/processRefund.ts`: the checks run without a row lock, the acquirer is called outside any transaction (original `:146`), and then `refunded_fils` is overwritten with a value worked out from the old read (original `:199-203`).
**Fix.** One transaction, like capture: claim the key, lock the row `FOR UPDATE`, check, call the acquirer while still holding the lock, then `refunded_fils = refunded_fils + n` (commit `d9d4f30`).
**Verified by.** `apps/api/src/refunds/refundConcurrency.test.ts`: at most 3 of 5 succeed, and the rows, `refunded_fils` and the ledger all agree. Of two full refunds sent at once, one succeeds. 3 of 3 runs pass.
**Effect on existing data.** None in production, because refunds were not exposed. On any database that has refunds, `SELECT t.id FROM transactions t JOIN refunds r ON r.transaction_id = t.id AND r.status='succeeded' GROUP BY t.id, t.refunded_fils HAVING sum(r.amount_fils) <> t.refunded_fils` finds totals that lost an update.

### 29. Refunds give back the wrong amount of fee — High
**Symptom.** Partial refunds give back more or less fee than was charged: 21 fils of a 22-fil fee, or 26 of a 25-fil fee. On a full refund, a merchant with a discount gets back the full fee rather than the discounted fee they paid (250 instead of 200 fils).
**How found / reproduced.** HANDOVER claims the partial shares "sum back", so we checked that claim with real numbers. Reproduced against the ledger: 333+333+334 at 225 bps, and 300+700 at 250 bps.
**Root cause.** `packages/money/src/fils.ts:260` (`calculateRefundFee`) is applied to each refund on its own, so the rounding never adds up. `processRefund.ts` (original `:113-120`) counts only the gross fee credits and ignores the discount rebate.
**Fix.** Read the fee actually kept (MDR credits minus rebates). Each refund reverses `round(fee kept × refunded so far ÷ captured) − already reversed`, so the last refund brings the fee to exactly zero. Rounding stays half-to-even, as ADR-0001 requires (commit `43a832c`).
**Verified by.** `apps/api/src/refunds/refundFeeReversal.test.ts` (4 tests): 22, 25 and 200 are reversed exactly, and the platform fee ends at 0. Before the fix: 21, 26 and 250.
**Effect on existing data.** None in production, because refunds were not exposed. Any test-database refunds keep their old fee reversals, which are not recomputed.

### 30. Settlement pays merchants for money already refunded — Critical
**Symptom.** A refunded sale is still paid out to the merchant in full. The refund goes back to the card and the merchant is paid for the sale anyway.
**How found / reproduced.** Code read for FP-300. Migration 0042 says "a later settlement pass claims" refunds, but no such pass exists. Reproduced: 10,000 captured and 4,000 refunded on the same day still paid the full 9,750.
**Root cause.** `apps/settlement/internal/settlement/batch.go:154-220`: `CloseBatch` adds up only capture events (net = captures − fees). Nothing ever sets `refunds.settlement_batch_id`.
**Fix.** `CloseBatch` claims the merchant's unbatched refunds up to the end of the day, oldest first, and takes each one's net (refund − fee given back) off the payout. A refund is marked with its batch so it is deducted once. One that doesn't fit rolls into the next day, so a payout is never negative. MDR recalculation keeps the deduction (commit `c85f1f4`).
**Verified by.** `internal/settlement/batch_refunds_test.go` (4 tests: same day nets to 5,850, next day, roll-over, MDR). All 4 failed before the fix.
**Effect on existing data.** None in production, because refunds were not exposed. Before deploying, run `SELECT count(*) FROM refunds WHERE settlement_batch_id IS NULL`. The claim has no lower date limit, so every unbatched refund will come out of the merchant's next payout, however old it is.

### 31. The reconciliation report can't explain any period with refunds — High
**Symptom.** Any period with a refund that hasn't been settled yet shows an unexplained gap. The report is supposed to show gap = 0.
**How found / reproduced.** The function's doc comment says refunds are included "in pending, so a period with refunds still explains to zero", and the code doesn't do that. Reproduced: a sale of 10,000 with an unsettled refund of 4,000 showed pending 9,750 against a ledger of 5,850.
**Root cause.** `apps/api/src/settlement/query.ts:249-253, 303-311`: "pending" counts unsettled captures only, never unsettled refunds.
**Fix.** Pending also subtracts succeeded refunds that haven't been settled yet, each net of its fee reversal, the same way settlement does in 30 (commit `3670d51`).
**Verified by.** `apps/api/src/settlement/reconciliationRefunds.test.ts` (2 tests: gap 0, including a period that holds only a refund).
**Effect on existing data.** None. The report is worked out fresh each time it is opened and stores nothing.

### 32. Merchants are never told about refunds — High
**Symptom.** Merchants get webhooks for captures, voids and payouts, but never for refunds.
**How found / reproduced.** FP-300's "done when" list ("shop gets the right webhook"). A comment claims the dispatcher handles it, and it doesn't. Reproduced: a real refund produced no delivery.
**Root cause.** `apps/api/src/webhooks/dispatcher.ts:28` fans out only three event types, and `envelope.ts:81-82` throws on any other type. Just adding the type to the list would have thrown inside the shared dispatch transaction and blocked every merchant's webhooks.
**Fix.** `buildEnvelope` maps `refund.succeeded` to a documented public shape, and the type is added to the dispatcher list and the type union (commit `a9f880e`).
**Verified by.** `apps/api/src/webhooks/refundWebhook.test.ts`: exactly one `refund.succeeded` is sent, with 4,000 refunded and 100 fee back, and capture webhooks still flow.
**Effect on existing data.** No rows change. One thing to know at deploy: the dispatcher picks up every outbox event it hasn't delivered yet that is newer than the endpoint. So any `refund.succeeded` events already in the outbox (none in production, since refunds were not live) will be sent once, straight away.

### 33. The refund summary report is always empty — Medium
**Symptom.** The per-merchant daily refund summary never shows any refunds.
**How found / reproduced.** Code read of the migration. Reproduced: two refunds plus a real `settlement.batch_closed` event still gave 0 rows.
**Root cause.** `db/migrations/0072_refund_merchant_summary.sql:14` joins `transactions t ON t.id = r.id`, comparing a refund id with a transaction id. The materialised view is also never refreshed, and it counts a sale's amount once per refund.
**Fix.** Migration `0077` rebuilds the view, joined on `r.transaction_id` and counting each sale once. The reporting worker refreshes it on `settlement.batch_closed` (commit `8c6cd65`).
**Verified by.** `apps/reporting/src/consumer/refundSummaryRefresh.test.ts`: 2 refunds, 6,000 refunded, 150 fee back, 10,000 captured counted once.
**Effect on existing data.** None. The view is rebuilt from the refund rows on every refresh, so its history fixes itself.

### 34. Opening a refunded transaction crashes the merchant dashboard — High
**Symptom.** The transaction page crashes once the transaction has a refund. So does the reconciliation page when the gap is negative.
**How found / reproduced.** A code comment where FH flagged it and MK replied "amounts are never negative… ignore". Refund entries on the timeline are negative by design (0044). Reproduced: formatting −4,000 threw.
**Root cause.** `apps/web/src/format.ts:12`: `bhd()` calls `toFils(amountFils)` without `allowNegative`, and that throws on negative numbers.
**Fix.** `toFils(amount, { allowNegative: true })`. The existing money formatter already prints the minus sign (commit `27e22cf`).
**Verified by.** `apps/web/src/format.negative.test.ts`: −4,000 renders as `-4.000 BHD`, and fractional fils are still rejected.
**Effect on existing data.** None. This was a display problem only.

### 35. FP-300: refunds, built end to end — Feature
**Symptom.** The brief's missing feature. `POST /v1/refunds` returned 501, and the docs called the engine "done, tested", needing only "half a day".
**How found / reproduced.** The brief and ONBOARDING. The refund engine underneath had the ten bugs above (25–34), so it wasn't safe to expose as it was. A commented-out draft handler let the request body choose the merchant, and it made up a new idempotency key on every request.
**Root cause.** Not applicable. This entry is the feature that the bug fixes 25–34 made safe to turn on.
**Fix.** One handler for `POST /v1/merchants/:merchantId/refunds` and `POST /v1/refunds`. The merchant comes only from login, owner/finance/API keys may refund, an `Idempotency-Key` is required, and the request body is checked strictly. The response includes `refundedFils`. The dashboard's refund drawer is restored and fixed (commit `e96547e`).
**Verified by.** `apps/api/src/routes/refundsRoute.test.ts` (6 tests) and `apps/web/src/pages/transactions/refundForm.test.ts` (4 tests). On the running stack: 12.500 BD captured, then refunded in two parts. The platform fee for it ended at exactly 0 and two `refund.succeeded` webhooks were sent.
**Effect on existing data.** None. It is a new capability. See 30 and 32 for what happens at deploy.

### 36. Merchants can't verify webhook signatures — High
**Symptom.** A merchant who checks the HMAC signature the standard way, over the raw body, finds it never matches. Beta's delivery log shows 59 of 220 deliveries rejected as "invalid signature" on every retry. This is FP-240.
**How found / reproduced.** Ticket FP-240, and HANDOVER ("sign exactly the bytes it sends"). YA's `ya/sign-raw` commit (`fe24d26`) turned out to be empty. Reproduced with a stub receiver that recomputes the signature exactly as a merchant would.
**Root cause.** `apps/api/src/webhooks/sign.ts:36` signs `canonicalJson(payload)` (keys sorted), but `dispatcher.ts:161` sends `JSON.stringify(row.payload)` in the order Postgres `jsonb` stores the keys. The existing tests re-parsed the body before verifying, which hid the mismatch.
**Fix.** Send exactly the canonical string that was signed, both in the dispatcher and in test-send (commit `1e35fa0`).
**Verified by.** `apps/api/src/webhooks/signRawBody.test.ts`. All signing, test-send and dispatcher tests pass, except one backoff test already known to be flaky.
**Effect on existing data.** No rows in our database are wrong. Merchants may have rejected genuine captures and payouts, as Beta did. Those deliveries can be replayed now, and after 37 a replay keeps its original id. Merchants who switched verification off should be asked to turn it back on. No replays have been sent yet.

### 37. Replayed webhooks look like new events — High
**Symptom.** Every replay goes out with a new `Webhook-Delivery-Id`, so a merchant's system can't tell it's the same event and processes it again. In Beta's September export, one payout's `settlement.paid` arrived with 5 different ids.
**How found / reproduced.** ARCHITECTURE, CHANGELOG 1.9.1 and migration 0022 all tell receivers to de-duplicate on this id. Evidence: `docs/exports/webhook-deliveries-beta-2026-09.csv`. Reproduced with one delivery and two replays: three different ids.
**Root cause.** `apps/api/src/webhooks/replay.ts:48` gives every replay a new id (`randomUUID()`) and overwrites the envelope's `id` with it.
**Fix.** A replay reuses the original delivery id. Each attempt is still signed with a fresh timestamp (commit `66264df`).
**Verified by.** `apps/api/src/webhooks/replayStableId.test.ts`: all three sends carry the same id. One old test that expected a *different* id was corrected.
**Effect on existing data.** Not ours to correct. The duplicates are in the merchants' own systems: Beta may have booked one payout up to 5 times, and two others 3 times each. Merchants should be told which replays were repeats. Our own delivery history doesn't change.

### 38. Anyone can pay an expired payment link by lying about the time — High
**Symptom.** A buyer can pay a link after it has expired by sending an old `submittedAt` time, for example `"2000-01-01"`. This is FP-187.
**How found / reproduced.** Ticket FP-187 ("server trusts something the checkout page sends"). The route's own contract says `submittedAt` is ignored unless the request carries an API key. Reproduced: a link that had expired 10 minutes earlier was paid by a public buyer claiming the year 2000.
**Root cause.** `apps/api/src/paymentLinks/pay.ts:37-39` (`expiryReferenceTime`) takes the `submittedAt` from the request body as "now". The public route passed it through unconditionally.
**Fix.** The client's time is used only when the request carries a valid API key belonging to the link's own merchant, the offline-terminal case ARCHITECTURE allows. Everyone else is judged by the server clock (commit `88c9e42`).
**Verified by.** `apps/api/src/paymentLinks/linkExpiryClock.test.ts`: public buyers and other merchants' keys get 410, and the owner's terminal key gets 200. All 32 payment-link tests pass.
**Effect on existing data.** Links paid after they expired stay paid. Find them with `SELECT id, merchant_id, expires_at, paid_at FROM payment_links WHERE status='paid' AND paid_at > expires_at`. Not run. Each one is the merchant's call: honour the sale or refund it.

### 39. "Rebuild cached balances" in the console sets every balance wrong — High
**Symptom.** Support's console button overwrites every merchant's cached balance with a wrong figure. Alpha Retail went from 135K to 7K. This is FP-203.
**How found / reproduced.** The finance memo, which says the CLI rebuild gives the right number. Evidence: `docs/exports/merchant-balances-rebuild-2026-09-15.csv` and the FP-203 audit row (`"source":"scheme_export_lines"`). ADR-0004 says the two paths agree, and they can't. Reproduced: a merchant the CLI shows at 700 was set to 12,000 by the console.
**Root cause.** `apps/settlement/internal/ledger/refresh.go:26,62` reads `merchant_payable_position`, which is the gross total of every scheme line ever exported. It leaves out fees, refunds, payouts and credits.
**Fix.** The console computes the ledger's `merchant_payable` net in one grouped query and one bulk write, the same figure as the CLI and still fast. The new ADR-0007 (Proposed) supersedes ADR-0004 (commit `c036eb2`).
**Verified by.** `internal/ledger/console_rebuild_test.go`: the console and the CLI both give 700. The existing refresh tests keep their expected figures.
**Effect on existing data.** Only the cached display figure is wrong. Payouts read the batches, not this cache. After deploy, run the fixed rebuild once, from the console or with `settlement rebuild-balances`, and every cached balance is correct again. We haven't run it on production.

### 40. Running settlement for "today" silently drops the rest of the day's sales — High
**Symptom.** If an operator closes the batch for a day that hasn't ended, every capture later that day is never batched and never paid out.
**How found / reproduced.** Code read: `CloseBatch` takes any date. ADMIN.md says a re-run "is always safe", which encourages exactly this. Reproduced: closing today returned 200, and a later capture stayed unbatched with no way to batch it.
**Root cause.** `apps/settlement/internal/settlement/batch.go:61` (`CloseBatch`) and `:424` (`RunDailyBatch`) don't check that the business day has ended. Re-running a closed day does nothing, so the late captures are stranded.
**Fix.** Both refuse a date whose Bahrain-time window hasn't ended (`ErrBusinessDayNotEnded`). The internal API answers 409 `business_day_not_ended` (commit `95995c4`).
**Verified by.** `internal/settlement/unfinished_day_test.go` and `internal/internalapi/unfinished_day_test.go`: today is refused with no batch created, and yesterday still runs.
**Effect on existing data.** Captures already stranded this way are still unbatched, and the fix doesn't pick them up. Find them as capture-type `transaction_events` with `settlement_batch_id IS NULL` whose merchant already has a batch for that business day. Not run. They need a manual catch-up batch or a payout, after finance review.
