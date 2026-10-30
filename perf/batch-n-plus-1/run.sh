#!/usr/bin/env bash
# Batch N+1 profile. Usage: perf/batch-n-plus-1/run.sh <label>   (e.g. before, after)
#
# A throwaway Postgres logs every statement (log_statement=all). Each
# scenario runs REPS times, each time on a fresh copy of one fixed dataset
# (perf_tpl), so the statement count for a run is exactly what that run sent.
# Writes perf/batch-n-plus-1/results-<label>.jsonl.
set -euo pipefail
cd "$(dirname "$0")/../.."
LABEL=$1
REPS=${REPS:-3}
NET=ops_default
PG=filspay-perf-pg
PW=perf
HERE=perf/batch-n-plus-1
ROOT=$(pwd -W 2>/dev/null || pwd)
export MSYS_NO_PATHCONV=1

if ! docker ps --format '{{.Names}}' | grep -qx "$PG"; then
  docker run -d --rm --name "$PG" --network "$NET" -e POSTGRES_USER=filspay -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=filspay \
    postgres:16-alpine -c log_statement=all -c "log_line_prefix=%m [%p] db=%d " >/dev/null
  until docker exec "$PG" pg_isready -U filspay >/dev/null 2>&1; do sleep 1; done
  sleep 2
fi
psql() { docker exec -i "$PG" psql -U filspay -v ON_ERROR_STOP=1 -qAt "$@"; }
url() { echo "postgres://filspay:$PW@$PG:5432/$1?sslmode=disable"; }

# Template: migrated schema + fixed dataset, built once.
if [ -z "$(psql -d filspay -c "SELECT 1 FROM pg_database WHERE datname = 'perf_tpl'")" ]; then
  psql -d filspay -c "CREATE DATABASE perf_tpl"
  docker compose -f ops/docker-compose.yml run --rm --no-deps -e DATABASE_URL="$(url perf_tpl)" \
    -v "$ROOT/db:/app/db" migrate npm run migrate >/dev/null
  psql -d perf_tpl < "$HERE/dataset.sql"
fi

# The settlement binary for this label (compile time is not measured).
mkdir -p "$HERE/bin"
docker run --rm -v "$ROOT/apps/settlement:/src" -v "$ROOT/$HERE/bin:/out" -v filspay_gomod:/go/pkg/mod -w /src \
  golang:1.22-bookworm go build -o "/out/settlement-$LABEL" ./cmd/settlement

BIG=$(psql -d perf_tpl -c "SELECT id FROM merchants WHERE display_name = 'perf-big'")
HOOKS=$(psql -d perf_tpl -c "SELECT id FROM merchants WHERE display_name = 'perf-hooks'")
ENDPOINT=$(psql -d perf_tpl -c "SELECT id FROM webhook_endpoints WHERE url = 'https://hooks.example.com/perf'")
ADMIN=$(psql -d perf_tpl -c "SELECT id FROM admin_users WHERE email = 'perf-finance@filspay.test'")
RECOMPUTE=$(psql -d perf_tpl -c "SELECT id FROM merchants WHERE display_name = 'perf-recompute'")

statements() { docker logs "$PG" 2>&1 | grep -E "db=$1 .*LOG:  (statement|execute)" | wc -l; }

run_go() { # db, args...
  local db=$1; shift
  docker run --rm --network "$NET" -e DATABASE_URL="$(url "$db")" -e SETTLEMENT_INTERNAL_TOKEN=perf \
    -v "$ROOT/$HERE/bin:/perfbin" golang:1.22-bookworm \
    sh -c "s=\$(date +%s%N); /perfbin/settlement-$LABEL $* >/dev/null; e=\$(date +%s%N); echo \$(( (e - s) / 1000000 ))"
}
run_ts() { # db, args...
  local db=$1; shift
  docker compose -f ops/docker-compose.yml run --rm --no-deps -e DATABASE_URL="$(url "$db")" \
    -v "$ROOT/apps/api/src:/app/apps/api/src" -v "$ROOT/perf:/app/perf" migrate \
    npx tsx perf/batch-n-plus-1/scenarios.ts "$@" | tail -1 | sed -E 's/.*"ms":([0-9]+).*/\1/'
}

OUT="$HERE/results-$LABEL.jsonl"
: > "$OUT"
for scenario in s1 s2 s3 s4; do
  for rep in $(seq 1 "$REPS"); do
    db="${scenario}_${LABEL}_${rep}"
    psql -d filspay -c "DROP DATABASE IF EXISTS $db" -c "CREATE DATABASE $db TEMPLATE perf_tpl"
    case $scenario in
      s1) ms=$(run_go "$db" run-batch --date=2026-07-01) ;;
      s2) ms=$(run_go "$db" run-batch --date=2026-07-01 --merchant="$BIG") ;;
      s3) ms=$(run_ts "$db" replay "$HOOKS" "$ENDPOINT" "$ADMIN") ;;
      s4) ms=$(run_ts "$db" recompute "$RECOMPUTE") ;;
    esac
    n=$(statements "$db")
    echo "{\"label\":\"$LABEL\",\"scenario\":\"$scenario\",\"rep\":$rep,\"statements\":$n,\"ms\":$ms}" | tee -a "$OUT"
    psql -d filspay -c "DROP DATABASE $db"
  done
done
