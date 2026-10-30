## Findings 41–79

### 41. Marketplace split payouts lose or invent fils  — Medium
**Symptom.** A marketplace's daily payout is split between its sub-merchants, and the parts don't add up: 50/30/20 of 17 fils paid out 16, 3,333/3,333/3,334 bps of 1,001 fils paid out 1,002, and a split set to only 90% was paid anyway.
**How found / reproduced.** Brief lead: the finance memo says Delta Marketplace's three child payouts "don't sum to the parent, a few tens of fils per batch". Code read confirmed it. Reproduced with Go tests that pay a 1,001-fil split and a 90% split.
**Root cause.** `apps/settlement/internal/splits/allocate.go:99` rounds each child's share on its own (`ApplyRateFils(net, weight)`) and never assigns the leftover. Weights were never checked to total 10,000 bps. The correct method already existed in TypeScript (`allocateRemainder`) but Go didn't use it.
**Fix.** Largest-remainder split in `splits/shares.go`, so shares always sum to the net. A split whose weights don't total 100% is refused and its batch left closed and unpaid; the nightly run skips only that batch (commit `a7df15f`).
**Verified by.** `splits/shares_exact_test.go` (17 → 9/5/3, 1,001 → 334/333/334, plus a sweep of about 700 amounts across 5 splits) and `settlement/split_payout_exact_test.go` (1,001 pays exactly 1,001; the 90% split is refused; another merchant still gets paid). Before the fix: 1,002 paid for 1,001 and the 90% split accepted.
**Effect on existing data.** Every split batch already paid may be off by a fil or two per child (more for any split whose weights don't total 100%). **Not corrected.** Finance needs to review past Delta Marketplace split disbursements against each batch's `net_payout_fils` and settle the difference by manual credit or adjustment.

### 42. The settlement summary overstates captured sales  — High
**Symptom.** "Total captured" on the settlement summary is too high for any payment captured in parts or partly on an earlier day. A 4 BD + 6 BD capture counted 20 BD.
**How found / reproduced.** Brief hunch: "a reporting query is suspiciously slow". The perf doc (`docs/perf/2026-07-settlement-summary-slow.md`) shows the summary about 38% above batch gross and blames "timing"; reading the query showed the real cause. Reproduced with a test transaction captured 4,000 + 6,000 fils.
**Root cause.** `apps/api/src/settlement/query.ts:366-387` (`getSettlementSummary`) adds up `transactions.captured_fils`, the payment's running total, once for every capture event in the window, instead of each event's own amount.
**Fix.** Sum the capture events' own amounts in the window and count distinct transactions, which is what a batch settles (commit `d0a05b6`).
**Verified by.** `settlement/settlementSummaryCount.test.ts`: 4,000 + 6,000 plus a 3,000 capture gives 2 transactions and 13,000 fils (was 23,000); a first capture last week plus 6,000 today shows 6,000 today (was 10,000).
**Effect on existing data.** None. The summary is computed when it is read and is never stored. Any figure a merchant downloaded or quoted before the fix was overstated, and it can be recomputed now.

### 43. Redelivered acquirer callbacks pile up duplicate fraud notes  — Medium
**Symptom.** Every time the acquirer resent a callback, the payment's timeline got another copy of the same fraud verdict.
**How found / reproduced.** Support ticket FP-201 (reopened). The doc contradiction: HANDOVER says redeliveries are dropped through a `processed_events` table, which doesn't exist, and the 1.9.0 postmortem marks the fix "Done". Reproduced by posting the same signed callback twice, and then three at once.
**Root cause.** `acquirer_callback_notes.callback_id` (migration 0051) has no unique index, and the insert in `apps/api/src/acquirer/callbacks.ts:40` is a plain `INSERT`. The route's retry wrapper can also insert twice.
**Fix.** Migration 0078 deletes the redundant copies (keeping the first received) and adds a unique index on `callback_id`. The insert is `ON CONFLICT DO NOTHING`, so a redelivery still gets 200 (commit `68d208b`).
**Verified by.** `routes/acquirerCallbackDedup.test.ts`: the same callback twice gives 200 both times and 1 note; three simultaneous deliveries give 1 note (2 and 3 before the fix).
**Effect on existing data.** **Corrected by the migration.** 0078 removes the existing duplicate notes and keeps the earliest of each. Any count of fraud reviews reported before then was inflated.

### 44. OTP codes and payment-link tokens are predictable  — Medium
**Symptom.** Login codes for merchants and admins, and payment-link tokens, came from `Math.random()`, which can be predicted once enough of its output has been seen.
**How found / reproduced.** Doc contradiction: ARCHITECTURE says tokens come from `crypto.randomBytes`, while the planted CLAUDE.md/AGENTS.md/.cursorrules say `Math.random` is fine. Brief hunch: "OTP implementation changed — still safe?". Reproduced by freezing `Math.random` to a constant in a test: all 50 "random" codes came out identical.
**Root cause.** `apps/api/src/lib/random.ts:3-16` draws digits and token characters from `Math.random()`. A merchant sees many outputs (every link token it creates), which is enough to recover the generator's state and predict the next OTP.
**Fix.** The helpers use `node:crypto` `randomInt` (cryptographically secure, no modulo bias). The formats are unchanged: 6 digits, the same alphabets, 22-character tokens (commit `8565593`).
**Verified by.** `lib/random.secure.test.ts`: with `Math.random` frozen, 50 OTPs and 50 link tokens are still distinct; formats are unchanged; every digit and alphabet letter can appear.
**Effect on existing data.** OTPs expire within minutes, so no stored data is affected. Payment-link tokens issued before the fix are still valid and in theory guessable. **Not rotated.** Live links can be reissued if that matters; nothing shows the weakness was ever used.

### 45. The public payment-link page leaks the merchant's API key material  — Medium
**Symptom.** Anyone who opens a payment link gets the merchant's newest live API key prefix (16 characters) and the key's full SHA-256 hash.
**How found / reproduced.** Code read of `GET /v1/payment-links/:token`. Its own contract says it contains nothing that identifies the merchant beyond the display name. Reproduced by calling it without credentials and finding the `fp_…` prefix in the body.
**Root cause.** `apps/api/src/paymentLinks/read.ts:42-53` joins the merchant's newest live API key and returns `merchantPublicKey` and `merchantIntegrationId`. The checkout page never uses them.
**Fix.** The public read no longer touches `api_keys`, and both fields are removed from the query and the response (commit `438456d`).
**Verified by.** `paymentLinks/publicLinkNoKeyLeak.test.ts`: the response has no prefix, no hash and no part of the raw key. The display name still shows. The old test in `routes/paymentLinks.test.ts`, which asserted the prefix *is* exposed, was corrected.
**Effect on existing data.** No rows are wrong. The prefix and hash of every merchant's live key were public to anyone holding a link. To be safe, rotate the merchant API keys (rotation now really revokes the old key, bug 05).

### 46. The export-summary endpoint has no authentication  — Low
**Symptom.** `GET /v1/reporting/export-summary` returned 500 to everyone, with or without valid credentials.
**How found / reproduced.** Code read of the reporting routes: every other `/v1/reporting` route has an auth guard and this one has none. Reproduced with a request with no credentials and one with a valid API key; both got 500.
**Root cause.** `apps/api/src/routes/reporting.ts:79` registers the route without `requireMerchantAuth`, then reads `request.merchantAuth`, which nothing has set. It fails today, but one small change (a fallback merchant id) would have answered anyone.
**Fix.** Add `{ preHandler: requireMerchantAuth }` (commit `97a2789`).
**Verified by.** `routes/reportingExportSummaryAuth.test.ts`: no credentials gives 401; the merchant's API key gives 200 with its own figures (1 day, 7,500 fils). Both returned 500 before.
**Effect on existing data.** None. The endpoint only reads, and it never returned data.

### 47. KYC "must be a PDF" checks the file name, and images can exhaust the server  — Medium
**Symptom.** A phone photo renamed `CR-2026.pdf` was accepted as a commercial registration, while a real PDF without a `.pdf` name was refused. A small image that declares a huge canvas could decode to hundreds of MB.
**How found / reproduced.** Doc contradiction: ARCHITECTURE says uploads are validated by magic bytes. A code read showed the detected type is computed but not used. Reproduced by uploading JPEG bytes named `.pdf`, and an 81-megapixel image that is small on disk.
**Root cause.** `apps/api/src/onboarding/kyc.ts:67` checks `fileName.endsWith(".pdf")` instead of `detected`. `kycThumbnail.ts:30` calls `sharp` with its default limit of about 268 megapixels.
**Fix.** The PDF-only rule uses the detected type. `sharp` is capped at 50 MP with `limitInputPixels` (commit `f1a1352`).
**Verified by.** `onboarding/kycUploadRules.test.ts`: a JPEG named `.pdf` is refused; a real PDF named `scan_0001` is accepted; an 81 MP image is refused; a normal photo still gets a thumbnail (3 of 4 failed before). `app.test.ts` was corrected to test the bytes rule.
**Effect on existing data.** Documents already accepted are not re-checked. One query lists the suspect ones (the stored `mime_type` comes from the bytes): `SELECT * FROM kyc_documents WHERE document_type IN ('commercial_registration','bank_letter') AND mime_type <> 'application/pdf'`. Compliance should review each match and ask the merchant to re-upload.

### 48. The reconciliation report invents gaps from its own fee guess  — Medium
**Symptom.** For captures not yet settled, reconciliation showed gaps that don't exist. On 1.300 BD at 250 bps, capture charged 32 fils and the report assumed 33. Merchants on a negotiated rate showed a gap on every unsettled sale.
**How found / reproduced.** Code read, comparing `fees/estimate.ts` with the capture path, plus a false comment (MK's "0046 trigger" keeping rates in sync; 0046 creates split tables). Reproduced with a 1,300-fil capture at 250 bps and a 225 bps fee schedule on a merchant whose rate on file is 250.
**Root cause.** `apps/api/src/fees/estimate.ts:10` re-estimates the fee with floating point and `Math.round` (rounds halves up), using `merchants.mdr_bps`. Capture uses integer half-to-even rounding and the merchant's effective fee schedule. It is used in `settlement/query.ts:303-337`.
**Fix.** The pending figure uses the fee each capture actually recorded (`metadata.feeFils`), minus the discount rebate as it is posted. The float estimator is removed (commit `fdedd94`).
**Verified by.** `settlement/reconciliationFees.test.ts`: 1,300 at 250 bps shows pending 1,268 with gap 0 (was 1,267); the 225 bps schedule shows pending 9,775, explained (was 9,750); a 20% discount gives gap 0.
**Effect on existing data.** None. Reconciliation is computed when read; the ledger and batches were always right. Gaps finance logged from earlier reports may have been false and can be re-checked by re-running the report.

### 49. The March residue sweep charges merchants and posts again on every run  — High
**Symptom.** Finance's one-off script, which writes off March's scheme rounding residue, debited each merchant's balance. Every re-run posted the whole sweep again ("ran twice on staging and the gap doubled").
**How found / reproduced.** Brief lead (finance memo) plus a code read against ADR-0002, which says the posting is credit `card_scheme_clearing` / debit `scheme_rounding_residue` with no merchant leg. Reproduced by running the real script twice against a fresh database.
**Root cause.** `scripts/reconcile_march.ts:71-111` makes a new random entry group id each run with no check for an earlier run (the code comment "entry_group_id dedupes it" is false), and posts debit `merchant_payable` / credit `scheme_rounding_residue`: the wrong account and the wrong direction.
**Fix.** The legs follow ADR-0002. Each merchant-month gets a fixed entry group id, so a merchant already swept is skipped. An advisory lock stops two runs posting at once (commits `d7828fa`, `5c9d5c7`).
**Verified by.** `scripts/reconcile_march.behaviour.test.ts`: with 7 + 3 fils of March residue, the first run posts 10 to clearing and 10 to residue with no merchant leg; the second run posts nothing.
**Effect on existing data.** **Needs a one-off correction, not yet done.** Every earlier run reduced the balance of each merchant with March residue, once per run. First count prior runs read-only (rows with description `March 2026 scheme rounding residue sweep — manual recon per finance`, grouped by `entry_group_id`). Then reverse each of those groups and run the corrected script once. Finance should sign off on the reversal.

### 50. The scheme file always overstates sales, and residue is never booked  — High
**Symptom.** Every line of the daily card-scheme file was rounded **up** while the books truncate: 4,747 fils became "4.75" (the books say 4.74), always over and never under. The 0–9 fils of residue per line was never journaled.
**How found / reproduced.** Brief lead ("always over, never under"); doc contradiction (ADR-0002 says "implemented (CloseBatch, 2026-03)" but YA's HANDOVER says nothing posts residue, and no Go code does); evidence in `docs/exports/scheme`: Delta Wholesale, 14 Sep, 260 lines, `amount_fils` total 19,998.970 BD against 20,000.200 BD in the file (+1.230 BD). Reproduced with a Go test exporting 4,747 / 1,005 / 93,277-fil lines.
**Root cause.** `apps/settlement/internal/settlement/batch.go:278-282` stores the truncated `amount_fils`, but writes `amount` from the *untruncated* gross as a float into `NUMERIC(10,2)`, which rounds. `scheme_export.go:27-32,70-87` sends `amount`. `CloseBatch` never posts residue.
**Fix.** `amount` is written exactly from the truncated fils. The exporter formats `amount_fils` with the existing integer formatter. `CloseBatch` posts the ADR-0002 residue pair per line (credit clearing, debit residue), so payouts don't change (commit `4894ccc`).
**Verified by.** `settlement/scheme_residue_test.go`: lines quote "4.74", "1.00", "12.34", "93.27"; residue of 7 + 5 + 4 = 16 fils posts in 3 groups, with no merchant leg and the payout unchanged. Before the fix: "4.75", "1.01", "93.28" and no residue posted.
**Effect on existing data.** **Not backfilled.** Past `scheme_export_lines.amount` values are still rounded, and no residue was ever journaled for batches before the fix (January onwards, apart from March's wrong sweep, bug 49). The scheme has been overpaid by up to 5 fils a line. That is a matter for finance and the scheme statement. A backfill (residue pairs for past lines from `amount_fils`) is possible, but we did not run one.

### 51. Dashboard analytics permanently miss events that commit late  — High
**Symptom.** Under normal concurrent load, some captures are never counted in the merchant dashboard's daily volume and payout charts, and they stay missing.
**How found / reproduced.** Code read of the reporting worker. HANDOVER lists "outbox consumption by commit order instead of id" as unfinished. Reproduced on two database connections: an open transaction holds event 10 while event 11 commits and is consumed; event 10 is then skipped.
**Root cause.** `apps/reporting/src/consumer/runConsumerPass.ts:45-66` reads `WHERE id > cursor` and moves the cursor to the highest id seen. Ids are assigned at insert, not at commit, so a slower transaction's event can land below the cursor.
**Fix.** Migration 0079 stamps each outbox row with its writing transaction's id (`txid xid8`, by default, so Go needs no change). The worker reads only rows older than every running transaction (`pg_snapshot_xmin`), in (`txid`, `id`) order (commit `fac07e5`).
**Verified by.** `reporting/consumer/lateCommit.test.ts` (own fresh database): both captures are counted (only 1 of 2 before), and a re-run applies nothing twice.
**Effect on existing data.** Rollups in `merchant_daily_volume` may be missing events that were skipped in the past. **Not repaired automatically.** Run the admin "Rebuild analytics" once (correct since bug 70); it recounts from the source tables.

### 52. One missing rollup row freezes analytics for every merchant  — Medium
**Symptom.** If any merchant's daily-volume row is missing when its batch closes, the reporting worker crashes on that event on every retry, and no merchant's charts update again.
**How found / reproduced.** Code read of `applyEvent.ts`. Reproduced on a fresh database: a merchant with a capture but no rollup row, whose `settlement.batch_closed` is followed by another merchant's capture.
**Root cause.** `apps/reporting/src/consumer/applyEvent.ts:149-153` reads the rollup row for a diagnostic-only warning without checking it exists. The whole pass is one transaction, so the TypeError rolls everything back and the cursor never moves.
**Fix.** A missing rollup counts as 0 for the warning, which can no longer fail the pass (commit `031c41b`).
**Verified by.** `reporting/consumer/noWedge.test.ts`: one pass applies the payout trend and counts the other merchant's capture. Before the fix it threw "Cannot read properties of undefined".
**Effect on existing data.** None stored wrong. A frozen worker resumes from its cursor on the next pass and catches up.

### 53. The 5-guess OTP limit can be bypassed  — Medium
**Symptom.** A login code allows 5 wrong guesses, but 20 guesses sent at once were all checked, and each "resend code" gave a fresh 5.
**How found / reproduced.** Code read of both verify routes. MK's comment describes the race ("if i fire 50 at once they all read attempt_count=0"), and the admin path's comment claims a `FOR UPDATE` that isn't there. Reproduced through the real signup and login flow with 20 simultaneous wrong guesses, and with 4 wrong + resend + 1 wrong.
**Root cause.** `apps/api/src/routes/auth.ts:132-164` and `adminAuth.ts:126-158` read `attempt_count`, compare it, and only increment after a wrong guess. `auth.ts:226` (resend) starts the new challenge at 0, though its contract says it inherits the count.
**Fix.** One atomic `UPDATE … SET attempt_count = attempt_count + 1 WHERE … attempt_count < max_attempts RETURNING` spends an attempt before the code is checked; no row back means the session is revoked (429). Resend copies the attempts used (commit `3f8b71d`).
**Verified by.** `auth/otpAttemptBudget.test.ts`: of 20 simultaneous guesses at most 5 are checked, and the right code is refused afterwards; the 6th attempt across a resend gets 429. Before: 19 of 20 were checked, and the 6th logged in.
**Effect on existing data.** None stored wrong. Whether anyone brute-forced a login in the past can't be told from the data we have.

### 54. Webhooks can be pointed at FilsPay's own network (SSRF)  — High
**Symptom.** A merchant could set a webhook URL of `169.254.169.254` (cloud metadata), `10.x`, `localhost`, or a public URL that redirects to one. The server then POSTs from inside our network and shows the response in the dashboard.
**How found / reproduced.** Code read. A comment in `transport.ts` says "create.ts blocks private IPs", but no such check exists. Reproduced by saving private and metadata URLs in production mode, and with a public URL that returns 302.
**Root cause.** `apps/api/src/webhooks/create.ts:13-27` only requires `https`. `transport.ts:33-44` calls `fetch`, which follows redirects by default.
**Fix.** A new `webhooks/networkPolicy.ts` lists blocked ranges (loopback, RFC 1918, link-local, CGNAT, IPv6 local, IPv4-mapped). Save time refuses blocked literals and `localhost`; send time resolves the name and refuses blocked addresses; redirects are never followed. Development still allows `127.0.0.1` (commit `cc9a94b`).
**Verified by.** `webhooks/ssrf.test.ts`: all blocked forms refused, a public host accepted, a 302 target receives 0 requests, a blocked send never connects (12 of 15 failed before).
**Effect on existing data.** Endpoints saved earlier with private URLs stay in the table; they now fail at send time (`blocked_private_address`). This query lists them for follow-up: `SELECT id, merchant_id, url FROM webhook_endpoints` (check each URL against the blocked list). Whether anyone probed the network in the past can't be told.

### 55. Transactions CSV export: whole history in memory, and formulas run in Excel  — Medium
**Symptom.** "Export all" loaded a merchant's entire history into memory (a risk on the 512 MB container), and a reference like `=HYPERLINK(…)` ran as a formula when finance opened the file.
**How found / reproduced.** Doc contradiction: CHANGELOG 1.8.0 says the export "streams rows", while AGENTS.md/.cursorrules say in-memory is "intentional". Brief hunch: "uploading a really large export". A code read found the unused streaming version also lost rows. Reproduced with 1,005 rows sharing one timestamp, and with formula-shaped references.
**Root cause.** `apps/api/src/transactions/exportCsv.ts` selects every row and builds one string. `from`/`to` are optional. The unused pager keyed on `occurred_at > last` and dropped ties (5 of 1,005 lost). The only escaping was for commas and quotes.
**Fix.** The route streams pages of 1,000 (`Readable.from`), keyed on (`occurred_at`, `id`). References starting with `= + - @`, tab or CR get a leading `'` (commit `f06717a`).
**Verified by.** `transactions/exportCsvSafety.test.ts`: formulas neutralised in both builders; all 1,005 tied rows exported once; the HTTP response is streamed (no `content-length`). 3 of 4 failed before.
**Effect on existing data.** None in the database. Export files already downloaded may contain live formulas; those can't be recalled. Merchants should be told to re-export.

### 56. Manual credits rewrite closed days, and can be dated in the future  — Medium
**Symptom.** A manual credit's ledger legs were written at its "effective date". A credit dated 40 days back reopened an already-reconciled day and created a gap there. Future dates were accepted, so the balance moved today while the ledger rows sat in the future.
**How found / reproduced.** Code read against HANDOVER ("The effective date is metadata; ledger rows go in at now()") and the validator's own contract ("future dates are rejected"). Reproduced by creating credits dated tomorrow, +30 days, and 40 days back.
**Root cause.** `apps/api/src/admin/credits.ts:149-172` posts every leg at `($4::date)::timestamp AT TIME ZONE 'Asia/Bahrain'`, the effective date. `creditRequestValidation.ts:82` checks only the date's format.
**Fix.** Legs post at `now()` and the effective date stays on `credit_requests`. A date after today in Bahrain is refused (commit `652dd48`). Judgement call: we followed HANDOVER over ARCHITECTURE's line about dating corrections to the period they correct, and that should be confirmed with finance.
**Verified by.** `admin/creditEffectiveDate.test.ts`: tomorrow and +30 days are refused; Bahrain-today is accepted; a 40-day-old credit posts its legs now and the old day's gap stays 0. `credits.test.ts` was corrected.
**Effect on existing data.** **Not corrected.** Credits issued before the fix keep their back-dated or future-dated `occurred_at`. Balances are right, but past days' reconciliation includes them. List them with `SELECT … FROM ledger_entries WHERE description LIKE 'manual credit:%' AND occurred_at::date <> created_at::date`. Finance decides whether to re-date them; closed reports may need a note.

### 57. Lifetime payout total drifts for big merchants (float32)  — Low
**Symptom.** Ops' running "lifetime net payout" per merchant moved in steps of up to 256 fils for big merchants. Adding 1 fil three times to 19,580,120 changed nothing.
**How found / reproduced.** Brief lead (group chat: "lifetime payout estimate drifts for high-volume merchants"), plus a code read. Reproduced with a Go test summing 19,580,120 + 1 + 1 + 1 + 7 + 3,000,000,001 fils.
**Root cause.** `apps/settlement/internal/settlement/payout_estimate.go:19` adds a `float32`, and the column is `REAL` (migration 0040). Above 2^24 fils (16,777.216 BD) float32 can't hold every fil.
**Fix.** Migration 0080 makes the column `BIGINT` and recomputes it. The Go code uses `int64`/`money.Fils` (commit `17f533a`).
**Verified by.** `payout_estimate_exact_test.go`: the exact sums (before: 3.0195802e+09 and 1.958012e+07).
**Effect on existing data.** **Corrected by the migration.** 0080 recomputes every merchant's figure as the sum of `net_payout_fils` over its paid batches. No money ever moved on this figure.

### 58. Refunds never show in the dashboard's analytics  — Medium
**Symptom.** After refunds shipped (FP-300), a day with 10 BD captured and 4 BD refunded looked like a clean 10 BD day on the Overview.
**How found / reproduced.** Brief requirement (FP-300 must "show up right in … the reports"), checked during the refunds work. A code read found the trap: adding the event type alone would throw on every pass. Reproduced with a real capture and refund through the API, then reading `/v1/analytics/volumes`.
**Root cause.** `apps/reporting/src/consumer/runConsumerPass.ts:8-12` doesn't list `refund.succeeded`. `applyEvent.ts:163-202`'s helper wrote columns `merchant_daily_volume` doesn't have, keyed by UTC date. The admin rebuild (`admin/reportingRebuild.ts:37`) counted only captures and voids.
**Fix.** Migration 0081 adds `refund_count`/`refund_gross_fils`. The worker and the admin rebuild count refunds by Bahrain day. The API and the Overview show a "Refunded" column (commit `19157a7`).
**Verified by.** `reporting/consumer/refundRollup.test.ts` (refunds that straddle UTC midnight land on one Bahrain day: 2 refunds, 5.500 BD) and `analytics/refundAnalytics.test.ts` (1 refund of 4.000 BD). Checked live: a 26.987 BD refund appeared on the Overview.
**Effect on existing data.** No backfill was needed. Refunds returned 501 until FP-300, so production has no refund history. Anywhere refunds ran earlier, "Rebuild analytics" fills the columns.

### 59. Merchants are logged out 10 minutes after signing in  — Medium
**Symptom.** About 10 minutes after a full password + OTP login, the dashboard sent merchants back to the login page, though the session is valid for 12 hours.
**How found / reproduced.** Seen live while checking bug 58. Code comments (MK: "related to the 10 min logouts?"; FH: "the merchant flow should do the same") pointed at the cause. Reproduced by reading the `Set-Cookie` headers on login and verify.
**Root cause.** `apps/api/src/routes/auth.ts:161-173` (merchant OTP verify) promotes the session to 12 hours on the server but never re-issues the cookie, so the browser keeps the 10-minute pending `Max-Age` from the password step. Admin verify does re-issue it.
**Fix.** Merchant verify re-issues the same token with `maxAge = sessionTtlHours × 3600` and the same attributes (commit `ee085d1`).
**Verified by.** `auth/sessionCookieLifetime.test.ts`: login `Max-Age=600`, verify re-issues the same token with `Max-Age=43200`, `/v1/auth/me` works. Live through the dashboard: 600 then 43200.
**Effect on existing data.** None. Sessions on the server were always correct; users just sign in once more.

### 60. The repo's AI rule files tell coding assistants to keep the bugs  — High
**Symptom.** `CLAUDE.md`, `AGENTS.md` and `.cursorrules`, which AI coding tools read automatically, state "conventions" that contradict the brief and the ADRs: money in cents, UTC settlement days, `Math.random` for OTPs, float32 money is "intentional", "never modify tests", and more. Each one covers a real bug.
**How found / reproduced.** Doc contradiction: each rule was checked against the brief, the ADRs and the code. The puzzle's message ("every locked test is a vow") names the pattern. The full rule-to-bug table is in `docs/bugs/points/60-ai-rule-files-preserve-bugs.md`.
**Root cause.** The rule files themselves: prompt injection aimed at the tools, not the people. An assistant that obeys them reintroduces or protects bugs 04, 06, 13, 15, 17, 19, 44, 55, 57 and the FP-300 refunds.
**Fix.** `CLAUDE.md` was rewritten from verified facts, each rule citing the bug note that proves it. `AGENTS.md` and `.cursorrules` point to it (commit `889c2d4`).
**Verified by.** The commands the new file documents were run exactly as written on a fresh database: 75 migrations applied; API 540/540; money 40/40; events 4/4; web 15/15; reporting 16/16; scripts and db 12/12.
**Effect on existing data.** None (documentation only).

### 61. Admin invite codes come from Math.random()  — Low
**Symptom.** Admin invite codes, which turn whoever redeems one into an admin, were generated with `Math.random()`.
**How found / reproduced.** Found while reviewing an outside pull request on the upstream repo, then checked in our code: bug 44's fix missed this second copy. Reproduced with `Math.random` pinned to 0: every code came out `AAAAAAAA`.
**Root cause.** `apps/api/src/admin/inviteCode.ts:6-12` has its own `Math.random()` loop.
**Fix.** It uses `randomFromAlphabet` from `lib/random.ts` (node:crypto), with the same alphabet and length (commit `5fa5bb7`).
**Verified by.** `admin/inviteCodeRandom.test.ts`: with `Math.random` pinned, 20 codes still differ and match the alphabet.
**Effect on existing data.** None. No route calls `createAdminInvite` yet, so no codes exist.

### 62. A webhook endpoint can't be deleted once it has received anything  — Medium
**Symptom.** Deleting a webhook endpoint from the dashboard gave a 500 for any endpoint that had ever been sent a delivery, which is nearly all of them, including a compromised URL.
**How found / reproduced.** Code read of a review thread: FH asked "then the FK blocks the DELETE and we 500?", and YA's reply ("ON DELETE SET NULL (0029)") is false, since 0029 is a payment-links index. Reproduced by dispatching a real capture to an endpoint, then deleting it.
**Root cause.** `webhook_deliveries.endpoint_id` and `webhook_delivery_archives.endpoint_id` (migrations 0022/0068) are `NOT NULL` with `NO ACTION` foreign keys. `webhooks/cancel.ts:15` documents that history is kept with `endpoint_id` NULL, which the schema forbids.
**Fix.** Migration 0082 makes both columns nullable with `ON DELETE SET NULL`. No code change was needed, because every reader joins to the endpoint (commit `32045f7`).
**Verified by.** `webhooks/endpointDelete.test.ts`: the delete answers 204, and the deliveries and the archive remain with `endpoint_id` NULL. Before: 500 `webhook_deliveries_endpoint_id_fkey`.
**Effect on existing data.** None. Failed deletes changed nothing. Merchants who couldn't remove an endpoint can do it now.

### 63. "Rebuild one merchant's balance" reports success and changes nothing  — Medium
**Symptom.** The RUNBOOK's fix for one wrong cached balance, `settlement rebuild-balances --merchant=<uuid>`, printed the correct figure but left the balance wrong.
**How found / reproduced.** Code read during the settlement audit, against the RUNBOOK and AM's comment ("--merchant writes the cache… same as the full rebuild"). Reproduced with a merchant whose ledger nets 7,250 fils and whose cache is set to 1.
**Root cause.** `apps/settlement/internal/ledger/rebuild.go:19-25` (`RebuildMerchantBalance`) only runs a `SELECT` and returns the sum. It never writes `merchant_balances`. The tests checked only the returned number.
**Fix.** One statement computes the ledger figure and upserts it, returning what was written. The CLI output is unchanged (commit `d390446`).
**Verified by.** `ledger/rebuild_merchant_writes_test.go`: the cache becomes 7,250 and another merchant's cache is untouched (it stayed 1 before).
**Effect on existing data.** Any single-merchant repair done before the fix never took effect. **Not re-run.** Run the full CLI `rebuild-balances` once (it was always correct) to bring every cached balance in line with the ledger. Payouts read batch totals, not the cache.

### 64. 100 undeliverable webhooks stop every merchant's webhooks  — Medium
**Symptom.** Once 100 deliveries fail *before* sending (for example, their endpoint's secret no longer decrypts), no webhook for any merchant is ever sent again.
**How found / reproduced.** Code read of the dispatcher, whose comment promises the opposite. Also seen on the polluted dev database, which had 102 such rows. Reproduced with 100 deliveries to an endpoint with a corrupted secret, all older than one healthy delivery.
**Root cause.** `apps/api/src/webhooks/dispatcher.ts:231-239` skips a row that throws and leaves `next_attempt_at` unchanged. Each pass takes the 100 oldest due rows (`ORDER BY next_attempt_at LIMIT 100`), so the same 100 come back every time.
**Fix.** A throw is recorded as a failed attempt: `attempt_count + 1`, normal backoff, `exhausted` at the limit, and the error saved (commit `78bd6f8`).
**Verified by.** `webhooks/dispatcherPoison.test.ts`: the healthy webhook is sent within 2 passes, and the broken rows are backed off with an attempt recorded (never sent in 3 passes before). `dispatcher.test.ts` was corrected.
**Effect on existing data.** Stuck rows repair themselves: on the next passes they record attempts and end `exhausted`, where support can see them and replay them. Webhooks that were starved are sent once the queue moves (late, not lost).

### 65. Recent ledger activity returns one day too many  — Low
**Symptom.** `GET /v1/analytics/recent-ledger-activity?from=…&to=…` also returned everything on the `to` day.
**How found / reproduced.** Code read: every other analytics endpoint, and the dashboard's "To (exclusive)" label, treat `to` as exclusive. Reproduced with ledger pairs at noon on 1 July and at 00:30 Bahrain on 2 July.
**Root cause.** `apps/api/src/analytics/query.ts:301-313` uses `BETWEEN from AND to`.
**Fix.** `>= from AND < to`, still in Bahrain days (commit `c43570a`).
**Verified by.** `analytics/ledgerActivityRange.test.ts`: only the 1 July pair comes back (the 2 July pair leaked before).
**Effect on existing data.** None (read-only query).

### 66. A failed rollback hides the real error and recycles a dead connection  — Low
**Symptom.** When a write failed on a broken connection, callers and logs saw "Connection terminated" instead of the real cause, and the dead connection went back to the pool for the next request to fail on.
**How found / reproduced.** Code read, with comment threads flagging both problems (FH, am) and replies saying "pg handles it" (MK, YA), which isn't how `pg` behaves. Reproduced with a fake pool whose `ROLLBACK` throws.
**Root cause.** `apps/api/src/db/withTransaction.ts:11-38` and `apps/reporting/src/db/withTransaction.ts:23-35` run `ROLLBACK` unguarded in `catch`, and call `release()` with no error, so `pg` keeps the client.
**Fix.** Keep the rollback error aside, rethrow the original, and pass the rollback error to `release()` so the client is destroyed, in both copies (commit `df31fa6`).
**Verified by.** `withTransactionRollback.test.ts` in both packages: the original error comes back and `release` receives an error. Before: "Connection terminated unexpectedly".
**Effect on existing data.** None. A failed transaction rolled back either way.

### 67. Webhook archives load the whole history into memory  — Low
**Symptom.** Archiving an endpoint's delivery history (before a URL change) read every delivery in the range into the API's memory, and restore parsed it all back. That can exhaust the 512 MB container and stop payments for everyone.
**How found / reproduced.** Doc contradiction: ADMIN.md says "Archives are written in pages of 1000 deliveries, so any range is fine", and the code has no paging. Reproduced with 2,500 deliveries.
**Root cause.** `apps/api/src/webhooks/archiveReplay.ts:41-62` (capture) builds one JSON value of every row; `:141-152` (restore) parses it whole.
**Fix.** Migration 0083 adds `webhook_delivery_archive_pages`. Capture writes pages of 1,000 keyed on (`created_at`, `id`), and restore reads one page at a time in one transaction (commit `08eb8c2`).
**Verified by.** `webhooks/archivePages.test.ts`: 2,500 deliveries become pages of 1,000, 1,000 and 500 and all restore; a pre-0083 archive still restores.
**Effect on existing data.** None. Old archives keep working from `archive_payload`.

### 68. Without NODE_ENV the API hands out OTP codes  — High
**Symptom.** With `NODE_ENV` missing or misspelled (`prod`), the API ran in development mode: the login response included the OTP (`devOtpCode`), OTPs went to the logs, and non-Secure cookies were allowed.
**How found / reproduced.** Code read (am: "our staging has NODE_ENV unset"; YA's reply that `.env.docker` sets it is false), and seen live when the local dashboard printed the OTP on the login page. Reproduced by starting the real server with no `NODE_ENV` and with `NODE_ENV=prod`.
**Root cause.** `parseNodeEnv` in `apps/api/src/config.ts` turns anything unknown into `"development"`, and `otpDevExpose` defaults on in development (`config.ts:212`). `ops/docker-compose.yml` had no `env_file`, so `NODE_ENV=production` in `.env.docker` never loaded (bug 72).
**Fix.** `apps/api/src/index.ts` refuses to start unless `NODE_ENV` is exactly `production`, `development` or `test`. Compose sets it explicitly (commit `17d7051`).
**Verified by.** `serverNodeEnv.test.ts`: no `NODE_ENV` and `prod` both exit with an error naming the variable; `test` listens (before, both started in dev mode).
**Effect on existing data.** None stored wrong. Any environment that ran without `NODE_ENV` had 2FA defeated, and OTPs in its logs. Those logs should be purged, and sessions created there treated as untrusted.

### 69. Discounted merchants: ledger and settlement disagree by a fil per payment  — Medium
**Symptom.** For merchants with a negotiated discount, the fee the ledger kept and the fee the batch charged differed. For 602 fils at 275 bps with a 12.5% discount, the ledger kept 15 fils and the batch 14.
**How found / reproduced.** Code read comparing TypeScript and Go. ARCHITECTURE says "Discounts reduce the amount the MDR is charged on" (Go's formula), and the TS comment cites a "partner-pricing addendum" that isn't in the repo. Reproduced with a real 602-fil capture.
**Root cause.** `apps/api/src/payments/discountAdjustment.ts:50-59` charges MDR on the full amount and then rebates the discount share, while Go (`discounted_fee.go:7-9`) discounts first and then charges MDR. Rounding at different steps gives different fils.
**Fix.** A new `fees/discountedFee.ts` mirrors Go step for step. Capture records the rate it used (`metadata.mdrBps`). The rebate and reconciliation's pending figure use the same rule (commit `a3b8519`).
**Verified by.** `payments/discountRounding.test.ts` (keeps 14, no reconciliation gap) and a shared 8-case parity table checked in TS and in Go (`discounted_fee_parity_test.go`).
**Effect on existing data.** **Not corrected.** Captures recorded before the fix (no `mdrBps`) keep the old rule, so each historical discounted capture may leave a 1-fil ledger-vs-batch difference. Payouts were always the batch figure, so money paid was right; the leftover gaps are in the ledger. Finance can clear them with one adjustment per merchant if wanted.

### 70. "Rebuild analytics" counts recent payments twice  — Medium
**Symptom.** After an admin pressed "Rebuild analytics", every payment captured since the worker's last pass showed twice on the Overview.
**How found / reproduced.** Code read: the route's comment says it "replays the outbox from the start", but the outbox doesn't hold all history (dev DB: 1,423 captures, 4 outbox events), and the cursor was read without a lock. Reproduced with the real admin route and the real worker: capture A consumed, capture B pending, then rebuild, then the worker.
**Root cause.** `apps/api/src/admin/reportingRebuild.ts:9-51` recounts from the source tables but leaves the worker's cursor (`apps/reporting/src/consumer/cursor.ts`) where it was, so the worker counts B again. Nothing stopped a worker pass running during the rebuild.
**Fix.** The worker and the rebuild share one advisory lock. The rebuild runs in one snapshot, moves the cursor to the snapshot's oldest running transaction, and lists in a new table (migration 0084) the events above it that the snapshot already saw; the worker skips those (commit `099ba77`).
**Verified by.** `admin/analyticsRebuildOnce.test.ts`: 2 captures after the rebuild, still 2 after the worker (3 before the fix), then 3 after capture C.
**Effect on existing data.** Rollups may be overstated after any rebuild done before the fix. **Not repaired automatically.** Run "Rebuild analytics" once more; it now recounts from source and hands over cleanly.

### 71. Every redeploy deletes merchants' KYC documents  — High
**Symptom.** Every `docker compose up --build` deleted all uploaded KYC documents. The database rows still pointed at them, so viewing one failed.
**How found / reproduced.** Found while making the compose file production-ready for hosting. Reproduced on the running stack: a file written to the old path was gone after a forced container re-create (`FILE GONE`), while one in the new volume survived.
**Root cause.** `KYC_UPLOAD_DIR` defaults to `./data/kyc` inside the API container (`apps/api/src/onboarding/kyc.ts`), and `ops/docker-compose.yml` gave it no volume, so files lived in the container's throwaway layer.
**Fix.** A named volume `filspay_kyc` mounted at `/data/kyc`, with `KYC_UPLOAD_DIR=/data/kyc` set explicitly (commit `c0fb3a2`).
**Verified by.** The re-create reproduction above: the old path loses the file, the new path keeps it.
**Effect on existing data.** **Lost files can't be recovered.** On any environment run from the old compose file, documents uploaded before the last re-create are gone, while `kyc_documents` rows still reference them. To find them, list rows whose `storage_key` has no file in the volume. Those merchants must re-upload, and compliance should decide whether their approvals stand.

### 72. A secret committed to git, in a file the stack never loaded  — High
**Symptom.** `ops/.env.docker` was committed with `ACQUIRER_CALLBACK_SIGNING_SECRET`, the key that proves a fraud verdict comes from the acquirer, and was copied into every Node image. Compose never loaded the file, so its `NODE_ENV=production` never reached the API either (bug 68).
**How found / reproduced.** Audit of the ops folder before hosting. The file says it is gitignored and loaded "automatically"; `git ls-files` showed it tracked, and compose has no `env_file:`. Compose only loads a file named exactly `.env`.
**Root cause.** `ops/.env.docker` was tracked, `.gitignore`'s `.env` pattern doesn't match `.env.docker`, `.dockerignore` didn't exclude it, and `ops/docker-compose.yml` never referenced it.
**Fix.** The file is removed from git. Secrets come only from an untracked `ops/.env` generated by `ops/init-env.sh`. Compose reads each with `${VAR:?…}` and refuses to start if one is missing, and sets `NODE_ENV` per service (commit `c0fb3a2`).
**Verified by.** `git ls-files ops/` no longer lists it; `git check-ignore ops/.env` matches; the production stack boots healthy from the generated `.env`.
**Effect on existing data.** The secret is still in git history and in old images, so it must be treated as leaked and **rotated** on every environment that used it (the generated `.env` uses a new one). Callback notes received while the old key was valid can't be told apart from forged ones.

### 73. Under load, failed checkouts leave buyers charged but not sold  — Critical
**Symptom.** At 20–40 checkouts/s, failed payment-link checkouts left money in a half-done state: 73 links **paid** with money only authorized, 41 authorizations with no link, and 276 links stuck **reserved**.
**How found / reproduced.** Load test of checkout (`perf/checkout/run.sh`, checked with `perf/checkout/invariants.sql`). Reproduced in a test by injecting the real "timeout exceeded when trying to connect" error at each checkout step.
**Root cause.** `apps/api/src/paymentLinks/pay.ts:102-181` undoes earlier steps when a step *returns* a failure (a decline), but not when it *throws*. Under load the DB pool runs out, and a step throws partway through.
**Fix.** Each step after the claim runs the same undo when it throws, then rethrows: authorize → release; mark paid → void and release; capture → un-mark and void (commit `3e716c1`).
**Verified by.** `paymentLinks/payFailureCompensation.test.ts`: after a failure at any stage the link is `active`, any authorization is `voided`, and the buyer can pay (before: stuck `reserved`, retry got 409). Load test: every invariant holds at 10–60/s.
**Effect on existing data.** Half-done checkouts from before the fix are repaired by bug 74's recovery pass, which runs at boot. On the test box the first boot pass repaired 86 paid-not-captured, 285 stuck reservations and 42 orphan authorizations. Run `perf/checkout/invariants.sql` after deploying to confirm.

### 74. A crash mid-checkout leaves sales in limbo forever  — High
**Symptom.** Killing the API at 20 checkouts/s left, after the restart, 7 links paid with money only authorized, 17 stuck reserved, and 9 orphan authorizations. Nothing ever repaired them.
**How found / reproduced.** Crash test under load (`perf/checkout/crash.sh`: hard-kill the API 20 s into a 20/s run, then check the invariants after the restart).
**Root cause.** There was no recovery step at all. The only self-healing was the 60 s reservation timeout, which does nothing for money already authorized (`apps/api/src/index.ts` started no repair).
**Fix.** `paymentLinks/recoverAbandoned.ts` runs at boot and every minute. It touches only states older than the reservation timeout, applies the same undo as a failed capture, and uses guarded conditional `UPDATE`s, so repeat runs are safe (commit `8aa40aa`).
**Verified by.** `paymentLinks/recoverAbandoned.test.ts` (each state repaired; in-flight and finished sales untouched; the second pass is a no-op). Live crash test: Docker restarted the API in about 7 s, the first pass repaired 7 + 17 + 9, and the invariants held.
**Effect on existing data.** **Corrected automatically.** The boot pass repairs old debris too (86 + 285 + 42 on the test box). Any environment gets the same repair on its first boot with this version.

### 75. Every checkout reads the whole ledger  — High
**Symptom.** The live box sustained only about 11 checkouts/s, then about 9.5/s the next run. Capacity fell as the ledger grew.
**How found / reproduced.** Live load test. Kernel cgroup counters showed Postgres throttled in 90–95% of periods (`docker stats` showed ~5%). `pg_stat_user_tables` showed `ledger_entries` with 29,632 sequential scans reading 331,682,812 rows and 0 index scans, and `holds` with 4,380 sequential scans.
**Root cause.** The deferred balance trigger in `db/migrations/0007_ledger_double_entry.sql` sums each new leg's group by `entry_group_id`, which has no index, so every leg scans the whole ledger. The same goes for `holds.transaction_id` and `ledger_entries.transaction_id`.
**Fix.** Migration 0085 adds three indexes. The trigger and queries are unchanged (commit `b041eee`, deployed `b6e556c`).
**Verified by.** `payments/ledgerLookupIndexes.test.ts` (plans the three lookups with sequential scans disabled; all fail without 0085). Live: accepted checkouts went from ~9/s to 16–18/s, and Postgres CPU per checkout from 29 to 14 ms, with 0 errors and the invariants holding (`docs/perf/2026-10-30-checkout-capacity.md`).
**Effect on existing data.** None. This is a performance fix only; the indexes cover existing rows.

### 76. Anyone could sign in to the live admin console as super_admin  — High
**Symptom.** On the hosted deployment, anyone who read the public repo could sign in to the admin console as `superadmin@filspay.test` with full rights.
**How found / reproduced.** Full re-review of the live setup. The seed's fixed fixture passwords are in the public repo, and the demo has `OTP_DEV_EXPOSE=true` (no email/SMS sender), so the code comes back in the login response.
**Root cause.** `db/seed/generate.ts:48-58` hard-codes `SEED_ADMIN_PASSWORD`/`SEED_USER_PASSWORD`, and the live box was seeded with them. Each choice was fine alone; together they left the admin login open.
**Fix.** The seed takes both passwords from the environment, and `ops/init-env.sh` generates them into the server's `ops/.env`. `npm run seed:reset-passwords` re-hashes fixture accounts only, and refuses to run without both variables (commit `b873a7e`).
**Verified by.** `db/seedPasswords.test.ts`: passwords come from the env; reset refuses without both; after a reset the public password stops working and non-fixture admins are untouched.
**Effect on existing data.** **Corrected on the live box** (fixture passwords reset; the credentials are only in its `ops/.env`). Admin actions taken before the reset can't be fully trusted; the admin audit log is the record to check. Any other environment seeded with the public passwords needs the same reset.

### 77. The recovery pass reads every link, every minute  — Medium
**Symptom.** Bug 74's minute-by-minute recovery took about 185 ms of Postgres time per minute on the live box (34k links), growing with every link ever created.
**How found / reproduced.** Full re-review using `EXPLAIN ANALYZE` on the live box: two full scans of `payment_links` (78 ms and 96 ms) plus all of `idempotency_keys`.
**Root cause.** In `apps/api/src/paymentLinks/recoverAbandoned.ts`, the queries had no supporting indexes, and the orphan join cast two UUID columns to text, so no index could ever be used.
**Fix.** Migration 0086 adds four indexes (two partial). The orphan query compares UUIDs directly with `EXISTS`. The statements are exported as `RECOVERY_SQL` so the test plans exactly what runs (commit `b444601`).
**Verified by.** `paymentLinks/recoverAbandonedIndexes.test.ts` plans each statement with sequential scans disabled (2 of 3 failed before); the recovery behaviour test still passes.
**Effect on existing data.** None (performance only).

### 78. "Recompute statuses" always reports 0 open authorizations  — Low
**Symptom.** The admin tool's "open authorizations" count was always 0.
**How found / reproduced.** Left as a follow-up in bug 09's note, and confirmed in the re-review. Reproduced with a merchant that has 2 authorized, 1 voided and 1 captured transaction: it reported 0.
**Root cause.** `apps/api/src/admin/transactionStatusRecompute.ts:38,50` counts `authorized` rows among candidates that the query has already filtered to exclude `authorized`.
**Fix.** A separate count of the merchant's authorized transactions (commit `0505234`).
**Verified by.** `admin/recomputeOpenAuthorizations.test.ts`: expects 2, got 0 before. The existing recompute tests still pass.
**Effect on existing data.** None. The figure appears only in the response. (The serious side of this code, clearing test mode, was bug 09.)

### 79. The acquirer simulator's caches grow until the API restarts  — Low
**Symptom.** The API's memory grew with every checkout and never shrank. Under sustained load (16–18/s live) it grows until the out-of-memory killer restarts the process.
**How found / reproduced.** Full re-review after load testing. A code comment asks "slow leak?", and the reply says "cleared on restart… not a leak". Reproduced in a test with a small cap: an old key still replayed after newer ones, so nothing was ever evicted.
**Root cause.** `apps/api/src/acquirer/simulator.ts:82-95` keeps every authorize, capture and refund result in in-process maps with no eviction.
**Fix.** Each cache keeps the most recent 50,000 entries (about 45 minutes at full load; retries come within seconds) and evicts the oldest (commit `edc6de7`).
**Verified by.** `acquirer/simulatorCacheBound.test.ts` (cap 3: a recent key still replays and the oldest no longer does). The existing simulator idempotency tests pass unchanged.
**Effect on existing data.** None. The caches are in memory only.
