#!/usr/bin/env bash
# Deploys the committed HEAD to the server. Run on your machine:
#   DEPLOY_HOST=165.232.180.63 DEPLOY_USER=deploy ops/deploy.sh
# Ships `git archive HEAD` (exactly what is committed, nothing local), keeps
# the server's ops/.env, and rebuilds/restarts the stack. The compose project
# is pinned to "filspay" so volumes (database, KYC files, certificates) keep
# their names across deploys.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${DEPLOY_HOST:?set DEPLOY_HOST}
USER_AT="${DEPLOY_USER:?set DEPLOY_USER}@$HOST"
KEY=${DEPLOY_KEY:-$HOME/.ssh/filspay_dilmune}
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$USER_AT")
REV=$(git rev-parse --short HEAD)

if [ -n "$(git status --porcelain -- apps packages db ops ':!ops/.env')" ]; then
  echo "note: uncommitted changes exist locally; deploying committed $REV only."
fi

echo "== shipping $REV"
# core.autocrlf=false: ship files exactly as committed (LF). With autocrlf on
# (Windows), git archive converts to CRLF and the server's shell scripts break.
git -c core.autocrlf=false archive --format=tar HEAD | "${SSH[@]}" '
  set -e
  mkdir -p ~/filspay/ops
  # Replace the code, keep the secrets file.
  find ~/filspay -mindepth 1 -maxdepth 1 ! -name ops -exec rm -rf {} +
  find ~/filspay/ops -mindepth 1 ! -name .env -exec rm -rf {} +
  tar -x -C ~/filspay
'
echo "$REV" | "${SSH[@]}" 'cat > ~/filspay/REVISION'

echo "== building and starting"
"${SSH[@]}" '
  set -e
  cd ~/filspay
  test -f ops/.env || { echo "ops/.env missing: run ops/init-env.sh on the server first"; exit 1; }
  docker compose -p filspay -f ops/docker-compose.yml up -d --build --remove-orphans
  docker builder prune -f >/dev/null
  docker compose -p filspay -f ops/docker-compose.yml ps
  df -h / | tail -1; free -h | head -2
'
echo "== deployed $REV"
