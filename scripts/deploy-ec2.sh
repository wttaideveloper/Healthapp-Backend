#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

if [[ ! -f ".env" ]]; then
  echo ".env file not found in ${PROJECT_ROOT}. Create it before deploying."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. Run ./scripts/install-ec2.sh first."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose plugin is missing. Run ./scripts/install-ec2.sh first."
  exit 1
fi

echo "Building and starting containers..."
docker compose up -d --build

CONFIGURE_NGINX="${CONFIGURE_NGINX:-false}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-ha.wisdomtooth.tech}"

if [[ "$CONFIGURE_NGINX" == "true" ]]; then
  if [[ -x "./scripts/configure-nginx-ec2.sh" ]]; then
    ./scripts/configure-nginx-ec2.sh "${NGINX_SERVER_NAME}"
  else
    echo "scripts/configure-nginx-ec2.sh is missing or not executable."
    exit 1
  fi
fi

echo "Container status:"
docker compose ps

echo "Recent app logs:"
docker compose logs --tail=80 app || true

echo "Deployment complete."
echo "Local health check: curl http://127.0.0.1:8091/api/v1/health"
echo "Public health check (domain): curl http://${NGINX_SERVER_NAME}/api/v1/health"
echo "Tip: first-time domain setup: ./scripts/configure-nginx-ec2.sh ${NGINX_SERVER_NAME}"
