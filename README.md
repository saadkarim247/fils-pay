# FilsPay: The Handover (team Gameover)

FilsPay is a Bahraini payments platform: merchant onboarding, card payments, payment links, refunds, daily settlement and payouts. All money is in integer **fils** (1 BD = 1,000 fils). We audited it, fixed **79 findings** (one commit and one note each), built the missing **refunds** feature (FP-300) end to end, and host it live.

## Live

| What | URL |
|---|---|
| Merchant dashboard | https://165-232-180-63.sslip.io/dashboard/login |
| Checkout (payment link) | https://165-232-180-63.sslip.io/pay/plink_H_dwVXDZOMOVGmmjsqBHVR |
| Admin console | https://admin.165-232-180-63.sslip.io |
| Public API | https://165-232-180-63.sslip.io/v1 |

Demo logins are per-deployment secrets and are in the submission PDF, not in this repository (finding 76).

## Where to look

| Path | What it holds |
|---|---|
| `docs/submission/` | The submission document and slides as source (`node docs/submission/build.mjs` prints both PDFs) |
| `docs/bugs/points/NN-*.md` | One note per finding: what's wrong, why, the fix, the test, the effect on existing data |
| `docs/adr/` | The rules the code must follow (plus proposed ADR-0007) |
| `docs/perf/` | Load-test and profiling write-ups with charts (N+1 fixes, live capacity) |
| `perf/` | The harnesses: `perf/checkout/` (k6 live load test, crash test, money invariants), `perf/batch-n-plus-1/` (statement-count profiling) |
| `CLAUDE.md`, `.claude/`, `tools/` | Our AI setup: verified agent rules, permission rules, slash commands, test helpers |
| `ops/` | Production compose, TLS proxy, `init-env.sh` (secrets), `deploy.sh` (one-command redeploy) |

## Run it locally

```bash
POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh
cd ops && docker compose up --build
```

Load the fixture data with `docker compose --profile seed run --rm seed`. Tests always run on a fresh, migrated database; `CLAUDE.md` ("Tests") has the exact commands, and `tools/README.md` has helper scripts for them.

## Deploy

```bash
DEPLOY_HOST=165.232.180.63 DEPLOY_USER=dilmune ops/deploy.sh
```

It ships the committed `HEAD`, keeps the server's own `ops/.env`, and refuses to run during the nightly settlement window (23:55–00:30 Bahrain) unless `FORCE=1`.
