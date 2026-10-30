## 4. Findings report

We fixed 79 findings. They are grouped below by the brief's leaflet that pointed at them: the finance memo, the group chat, the support tickets and incidents, the unfiled hunches, and the FP-300 build task. Each concern is linked to what we found, the fix, the proof, and the commit. Findings no leaflet mentioned are listed last.

Every fix is one commit with a test that failed before the fix and passes after it. The full entry for each finding is in **Appendix A**: symptom, how we reproduced it, root cause, fix, verification and the effect on existing data. It is also in `docs/bugs/points/NN-*.md`.

### 4.1 Finance memo (Fatima H., 20 Sep)

| Leaflet concern | What we found | Fix | Proof | # · commit |
|---|---|---|---|---|
| "Scheme statement is always a few fils **higher**, never lower" | Our books truncate each line to the scheme's 10-fil unit, but the file sent the untruncated gross rounded into `NUMERIC(10,2)`. The residue was never journaled, so ADR-0002's claim that it was "implemented" is false. | Export the truncated `amount_fils`. Journal the residue per line. | Lines quote "93.27" (was "93.28"); 7 + 5 + 4 = 16 fils posted to residue | 50 · `4894ccc` |
| "March sweep ran twice on staging and the gap doubled" | Each run made a new random entry id and re-posted. It debited **merchants** for scheme rounding. | A deterministic id per merchant and month, plus an advisory lock. Correct legs per ADR-0002: clearing and residue, with no merchant leg. | The second run posts nothing | 49 · `d7828fa` |
| "Delta split payouts: the 3 children don't sum to the parent" | Each child share was rounded on its own and the remainder was dropped. Weights were never checked. | Largest-remainder allocation, plus a check that the weights add up. | 1,001 → 334/333/334; a sweep of ~700 amounts × 5 splits sums exactly | 41 · `a7df15f` |
| "Recalculate cached balances: Alpha 135K → 7K; the CLI is right" (FP-203) | The console rebuilt balances from scheme-export lines (gross, no fees, payouts or refunds), not the ledger. Single-merchant rebuild wrote nothing. | Console calls the ledger rebuild (proposed ADR-0007). Single-merchant rebuild writes. | Console = CLI = 700 | 39, 63 · `c036eb2` `d390446` |
| "MDR recalculation changes batches already closed/paid" | Selected `status <> 'open'`, which includes **paid** batches. | Only `status = 'closed'`. | Paid batch unchanged; unpaid one moves | 16 · `c82f321` |
| "Dashboard shows 245 bps, payments go through at 225" | The display took the newest row entered and ignored its effective date (the backfilled 245). | Same query as capture, with the same tie-break in Go. | 245 shown vs 225 charged → both 225 | 18 · `3b9eec9` |
| "CSV import: 4.755 BD → 4.750; 4.75 → 0.475" | Amounts were parsed as **cents** (2 decimals), against ADR-0001. Nothing stopped the same file being applied twice. | `parseBhdToFils` (3 decimals). Unique content hash (migration 0074). | 12 of 16 tests failed before (414,190 vs 4,141,900 fils); duplicate refused | 13, 20 · `c797270` `0c8b213` |

### 4.2 Group chat (unchecked claims)

| Leaflet concern | What we found | Fix | Proof | # · commit |
|---|---|---|---|---|
| "Daily close runs at 3am local, not midnight" | The daemon took "today" from the **UTC** date, so it closed at 00:00 UTC (03:00 Bahrain). A close for today was also accepted and silently dropped later sales. | Bahrain date before the window. Refuse a day that hasn't ended. | 6 clock cases (4 failed before); today → refused | 17, 40 · `57a190d` `95995c4` |
| "Lifetime payout estimate drifts for high-volume merchants" | Summed in `REAL` (float32): 256-fil steps above 2³¹ fils. | `BIGINT` fils (migration 0080). | Exact sums (was 3.0195802e+09) | 57 · `17f533a` |
| "Test merchants show up in the real settlement run" | "Recompute statuses" counted `authorized` rows after excluding them, so the count was always 0, which switched `test_mode` off. | Recompute never touches `test_mode`. | Sandbox merchants stay sandbox (3 of 5 failed before) | 09 · `1a870ab` |
| "Login works without entering the OTP" | The session view `live_sessions` dropped `authenticated = true`. Login could also land on **another merchant's** user with the same email. | Require the authenticated flag. Use the password-checked user. | Password-only cookie: 200 → 401 | 02, 03 · `0685a87` `5c5aa3e` |
| "Merchant A cancelled merchant B's payment link" | Cancel matched the link id only. | Scope by the authenticated merchant. | B → 404, link stays active | 11 · `a563baa` |

