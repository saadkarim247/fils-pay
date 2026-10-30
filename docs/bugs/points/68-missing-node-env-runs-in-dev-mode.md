# 68 · Without NODE_ENV the API hands out OTP codes

**Severity:** High (2FA defeated on any box started without NODE_ENV) · **Area:** `apps/api/src/index.ts`, `config.ts`, `ops/docker-compose.yml`

**What's wrong.** If `NODE_ENV` is missing, or misspelled (`prod`,
`Production`), the API quietly runs in development mode. Then:
- **the login response contains the OTP code** (`devOtpCode`), so a stolen
  password is enough to log in, and the dashboard even shows "Development
  code: …";
- OTP codes are written to the logs in plaintext;
- the built-in dev encryption key and non-`Secure` cookies are allowed.

**Why it's wrong.**
- **The config fails open.** `parseNodeEnv` turns anything it doesn't
  recognise into `"development"`.
- **The production setting is never loaded.** The compose file claims its
  variables "come from ops/.env.docker" (which sets
  `NODE_ENV=production`), but it has no `env_file`, so nothing loads it.
- **The comments confirm it.** am notes "our staging has NODE_ENV unset",
  and YA's reply ("staging gets NODE_ENV=production from ops/.env.docker")
  is false.
- **We saw it live:** the local dashboard printed the OTP on the login
  page.

**Spread / what it breaks.** Every merchant and admin login on any
environment started without `NODE_ENV`: staging today, and the Dilmune
deployment if it's started the same way.

**Fix.** The server entry point (`index.ts`) refuses to start unless
`NODE_ENV` is exactly `production`, `development` or `test`, with a message
naming the variable. Library code and tests that build their own config
are unchanged. The local compose `api` service now sets
`NODE_ENV: development` explicitly; hosting must set `production`.

**Tests.** New file `apps/api/src/serverNodeEnv.test.ts` starts the real
server process:
- With no `NODE_ENV`, it exits with an error naming `NODE_ENV`.
- With `NODE_ENV=prod`, it exits.
- With `NODE_ENV=test`, it listens.

Before the fix the first two started listening in dev mode. After it, all
pass.

**Also found (not changed).** The built-in dev fallback encryption key
decodes to 34 bytes, so it is rejected in every mode: the "fallback" never
worked. Every environment must set `WEBHOOK_SECRET_ENCRYPTION_KEY`, as the
compose file already does.
