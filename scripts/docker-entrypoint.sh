#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Waiting for database to be ready..."
  ATTEMPTS=0
  MAX_ATTEMPTS=${DB_WAIT_MAX_ATTEMPTS:-60}
  SLEEP_SECONDS=${DB_WAIT_SLEEP_SECONDS:-2}

  until node -e "const { Pool } = require('pg'); const pool = new Pool({ connectionString: process.env.DATABASE_URL }); pool.query('select 1').then(() => pool.end()).then(() => process.exit(0)).catch(() => process.exit(1));"; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
      echo "Database not reachable after $MAX_ATTEMPTS attempts"
      exit 1
    fi
    sleep "$SLEEP_SECONDS"
  done

  echo "Applying database migrations..."
  pnpm db:migrate
fi

echo "Starting HealthAge backend..."
exec pnpm exec tsx src/server.ts
