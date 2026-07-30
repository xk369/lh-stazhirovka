#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEFAULT_SOURCE_PATH="${PROJECT_DIR}/test/fixtures/booking-state-postgres.json"
SOURCE_PATH="${1:-${DEFAULT_SOURCE_PATH}}"
PG_TEST_PORT="${PG_TEST_PORT:-35439}"
PG_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loft-internship-pg.XXXXXX")"
PG_DATA_DIR="${PG_TEST_DIR}/data"
PG_DATABASE="loft_internship_test"
PG_URL="postgres://postgres@127.0.0.1:${PG_TEST_PORT}/${PG_DATABASE}"

if [[ ! -f "${SOURCE_PATH}" ]]; then
  echo "Booking state source does not exist: ${SOURCE_PATH}" >&2
  exit 1
fi

cleanup() {
  if [[ -f "${PG_DATA_DIR}/postmaster.pid" ]]; then
    pg_ctl -D "${PG_DATA_DIR}" -m fast -w stop >/dev/null
  fi
  rm -rf "${PG_TEST_DIR}"
}
trap cleanup EXIT

initdb -D "${PG_DATA_DIR}" -A trust -U postgres --no-locale >/dev/null
pg_ctl \
  -D "${PG_DATA_DIR}" \
  -o "-p ${PG_TEST_PORT} -h 127.0.0.1 -k ${PG_TEST_DIR}" \
  -w start >/dev/null
createdb -h 127.0.0.1 -p "${PG_TEST_PORT}" -U postgres "${PG_DATABASE}"

cd "${PROJECT_DIR}"
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable npm run db:migrate
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  npm run db:import-json -- --source "${SOURCE_PATH}"
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  npm run db:verify-parity -- --source "${SOURCE_PATH}"
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable npm run db:migrate
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  PG_READONLY_TEST_PORT="$((PG_TEST_PORT + 1))" \
  node scripts/postgres-readonly-runtime-smoke.js

if [[ "${SOURCE_PATH}" == "${DEFAULT_SOURCE_PATH}" ]]; then
  psql "${PG_URL}" -v ON_ERROR_STOP=1 -Atc "
    SELECT
      (SELECT count(*) FROM shifts),
      (SELECT count(*) FROM applications),
      (SELECT count(*) FROM invite_groups),
      (SELECT count(*) FROM invite_group_members),
      (SELECT count(*) FROM mentor_reports),
      (SELECT count(*) FROM application_events);
  " | grep -qx "1|2|1|2|1|2"
fi

DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-create-shift-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-toggle-shift-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-upsert-trainee-application-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-cancel-application-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-update-shift-capacity-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-update-comment-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-set-application-status-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-assign-shift-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-send-invites-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-cancel-internship-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-return-to-queue-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-cancel-shift-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-step-back-application-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-mark-experienced-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-mentor-report-result-write-smoke.js
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  node scripts/postgres-admin-state-write-smoke.js

if DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  npm run db:import-json -- --source "${SOURCE_PATH}" \
  >"${PG_TEST_DIR}/second-import.log" 2>&1; then
  echo "Second JSON import unexpectedly succeeded." >&2
  exit 1
fi

grep -q "PostgreSQL import target is not empty" "${PG_TEST_DIR}/second-import.log"
echo "PostgreSQL foundation integration test passed."
