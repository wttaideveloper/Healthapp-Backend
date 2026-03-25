#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a regular user (not root). It will use sudo when required."
  exit 1
fi

if [[ ! -f /etc/os-release ]]; then
  echo "Unsupported OS: /etc/os-release not found"
  exit 1
fi

source /etc/os-release

install_amazon_linux() {
  sudo dnf update -y
  sudo dnf install -y docker git nginx curl
  sudo systemctl enable docker
  sudo systemctl start docker
  sudo systemctl enable nginx
  sudo systemctl start nginx

  # certbot packages are optional; install when available
  sudo dnf install -y certbot python3-certbot-nginx || true
}

install_ubuntu() {
  sudo apt update
  sudo apt upgrade -y
  sudo apt install -y docker.io docker-compose-plugin git nginx curl
  sudo systemctl enable docker
  sudo systemctl start docker
  sudo systemctl enable nginx
  sudo systemctl start nginx

  sudo apt install -y certbot python3-certbot-nginx || true
}

case "${ID:-}" in
  amzn)
    echo "Detected Amazon Linux (${VERSION_ID:-unknown})"
    install_amazon_linux
    ;;
  ubuntu)
    echo "Detected Ubuntu (${VERSION_ID:-unknown})"
    install_ubuntu
    ;;
  *)
    echo "Unsupported distro: ${ID:-unknown}. Supported: amzn, ubuntu"
    exit 1
    ;;
esac

if ! groups "${USER}" | grep -q '\bdocker\b'; then
  sudo usermod -aG docker "${USER}"
  echo "Added ${USER} to docker group. Re-login (or run 'newgrp docker') before using docker without sudo."
fi

echo "Installation complete."
echo "Next steps:"
echo "1) Re-login (or: newgrp docker)"
echo "2) cd your repo"
echo "3) git pull"
echo "4) ./scripts/deploy-ec2.sh"
