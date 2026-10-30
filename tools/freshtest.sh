#!/usr/bin/env bash
# freshtest.sh [--reporting] <api test files...>
# Runs the given apps/api test files (paths relative to apps/api) against a
# fresh, migrated throwaway database, with the working-tree apps/api/src and
# db/ mounted (no image rebuild needed for source edits). --reporting also
# mounts apps/reporting/src, for API tests that import the reporting worker.
# Prints only ok / not ok lines, pass/fail counts and assertion diffs.
#   tools/freshtest.sh src/refunds/refundCeiling.test.ts
set -uo pipefail
source "$(dirname "$0")/lib.sh"

MOUNTS=(-v "$ROOT/apps/api/src:/app/apps/api/src" -v "$ROOT/db:/app/db")
FILTER='^(not )?ok|^# (pass|fail)|^  (actual|expected):|error:'
if [ "${1:-}" = "--reporting" ]; then
  shift
  MOUNTS+=(-v "$ROOT/apps/reporting/src:/app/apps/reporting/src")
  FILTER="$FILTER|counted|flow"
fi
[ $# -gt 0 ] || { echo "usage: tools/freshtest.sh [--reporting] <api test files...>" >&2; exit 2; }

fresh_db filspay_fresh
$P run --rm --no-deps -e NODE_ENV=test -e DATABASE_URL="$(db_url filspay_fresh)" "${MOUNTS[@]}" migrate \
  sh -c "npm run migrate >/dev/null && cd apps/api && npx tsx --test --test-concurrency=1 $* 2>&1" \
  | grep -E "$FILTER"
