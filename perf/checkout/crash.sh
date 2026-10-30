#!/usr/bin/env bash
# Crash under load: run the checkout at RATE/s for 60 s, hard-kill the API's
# Node process 20 s in (Docker restarts it), then check the invariants.
# Usage: perf/checkout/crash.sh [rate]
set -euo pipefail
cd "$(dirname "$0")/../.."
RATE=${1:-20}; SECS=60; LABEL=crash
PREFIX="${LABEL}$(date +%H%M%S)"
export MSYS_NO_PATHCONV=1
ROOT=$(pwd -W 2>/dev/null || pwd)
psql() { docker compose -f ops/docker-compose.yml exec -T postgres psql -U filspay -d filspay -v ON_ERROR_STOP=1 -qAt "$@"; }
SINCE=$(psql -c "SELECT now()")
psql -v prefix="$PREFIX" -v count="$((RATE * SECS * 2))" < perf/checkout/links.sql
BEFORE=$(docker inspect -f '{{.RestartCount}}' ops-api-1)
( sleep 20
  docker exec ops-api-1 sh -c 'for p in /proc/[0-9]*; do c=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$c" in *node*apps/api/src/index.ts*) n=${p#/proc/}; [ "$n" != 1 ] && kill -9 $n;; esac; done'
  echo "[crash] killed the API process at +20s" >&2 ) &
docker run --rm --network ops_default -v "$ROOT/perf/checkout:/scripts" grafana/k6:0.52.0 run --quiet \
  -e BASE_URL=http://api:3000 -e PREFIX="$PREFIX" -e OFFSET=0 -e RATE="$RATE" -e DURATION="${SECS}s" \
  /scripts/checkout.js 2>/dev/null | tail -1
wait
for i in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' ops-api-1)" = healthy ] && break; sleep 2; done
echo "[crash] restarts: $BEFORE -> $(docker inspect -f '{{.RestartCount}}' ops-api-1), health: $(docker inspect -f '{{.State.Health.Status}}' ops-api-1)"
states() { psql -F ' | ' -c "SELECT l.status, COALESCE(t.status,'-') AS txn, count(*) FROM payment_links l LEFT JOIN transactions t ON t.id = l.transaction_id WHERE l.token LIKE 'plink_${PREFIX}_%' AND l.status <> 'active' GROUP BY 1,2 ORDER BY 3 DESC"; }
echo "== link states right after the crash:"; states
WAIT=${RECOVERY_WAIT:-80}
echo "[crash] waiting ${WAIT}s for the recovery pass (reservation timeout 60 s + timer)"; sleep "$WAIT"
echo "== link states after recovery:"; states
echo "== recovery log:"; docker logs --since 5m ops-api-1 2>&1 | grep -i "recovered abandoned" | tail -3 || true
echo "== invariants ($PREFIX):"
psql -F ' | ' -v prefix="$PREFIX" -v since="$SINCE" < perf/checkout/invariants.sql
