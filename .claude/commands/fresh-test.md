---
description: Run API test files against a fresh, migrated database
argument-hint: "[--reporting] <test files relative to apps/api>"
---

Run these tests on a throwaway database, never the dev database:

```bash
tools/freshtest.sh $ARGUMENTS
```

- Paths are relative to `apps/api` (e.g. `src/refunds/refundCeiling.test.ts`).
  For `scripts/` or `db/` tests use `tools/roottest.sh` with repo-root paths;
  for Go use `tools/gotest.sh`.
- Pass `--reporting` when the test imports `apps/reporting` code.
- If it fails before any test runs, check that the postgres container is up
  and `ops/.env` exists (`POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh`).
  Do not read `ops/.env`.

Report each `not ok` with its actual/expected values, and say whether the
failure is the one we expected (the bug) or something else.