### 4.3 Support tickets and incidents

| Leaflet concern | What we found | Fix | Proof | # · commit |
|---|---|---|---|---|
| **FP-187** link paid after expiry: "server trusts something the checkout sends" | Expiry was judged by the buyer's `submittedAt`. | Server clock only. | Expired link → 410 for public buyers | 38 · `88c9e42` |
| **FP-201** duplicate acquirer callback → two notes | No unique key on the callback id, so a retry inserts again. Unsigned callbacks were also accepted. | Unique `callback_id` (0078). Signature always required. | Same callback twice → 1 note; 5 of 6 auth tests failed before | 43, 12 · `68d208b` `4e5a9c4` |
| **FP-209** two concurrent refunds both succeed | Read without a lock, the acquirer called outside the transaction, then an absolute `refunded_fils` written. | One row-locked transaction that adds to the total. DB `CHECK`. | 5 simultaneous refunds: 5 paid → at most 3 | 28 · `d9d4f30` |
| **FP-240** webhook signer and sender disagree; inbound check has problems | Signed sorted-key JSON but sent different bytes, so every receiver's check failed. Replays got a new id. Inbound callbacks failed open. | Sign the exact bytes sent. Keep the id on replay. Require a signature inbound. | Raw-body verification passes; replays share one id | 36, 37, 12 · `1e35fa0` `66264df` |
| **Incident 2026-05-14**: one link charged twice ("this IS reachable") | A stale reservation could be re-claimed. Finalize with 0 rows still answered "paid". | Each reservation has an owner id. The link is marked paid atomically before capture. The loser is voided with a 409. | Forced overlap: 2 captures → 1 | 23 · `351cab5` |
| **Incident 2026-08-21**: duplicate "payout on the way" | `settlement.paid` used NOT EXISTS then INSERT with no unique key. Disbursements were written once per webhook **delivery**. | One event and one disbursement per paid batch, inside the locked payout. | 4 events/batch → 1; 2 disbursements → 1 | 24 · `c0f764d` |

### 4.4 Unfiled hunches

| Hunch | What we found | Fix | # · commit |
|---|---|---|---|
| Refund more than was charged? | Yes: the ceiling was *authorized* − refunded, not *captured*. | Captured − refunded, plus a DB `CHECK` (0076). | 27 · `cb044bc` |
| Settlement splits a few fils short | Yes (see 4.1). | Largest remainder. | 41 · `a7df15f` |
| Some admin actions lack role checks | Support could create credits. "View as merchant" mapped super_admin to owner, and capture and void had no role gate. The export summary had no auth at all. | `requireAdminRole` on each route. Impersonation refuses every write (403). | 07, 04, 46 · `49a10ac` `9f4e04d` `97a2789` |
| A key rotation flow doesn't do what you'd expect | Rotation never revoked the old key. Each click minted another live key. | Rotation revokes the old key, and a second rotation is refused. | 05 · `cca2b57` |
| Daily close timing doesn't match the docs | Yes (see 4.2). | Bahrain date. | 17 · `57a190d` |
| A reporting query is suspiciously slow | It summed each sale’s running total once per capture event, so it was both slow **and wrong**: a sale captured N times was counted N times (Delta ~38 % over the batch gross). | One query: sum the capture events in the window and count distinct sales. | 42 · `d0a05b6` |
| Test merchants when certain admin tools run | Yes (see 4.2). | | 09 · `1a870ab` |
| OTP implementation changed: still safe? | No: OTPs and link tokens came from `Math.random` (predictable), and the 5-guess limit could be raced or reset by a resend. | `node:crypto`. Atomic attempt budget across resends. | 44, 53 · `8565593` `3f8b71d` |
| Uploading a really large export | CSV export loaded the whole history into memory. Cells starting `= + - @` ran as formulas in Excel. | Stream the rows; neutralise formulas. | 55 · `f06717a` |

### 4.5 FP-300: finish the missing feature (refunds)

"Looks easy. It isn't. It touches everything." Each of the brief's "done when" criteria, and what it took:

