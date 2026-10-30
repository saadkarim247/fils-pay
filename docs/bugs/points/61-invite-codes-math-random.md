# 61 · Admin invite codes come from Math.random()

**Severity:** Low today (no route calls it yet) · **Area:** `apps/api/src/admin/inviteCode.ts`

**What's wrong.** Admin invite codes, which turn whoever redeems one into
an admin, were generated with `Math.random()`.

**Why it's wrong.**
- **Its state can be recovered.** `Math.random()` is not a secure random
  source: its internal state can be worked out from a handful of outputs,
  after which every future value is predictable.
- **Bug 44 missed it.** That fix made `lib/random.ts` use `node:crypto`,
  but `generateInviteCode` had its own copy of the `Math.random()` loop.

**Spread / what it breaks.** Nothing reachable yet: no route or console
screen calls `createAdminInvite`. It's a trap for the day someone wires it
up, because a predictable invite code is a path to an admin account.

**Fix.** `generateInviteCode` uses `randomFromAlphabet` from
`lib/random.ts` (node:crypto `randomInt`, uniform, no modulo bias). Same
alphabet and length.

**Tests.** New file `apps/api/src/admin/inviteCodeRandom.test.ts`: with
`Math.random` pinned to 0, 20 codes must still differ and match the
alphabet. Before the fix every code came out as `AAAAAAAA`. After it, the
test passes. Full suite (fresh database): no new failures.
