#!/usr/bin/env bash
# Checkout load test against the LIVE server, through the public HTTPS URL.
# Links are created and invariants checked in the server's database over ssh;
# k6 runs on this machine. Each container's CPU over the step comes from the
# kernel's cgroup counters (docker stats samples miss a throttled container).
# Usage: perf/checkout/run-live.sh <label> "<rates>" [duration]
#   DEPLOY_HOST / DEPLOY_USER / DEPLOY_KEY / PUBLIC_URL can override the defaults.
set -euo pipefail
cd "$(dirname "$0")/../.."
LABEL=$1; RATES=$2; DURATION=${3:-30s}; SECS=${DURATION%s}
HOST=${DEPLOY_HOST:-165.232.180.63}; USER_AT="${DEPLOY_USER:-dilmune}@$HOST"
KEY=${DEPLOY_KEY:-$HOME/.ssh/filspay_dilmune}
URL=${PUBLIC_URL:-https://165-232-180-63.sslip.io}
PREFIX="${LABEL}$(date +%H%M%S)"
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)
remote() { ssh -i "$KEY" "$USER_AT" "$@"; }
rpsql() { remote "cd ~/filspay && docker compose -p filspay -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -v ON_ERROR_STOP=1 -qAt $*"; }

SINCE=$(rpsql -c "'SELECT now()'")
TOTAL=0; for r in $RATES; do TOTAL=$((TOTAL + r * SECS * 2)); done
rpsql -v prefix="$PREFIX" -v count="$TOTAL" < perf/checkout/links.sql

OUT="perf/checkout/results-$LABEL.jsonl"; : > "$OUT"
OFFSET=0
for r in $RATES; do
  remote "bash -s snap" < perf/checkout/cgroup-cpu.sh
  line=$(docker run --rm -v "$ROOT/perf/checkout:/scripts" grafana/k6:0.52.0 run --quiet \
    -e BASE_URL="$URL" -e PREFIX="$PREFIX" -e OFFSET="$OFFSET" -e RATE="$r" -e DURATION="$DURATION" \
    /scripts/checkout.js 2>/dev/null | tail -1)
  usage=$(remote "bash -s diff" < perf/checkout/cgroup-cpu.sh)
  echo "${line%\}},\"label\":\"$LABEL\",$usage}" | tee -a "$OUT"
  OFFSET=$((OFFSET + r * SECS * 2))
  sleep 5
done
echo "== invariants on the live database ($PREFIX):"
rpsql -F "' | '" -v prefix="$PREFIX" -v since="'$SINCE'" < perf/checkout/invariants.sql
