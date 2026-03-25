#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

ACTION="${1:-start}"

start_studio() {
  if docker compose --profile tools up -d studio; then
    return 0
  fi

  echo "Studio failed to start. Trying self-heal for stale container/network..."
  docker rm -f healthage-backend-studio >/dev/null 2>&1 || true
  docker compose up -d postgres
  docker compose --profile tools up -d --force-recreate studio
}

case "$ACTION" in
  start)
    start_studio
    docker compose --profile tools ps
    ;;
  stop)
    docker compose --profile tools stop studio
    ;;
  restart)
    docker rm -f healthage-backend-studio >/dev/null 2>&1 || true
    docker compose up -d postgres
    docker compose --profile tools up -d --force-recreate studio
    docker compose --profile tools ps
    ;;
  logs)
    docker compose --profile tools logs -f studio
    ;;
  status)
    docker compose --profile tools ps
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|logs|status}"
    exit 1
    ;;
esac