| Done when… | What was broken | # · commit |
|---|---|---|
| Works end to end through the API | The route returned 501 and the drawer wasn't wired. A refund without a reason sent money but recorded nothing. Merchant B could refund A's sale. | 35, 25, 26 · `e96547e` `12b2cbf` `71a8ebe` |
| Ledger right down to the fils; fees and payouts right | Over-refund (27), concurrent refunds (28). Fee reversal rounded each part separately (22 fee → 21 back). Settlement paid merchants for refunded money. | 27, 28, 29, 30 · `cb044bc` `d9d4f30` `43a832c` `c85f1f4` |
| Shop gets the right webhook | `refund.succeeded` was never delivered. | 32 · `a9f880e` |
| Correct in timeline, reports and reconciliation | The refunded transaction page crashed on negative amounts. Reconciliation ignored refunds. The refund summary view joined on the wrong column. Analytics dropped refunds. | 34, 31, 33, 58 · `27e22cf` `3670d51` `8c6cd65` `19157a7` |
| Live on Dilmune Cloud | Deployed and demonstrated: a full and a partial refund (section 5). | `856befa` live |

### 4.6 Beyond the leaflets

These came from reading the code against the ADRs, from the load tests and from hosting.

| # | Sev. | Finding | Fix · commit |
|---|---|---|---|
| 14 | Critical | The nightly hold job ran `DELETE FROM holds` with no WHERE clause on any quiet night | One `UPDATE … SET status='expired'` · `417580f` |
| 73 | Critical | Under load, failed checkouts left buyers charged but not sold | Each step undoes the earlier ones · `3e716c1` |
| 01 | High | A fresh database couldn't migrate past 0054/0055 | Broken statements disabled; fresh-DB test · `6583411` |
| 15 | High | Payouts computed in float32, 1–2 fils off above 16,777 BD | `gross − fee` in integer fils · `7af0d98` |
| 19 | High | The platform volume counter (int32) wraps and switches the tier discount off | `BIGINT` (0073) · `2f6be7c` |
| 21 | High | Payment-link sales skipped the merchant's discount | Discount applied on link capture · `602019b` |
| 22 | High | A reused capture key "succeeded" without capturing | Key bound to the transaction · `5387edf` |
| 06 | High | Two-person credit approval compared display names | Compare admin ids · `a418e75` |
| 08 | High | Bulk KYC approved merchants in any state | Only `under_review`, with review rows · `b355b7e` |
| 10 | High | Any merchant could read a marketplace child's data | Parent-only scope · `3e7afc3` |
| 51 | High | Analytics skipped events that committed late (cursor by id) | Read in commit order (0079) · `fac07e5` |
| 54 | High | Webhook URLs could target internal addresses (SSRF) | Block private addresses; no redirects · `cc9a94b` |
| 60 | High | The repo's AI rule files told assistants to keep the bugs | Rules rewritten and verified · `889c2d4` |
| 68 | High | Without `NODE_ENV` the API handed out OTP codes | Refuse to start · `17d7051` |
| 71 | High | Every redeploy deleted KYC uploads | KYC volume · `c0fb3a2` |
| 72 | High | A secret was committed in a file the stack never loaded | Secrets generated per server · `c0fb3a2` |
| 74 | High | A crash mid-checkout left sales in limbo | Recovery pass at boot and every minute · `8aa40aa` |
| 75 | High | Every checkout scanned the whole ledger (see §3) | 3 indexes (0085) · `b041eee` |
| 76 | High | Public seed passwords + exposed OTP = live admin login | Per-deployment passwords · `b873a7e` |
| 45 | Medium | The public link page leaked API key material | Removed from the response · `438456d` |
| 47 | Medium | KYC "PDF only" checked the file name; image bombs accepted | Check bytes; cap pixels · `f1a1352` |
| 48 | Medium | Reconciliation invented gaps from its own fee guess | Use the recorded fee · `fdedd94` |
| 52 | Medium | One missing rollup row froze analytics for everyone | Skip and continue · `031c41b` |
| 56 | Medium | Manual credits back-dated into closed days | Post at `now()`; no future dates · `652dd48` |
| 59 | Medium | Merchants were logged out after 10 minutes | Re-issue the cookie on OTP verify · `ee085d1` |
| 62 | Medium | A webhook endpoint couldn't be deleted | FK set null (0082) · `32045f7` |
| 64 | Medium | 100 bad webhooks stalled every merchant's webhooks | Back off the bad rows · `78bd6f8` |
| 69 | Medium | Discounted fees: ledger and settlement 1 fil apart | One rounding order, TS = Go · `a3b8519` |
| 70 | Medium | "Rebuild analytics" counted recent payments twice | Snapshot rebuild + lock (0084) · `099ba77` |
| 77 | Medium | The recovery pass scanned every link every minute | Indexes (0086) · `b444601` |
| 61, 65, 66, 67, 78, 79 | Low | Invite codes from `Math.random`; off-by-one day range; rollback masked errors; unbounded archives; open-auth count always 0; unbounded simulator caches | `5fa5bb7` `c43570a` `df31fa6` `08eb8c2` `0505234` `edc6de7` |
