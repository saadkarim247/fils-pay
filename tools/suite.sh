#!/usr/bin/env bash
# suite.sh : the whole suite (TypeScript workspaces, scripts, db, typechecks,
# Go vet + tests) on throwaway, freshly migrated databases. Rebuilds the
# migrate image first, so it tests the working tree as built.
# The reporting package gets its own database: it reads the whole outbox, and
# the events the API tests leave behind break 4 of its tests (CLAUDE.md "Tests").
# Prints a compact summary, then any failure that is not in the known baseline
# (tools/suite-baseline.txt, one regex per line; empty = expect zero failures).
set -uo pipefail
source "$(dirname "$0")/lib.sh"

fresh_db filspay_suite
fresh_db filspay_suite_rep
$P build migrate >/dev/null 2>&1 || { echo "build of the migrate image failed" >&2; exit 1; }

OUT=$($P run --rm --no-deps -e NODE_ENV=test -e DATABASE_URL="$(db_url filspay_suite)" \
  -e REPORTING_URL="$(db_url filspay_suite_rep)" migrate sh -c '
  npm run migrate >/dev/null 2>&1 || { echo "MIGRATE FAILED"; exit 1; }
  DATABASE_URL=$REPORTING_URL npm run migrate >/dev/null 2>&1 || { echo "MIGRATE FAILED (reporting db)"; exit 1; }
  for w in packages/money packages/events apps/api apps/web; do
    echo "> $w"; npm test -w "$w" 2>&1 | grep -E "^# (tests|fail)|^not ok"
  done
  echo "> apps/reporting (own database)"
  DATABASE_URL=$REPORTING_URL npm test -w apps/reporting 2>&1 | grep -E "^# (tests|fail)|^not ok"
  echo "> scripts"; npx tsx --test scripts/*.test.ts 2>&1 | grep -E "^# (tests|fail)|^not ok"
  echo "> db";      npx tsx --test db/*.test.ts      2>&1 | grep -E "^# (tests|fail)|^not ok"
  npx tsc -p scripts --noEmit >/dev/null 2>&1 && echo "typecheck scripts OK" || echo "typecheck scripts FAILED"
  npx tsc -p db --noEmit      >/dev/null 2>&1 && echo "typecheck db OK"      || echo "typecheck db FAILED"
  for a in api admin web; do
    (cd apps/$a && npx tsc --noEmit >/dev/null 2>&1) && echo "typecheck $a OK" || echo "typecheck $a FAILED"
  done' 2>&1)

GO=$(docker run --rm --network "$GO_NET" -e DATABASE_URL="$(db_url filspay_suite)" \
  -v "$ROOT/apps/settlement:/src" -v filspay_gomod:/go/pkg/mod -w /src golang:1.22-bookworm \
  sh -c "go vet ./... >/dev/null 2>&1 || echo 'go vet FAILED'; go test -p 1 -count=1 ./... 2>&1 | grep -E '^(ok|FAIL|--- FAIL)'")

KNOWN=$(grep -vE '^\s*(#|$)' tools/suite-baseline.txt 2>/dev/null | paste -sd'|' -)
FAILS=$(echo "$OUT" | grep '^not ok' || true)
echo "$OUT" | grep -E "^> |^# tests|^# fail|MIGRATE"
echo "--- failures NOT in the known baseline:"
if [ -n "$KNOWN" ]; then echo "$FAILS" | grep -vE "$KNOWN" | grep . || echo "(none)"
else echo "$FAILS" | grep . || echo "(none)"; fi
[ -n "$KNOWN" ] && echo "--- known-baseline failures still failing: $(echo "$FAILS" | grep -cE "$KNOWN")"
echo "--- go:"; echo "$GO" | awk '{print $1}' | sort | uniq -c
echo "$GO" | grep -E "FAIL" || true
echo "--- typechecks: $(echo "$OUT" | grep -c 'typecheck .* OK') OK, $(echo "$OUT" | grep -c 'typecheck .* FAILED') FAILED"
echo "$OUT" | grep "typecheck .* FAILED" || true
echo "$GO" | grep -q "go vet FAILED" && echo "--- go vet FAILED" || echo "--- go vet OK"
