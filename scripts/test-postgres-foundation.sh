#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_TEST_PORT="${PG_TEST_PORT:-35439}"
PG_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/loft-internship-pg.XXXXXX")"
PG_DATA_DIR="${PG_TEST_DIR}/data"
PG_DATABASE="loft_internship_test"
PG_URL="postgres://postgres@127.0.0.1:${PG_TEST_PORT}/${PG_DATABASE}"

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
  npm run db:import-json -- --source "${PROJECT_DIR}/test/fixtures/booking-state-postgres.json"
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  npm run db:verify-parity -- --source "${PROJECT_DIR}/test/fixtures/booking-state-postgres.json"
DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable npm run db:migrate

psql "${PG_URL}" -v ON_ERROR_STOP=1 -Atc "
  SELECT
    (SELECT count(*) FROM shifts),
    (SELECT count(*) FROM applications),
    (SELECT count(*) FROM invite_groups),
    (SELECT count(*) FROM invite_group_members),
    (SELECT count(*) FROM mentor_reports),
    (SELECT count(*) FROM application_events);
" | grep -qx "1|2|1|2|1|2"

if DATABASE_URL="${PG_URL}" POSTGRES_SSL_MODE=disable \
  npm run db:import-json -- --source "${PROJECT_DIR}/test/fixtures/booking-state-postgres.json" \
  >"${PG_TEST_DIR}/second-import.log" 2>&1; then
  echo "Second JSON import unexpectedly succeeded." >&2
  exit 1
fi

grep -q "PostgreSQL import target is not empty" "${PG_TEST_DIR}/second-import.log"
echo "PostgreSQL foundation integration test passed."
