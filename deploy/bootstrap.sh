#!/usr/bin/env bash
# Runs on the VPS before each deploy. Idempotent.
# - installs Docker if missing
# - creates ~/mrmod/.env with random internal secrets the first time (never overwritten, never leaves the VPS)
set -euo pipefail
HUB_DOMAIN_INPUT="${1:-}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

mkdir -p ~/mrmod && chmod 700 ~/mrmod && cd ~/mrmod

if [ ! -f .env ]; then
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "SECRETS_KEY=$(openssl rand -hex 32)"
    echo "HUB_SESSION_SECRET=$(openssl rand -hex 32)"
    echo "HUB_DOMAIN=${HUB_DOMAIN_INPUT:-$(hostname -f)}"
  } > .env
  echo "Created ~/mrmod/.env with new random secrets."
elif [ -n "$HUB_DOMAIN_INPUT" ] && ! grep -q "^HUB_DOMAIN=${HUB_DOMAIN_INPUT}$" .env; then
  sed -i "s|^HUB_DOMAIN=.*|HUB_DOMAIN=${HUB_DOMAIN_INPUT}|" .env
  echo "Updated HUB_DOMAIN to ${HUB_DOMAIN_INPUT}."
fi

# The hub's HTTPS proxy needs port 8443 (80/443 are used by the existing site).
if ! docker compose ps --services --status running 2>/dev/null | grep -qx caddy; then
  if ss -ltnH '( sport = :8443 )' | grep -q .; then
    echo "::error::Port 8443 is already used by another program on the VPS:"
    ss -ltnpH '( sport = :8443 )' || true
    exit 1
  fi
fi
# Open 8443 if ufw is active (Hostinger's panel firewall, if enabled, needs it too).
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 8443/tcp >/dev/null; fi
