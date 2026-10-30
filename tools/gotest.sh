#!/usr/bin/env bash
# gotest.sh [go test args...]   (default: ./...)
# Runs go vet and go test for apps/settlement in a golang container (Go is not
# needed on the host) against a fresh, migrated database. -p 1 because the
# packages share merchant_balances. DATABASE_URL is always set, so DB-backed
# tests really run instead of skipping themselves (see CLAUDE.md "Tests").
#   tools/gotest.sh ./internal/settlement/...
set -uo pipefail
source "$(dirname "$0")/lib.sh"
ARGS=${*:-./...}

fresh_db filspay_go
$P build migrate >/dev/null 2>&1
$P run --rm --no-deps -e DATABASE_URL="$(db_url filspay_go)" migrate npm run migrate >/dev/null 2>&1 \
  || { echo "migrate failed" >&2; exit 1; }
docker run --rm --network "$GO_NET" -e DATABASE_URL="$(db_url filspay_go)" \
  -v "$ROOT/apps/settlement:/src" -v filspay_gomod:/go/pkg/mod -w /src golang:1.22-bookworm \
  sh -c "go vet ./... && go test -p 1 -count=1 $ARGS 2>&1 | grep -E '^(ok|FAIL|--- |panic)|_test.go:[0-9]+'"
