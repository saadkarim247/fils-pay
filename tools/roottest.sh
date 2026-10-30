#!/usr/bin/env bash
# roottest.sh <test files relative to the repo root...>
# Like freshtest.sh, but runs from the repo root inside the container, for
# tests outside apps/api (scripts/*.test.ts, db/*.test.ts). Working-tree
# apps/api/src, db/ and scripts/ are mounted; the database is fresh and migrated.
#   tools/roottest.sh scripts/reconcile_march.test.ts db/migrate.fresh.test.ts
set -uo pipefail
source "$(dirname "$0")/lib.sh"
[ $# -gt 0 ] || { echo "usage: tools/roottest.sh <test files...>" >&2; exit 2; }

fresh_db filspay_rt
$P run --rm --no-deps -e NODE_ENV=test -e DATABASE_URL="$(db_url filspay_rt)" \
  -v "$ROOT/apps/api/src:/app/apps/api/src" -v "$ROOT/db:/app/db" -v "$ROOT/scripts:/app/scripts" migrate \
  sh -c "npm run migrate >/dev/null && npx tsx --test --test-concurrency=1 $* 2>&1" \
  | grep -E '^(not )?ok|^# (pass|fail)|^  (actual|expected):|rror'
