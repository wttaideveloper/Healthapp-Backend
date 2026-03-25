#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a regular user (not root). It will use sudo when required."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

DOMAIN="${1:-${NGINX_SERVER_NAME:-ha.wisdomtooth.tech}}"
ENABLE_SSL="${ENABLE_SSL:-false}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-}"

if [[ -z "${DOMAIN}" ]]; then
  echo "Domain is required. Usage: $0 <domain>"
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "nginx is not installed. Run ./scripts/install-ec2.sh first."
  exit 1
fi

echo "Writing nginx reverse proxy config for ${DOMAIN}..."
sudo tee /etc/nginx/conf.d/healthage.conf >/dev/null <<NGINX
server {
  listen 80;
  server_name ${DOMAIN};

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

echo "Nginx configured."
echo "HTTP health check: curl http://${DOMAIN}/api/v1/health"

if [[ "${ENABLE_SSL}" == "true" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    echo "certbot is not installed. Run ./scripts/install-ec2.sh first."
    exit 1
  fi

  if [[ -z "${LETSENCRYPT_EMAIL}" ]]; then
    echo "Set LETSENCRYPT_EMAIL when ENABLE_SSL=true."
    exit 1
  fi

  echo "Requesting Let's Encrypt certificate for ${DOMAIN}..."
  sudo certbot --nginx \
    --non-interactive \
    --agree-tos \
    -m "${LETSENCRYPT_EMAIL}" \
    -d "${DOMAIN}" \
    --redirect

  echo "HTTPS enabled."
  echo "HTTPS health check: curl https://${DOMAIN}/api/v1/health"
fi

