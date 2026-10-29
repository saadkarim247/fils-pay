# 05 · Rotating an API key leaves the old key working

**Severity:** High · **Area:** `apps/api/src/admin/apiKeys.ts`

**What's wrong.** When a merchant's API key may have leaked, an admin
"rotates" it. The admin console says "the current key is revoked and a
replacement is issued". In practice a new key is issued and the old one
keeps working: it can still read data and take payments.

**Why it's wrong.**
- Migration 0037 defines rotation as one transaction that "revokes the old
  key with reason 'rotated' and issues the replacement". The route's own
  doc comment says "revoke + reissue + audit". The audit-rollback test
  expects a revoked key.
- The function never sets `revoked_at` on the old key.
- The "grace period" excuse (AM: "see ADMIN.md") doesn't hold. ADMIN.md
  mentions no grace period. The `revoke_after` column (0056) that would
  allow a staged revocation is never set or read, and no sweep job exists.
- The brief's own hints list "a key rotation flow doesn't do what you'd
  expect".

**Spread / what it breaks.**
- Rotation, the response to a leaked key, does nothing to the leaked key.
  Whoever holds it can keep authorizing payments and reading transactions.
- Each rotation adds another live key. The old key isn't revoked, so it can
  be rotated again and again, each time minting another working key. A
  finance-role admin can do this for any merchant.
- Scale: `docs/exports/admin-audit-2026-09.csv` has 14 rotations in
  September alone. With this code, every one left the old key live.

**Fix (one statement).** Inside the existing rotation transaction, set
`revoked_at = now(), revoked_reason = 'rotated'` on the old key, which is
already locked `FOR UPDATE`. If the audit write fails, the revoke rolls
back with everything else.

**Tests.** New file `apps/api/src/admin/apiKeyRotation.test.ts`, 5 tests,
through the real admin route and API-key guard:
- After rotation the old key gets 401 and the new key gets 200.
- The old key can no longer authorize a payment.
- The old row records `revoked_at` and reason `rotated`, and the new row
  points back at it.
- Rotating the same old key again returns 409, leaving exactly one live
  key.
- The merchant's other keys keep working.

Before the fix, 4 of 5 failed: the old key still authorized a new payment
(201), and a second rotation minted another live key. After the fix, all
pass. Also replayed on the running stack: the old key went from 200 to 401
after an admin rotation.

**Existing test corrected.** `admin.test.ts` ("…the previous key stays
active") asserted the bug itself. Only its title and three assertions
changed, to "revoked", with a comment giving the reasons above. Its other
checks are unchanged, and the audit-rollback test passes without changes.
