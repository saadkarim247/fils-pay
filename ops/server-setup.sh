#!/usr/bin/env bash
# One-time server preparation (Ubuntu 24.04). Run ON the server as the deploy
# user with sudo rights:  bash server-setup.sh
# Idempotent: safe to run again. Prints what it finds before changing anything.
set -euo pipefail

echo "== host"; uname -a; free -h; df -h / | tail -1; swapon --show || true

if ! command -v docker >/dev/null 2>&1; then
  echo "== installing Docker Engine + compose plugin from Ubuntu's repositories"
  sudo apt-get update -y
  sudo apt-get install -y docker.io docker-compose-v2
fi
sudo systemctl enable --now docker
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  echo "!! added $USER to the docker group: log out and back in before deploying"
fi

# A 2 GB box builds Node and Go images; a swap file keeps a build from
# being OOM-killed. Created only if the box has no swap.
if [ -z "$(swapon --show)" ]; then
  echo "== adding a 2 GB swap file"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Only SSH, HTTP (certificates + redirect) and HTTPS from outside.
if command -v ufw >/dev/null 2>&1; then
  echo "== firewall before:"; sudo ufw status verbose || true
  sudo ufw allow OpenSSH
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw --force enable
  echo "== firewall after:"; sudo ufw status verbose
fi

docker --version; docker compose version
echo "== ready"
