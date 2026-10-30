# tools/

Helper scripts we (and Claude Code) used during the audit. Shell scripts run
from Git Bash or any POSIX shell, from any directory: each one moves to the
repo root itself. The test scripts need the local stack's postgres running
and `ops/.env` created (`POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh`),
as described in `CLAUDE.md` under "Tests". They never touch the dev database:
each creates a throwaway database and drops it on exit.

| Script | What it does | When |
|---|---|---|
| `freshtest.sh [--reporting] <files>` | Runs the given `apps/api` test files on a fresh, migrated database, with the working-tree source mounted. `--reporting` also mounts `apps/reporting/src`. | While fixing a bug: the failing test, then the fix. |
| `roottest.sh <files>` | Same, for tests outside `apps/api` (`scripts/*.test.ts`, `db/*.test.ts`), run from the repo root. | Bugs in scripts or the migration runner. |
| `gotest.sh [args]` | `go vet` + `go test -p 1` for `apps/settlement` in a golang container, on a fresh database (Go not needed on the host). | Any settlement change. |
| `suite.sh` | Everything: all TS workspaces (reporting on its own database), scripts, db, five typechecks, Go vet and tests. Reports failures not in `suite-baseline.txt`. | Before each commit. |
| `suite-baseline.txt` | Known failures for `suite.sh` (empty now: everything should pass). | Edit only with a reason in a bug note. |
| `commit.sh "<msg>" <paths>` | Commits exactly these paths, keeping `+x` on `*.sh` (Windows loses it), without touching anything else you have staged. | Commits that add or change shell scripts. |
| `lib.sh` | Shared setup for the scripts above (repo root, compose command, fresh database helpers). | Sourced, not run. |
| `sql/fk-without-index.sql` | Lists foreign keys with no supporting index, biggest tables first. | Performance review. |
| `sql/recovery-pass-explain.sql` | `EXPLAIN ANALYZE` of the checkout recovery-pass queries, rolled back (bug 77). | Checking that the bug 77 indexes are used. |
| `perf/paylat.py` | p50/p95/max latency per endpoint from the API's JSON logs. | Reading a load test from the server side. |
| `docs/contracts-to-md.cjs`, `docs/contracts-to-latex.cjs` | Build the code-contracts reference (Markdown or LaTeX) from per-area JSON written by the audit agents. | Regenerating the reference. |
| `docs/check-latex.cjs` | Static checks of a `.tex` file (braces, environments, unescaped specials), since no TeX engine was available. | Before sending LaTeX to be compiled. |
| `docs/pdftext.cjs`, `docs/pdf-images.cjs` | Count pages and pull text or images out of a PDF with Node built-ins only. | Reading the brief (an image-only scan) and checking generated PDFs. |
| `puzzle/vigenere.js` | Decrypts the second hidden commit message (key `diffs`). | Reproducing the narrative puzzle. |

Load tests are not here: they live in `perf/`.
`perf/checkout/run.sh` (local stack), `perf/checkout/run-live.sh` (the live
server, with per-container CPU from `perf/checkout/cgroup-cpu.sh`),
`perf/checkout/crash.sh` and `perf/batch-n-plus-1/run.sh`.
