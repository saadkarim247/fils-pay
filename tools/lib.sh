# Shared helpers for the tools/*.sh test scripts. Source it, don't run it.
# Moves to the repo root and defines:
#   $P            the compose command for the local stack
#   $GO_NET       docker network of the local stack (compose project "ops")
#   db_url NAME   connection string for a database on the local postgres
#   fresh_db NAME drop + recreate an empty database (dropped again on exit)
# The password is the laptop dev value documented in CLAUDE.md ("Tests"):
# create ops/.env with `POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh`.
# Set POSTGRES_PASSWORD in the environment if your local volume uses another.
cd "$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" || exit 1
export MSYS_NO_PATHCONV=1                       # Git Bash: don't rewrite /app paths
ROOT=$(pwd -W 2>/dev/null || pwd)               # Windows path for docker -v on Git Bash
P="docker compose -f ops/docker-compose.yml"
GO_NET=${COMPOSE_NETWORK:-ops_default}
PGPASS=${POSTGRES_PASSWORD:-filspay_dev_password}

[ -f ops/.env ] || { echo "ops/.env missing: run POSTGRES_PASSWORD=filspay_dev_password ops/init-env.sh" >&2; exit 1; }

db_url() { echo "postgres://filspay:${PGPASS}@postgres:5432/$1?sslmode=disable"; }

_drop_db() { $P exec -T postgres psql -U filspay -d filspay -qc "DROP DATABASE IF EXISTS $1 WITH (FORCE)" >/dev/null 2>&1 || true; }

fresh_db() {
  _drop_db "$1"
  $P exec -T postgres psql -U filspay -d filspay -qc "CREATE DATABASE $1" >/dev/null \
    || { echo "could not create database $1 (is the postgres container up?)" >&2; exit 1; }
  _FRESH_DBS="${_FRESH_DBS:-} $1"
  trap 'for d in $_FRESH_DBS; do _drop_db "$d"; done' EXIT
}
