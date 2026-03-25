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

CONFIGURE_NGINX="${CONFIGURE_NGINX:-true}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-_}"

if [[ "$CONFIGURE_NGINX" == "true" ]] && command -v nginx >/dev/null 2>&1; then
  echo "Configuring nginx reverse proxy (server_name: ${NGINX_SERVER_NAME})..."
  sudo tee /etc/nginx/conf.d/healthage.conf >/dev/null <<NGINX
server {
  listen 80;
  server_name ${NGINX_SERVER_NAME};

  location / {
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
  }
}
NGINX

  sudo rm -f /etc/nginx/conf.d/default.conf
  sudo nginx -t
  sudo systemctl reload nginx
fi

echo "Container status:"
docker compose ps

echo "Recent app logs:"
docker compose logs --tail=80 app || true

echo "Deployment complete."
echo "Local health check: curl http://127.0.0.1:8091/api/v1/health"
if [[ "$CONFIGURE_NGINX" == "true" ]]; then
  echo "Public health check: curl http://<EC2_PUBLIC_IP>/api/v1/health"
fi
