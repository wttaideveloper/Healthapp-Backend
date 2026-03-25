#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

ACTION="${1:-start}"

case "$ACTION" in
  start)
    docker compose --profile tools up -d studio
    docker compose --profile tools ps
    ;;
  stop)
    docker compose --profile tools stop studio
    ;;
  restart)
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
