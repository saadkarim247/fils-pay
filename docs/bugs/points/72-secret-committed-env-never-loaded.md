# 72 · A secret committed to git, in a file the stack never loaded

**Severity:** High (credential leak; root cause of the hosted dev-mode in bug 68) · **Area:** `ops/.env.docker`, `ops/docker-compose.yml`, `.gitignore`, `.dockerignore`

**What's wrong.** `ops/.env.docker` was committed with
`ACQUIRER_CALLBACK_SIGNING_SECRET`, the key that proves an acquirer
callback (fraud verdicts) is genuine. It also set `NODE_ENV=production`.
Two separate failures:
1. **The secret is in git.** Anyone with the repository can sign a fake
   fraud verdict that the API accepts (bug 12 made the signature mandatory;
   this hands out the key). The images baked it in too: `.dockerignore`
   didn't exclude it, and `COPY . .` copied it into every Node image.
2. **The file was never used.** The compose file says service settings
   "come from ops/.env.docker, which compose picks up automatically", but
   there was no `env_file:`. Compose loads only a file named exactly `.env`.
   So `NODE_ENV=production` never reached the API, which is how staging ran
   in dev mode handing out OTP codes (bug 68).

**Why it's wrong.** Secrets don't belong in version control. The comments
show the misunderstanding: AM says the file "is gitignored like .env", and
FH was told by an assistant that `.env` "matches `.env.docker` as a
prefix". It doesn't; a `.gitignore` pattern without wildcards matches only
that exact name.

**Fix.**
- **The file is deleted from git.** Its secret must be treated as leaked
  and rotated; it remains in history.
- **Secrets come only from an untracked `ops/.env`,** written with random
  values by `ops/init-env.sh`. `.gitignore` covers it; `.dockerignore` now
  excludes `**/.env` and `**/.env.docker`.
- **The compose file reads each secret with `${VAR:?…}`,** so a missing one
  stops `docker compose up` with a message instead of starting insecurely.
- **`NODE_ENV` is set explicitly per service** in the compose file, and bug
  68 makes the API refuse to start without it.

**Evidence.** `git ls-files ops/` no longer lists `.env.docker`, and
`git check-ignore ops/.env` matches. Both compose configurations render.
The production-only stack boots healthy with `NODE_ENV=production` from
the generated `ops/.env`.
