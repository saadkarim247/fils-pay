# 76 · Anyone could sign in to the live admin console as super_admin

**Severity:** High (live deployment) · **Area:** `db/seed/`, `ops/init-env.sh`

**What's wrong.** Two choices that were each fine alone combined into an
open admin login:
- **Public passwords.** The seed gives every fixture account a fixed
  password (`SEED_ADMIN_PASSWORD`, `SEED_USER_PASSWORD` in
  `db/seed/generate.ts`), and the repository is public.
- **No second factor.** The hosted demo has no email or SMS sender, so it
  sets `OTP_DEV_EXPOSE=true`, which returns the one-time code in the login
  response.

The live box was seeded, so `superadmin@filspay.test` existed there with
the published password. Anyone who read the repo could sign in to
`admin.<host>` with full admin rights: approve KYC, create credits,
impersonate merchants.

**Fix.**
- `seedPasswords(env)`: the seed uses `SEED_USER_PASSWORD` /
  `SEED_ADMIN_PASSWORD` when set, and the documented constants otherwise
  (laptops, CI).
- `ops/init-env.sh` generates both into the server's `ops/.env`, and the
  compose seed service passes them through.
- **For a database seeded earlier:** `npm run seed:reset-passwords`
  re-hashes only the fixture accounts. It refuses to run unless both
  variables are set, so it can never "reset" to the public values.

The live box was reset this way; its credentials live only in its
`ops/.env`.

**Tests.** New file `db/seedPasswords.test.ts`:
- The seed takes its passwords from the environment, and falls back to the
  defaults without it.
- Reset refuses to run unless both passwords are set.
- Reset gives a fixture admin the new password and the public one stops
  working, while a non-fixture admin is untouched.

No-op stubs failed 3 of the 4 tests; the fourth checks the unchanged
fallback.
