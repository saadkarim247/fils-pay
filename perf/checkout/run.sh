#!/usr/bin/env bash
# Checkout load test against the running stack (start it production-only:
# docker compose -f ops/docker-compose.yml up -d).
# Usage: perf/checkout/run.sh <label> "<rates>" [duration]
#   e.g. perf/checkout/run.sh baseline "2 5 10 15 20 30" 30s
# Each rate runs on its own fresh links; results go to perf/checkout/results-<label>.jsonl.
set -euo pipefail
cd "$(dirname "$0")/../.."
LABEL=$1; RATES=$2; DURATION=${3:-30s}
SECS=${DURATION%s}
PREFIX="${LABEL}$(date +%H%M%S)"
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)
psql() { docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -v ON_ERROR_STOP=1 -qAt "$@"; }

SINCE=$(psql -c "SELECT now()")
TOTAL=0; for r in $RATES; do TOTAL=$((TOTAL + r * SECS * 2)); done   # 2x headroom
psql -v prefix="$PREFIX" -v count="$TOTAL" < perf/checkout/links.sql

OUT="perf/checkout/results-$LABEL.jsonl"; : > "$OUT"
OFFSET=0
for r in $RATES; do
  stats_file=$(mktemp)
  ( while :; do docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' ops-api-1 ops-postgres-1 >> "$stats_file" 2>/dev/null; sleep 2; done ) &
  STATS_PID=$!
  line=$(docker run --rm --network ops_default -v "$ROOT/perf/checkout:/scripts" grafana/k6:0.52.0 run --quiet \
    -e BASE_URL=http://api:3000 -e PREFIX="$PREFIX" -e OFFSET="$OFFSET" -e RATE="$r" -e DURATION="$DURATION" \
    /scripts/checkout.js 2>/dev/null | tail -1)
  kill $STATS_PID 2>/dev/null || true
  api_cpu=$(grep ops-api-1 "$stats_file" | awk '{gsub("%","",$2); if ($2>m) m=$2} END {print m+0}')
  api_mem=$(grep ops-api-1 "$stats_file" | awk '{print $3}' | sort -h | tail -1)
  pg_cpu=$(grep ops-postgres-1 "$stats_file" | awk '{gsub("%","",$2); if ($2>m) m=$2} END {print m+0}')
  rm -f "$stats_file"
  echo "${line%\}},\"label\":\"$LABEL\",\"api_cpu_peak\":$api_cpu,\"api_mem_peak\":\"$api_mem\",\"pg_cpu_peak\":$pg_cpu}" | tee -a "$OUT"
  OFFSET=$((OFFSET + r * SECS * 2))
  sleep 5
done
echo "== invariants ($PREFIX):"
psql -F ' | ' -v prefix="$PREFIX" -v since="$SINCE" < perf/checkout/invariants.sql
