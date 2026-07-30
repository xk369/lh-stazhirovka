# Migration Staging Deployment

This contour is separate from:

- production: port `3500`;
- mentor-manual staging: port `3501`;
- migration staging: port `3502`.

Current deployment:

- URL: `https://stazhirovka-migration.151.244.243.164.sslip.io`;
- server path: `/opt/loft-hall-internship-migration-staging`;
- branch: `migration/postgres-foundation`;
- last verified commit: `fe321f0`.

Production must not be stopped, rebuilt or connected to this PostgreSQL
database.

## Safety properties

- independent project directory and Docker Compose project;
- independent PostgreSQL container and named volume;
- no host PostgreSQL port;
- application port is bound only to `127.0.0.1:3502`;
- `TELEGRAM_DELIVERY_MODE=dry_run` is forced by Compose;
- `BOOKING_STORAGE_MODE=postgres` is forced by Compose;
- booking-state operations write only to the dedicated migration-staging
  PostgreSQL database;
- report and notification requests can run through validation and outbox
  creation in `dry_run`, but cannot deliver anything to Telegram;
- no automatic fallback from PostgreSQL to JSON.

## First deployment

Run from the migration-staging project directory:

```bash
cp .env.migration-staging.example .env.migration-staging
chmod 600 .env.migration-staging
```

Fill real bot/auth values and one unique PostgreSQL password. Keep the two
password occurrences identical. Never commit this file.

Copy production state without modifying it:

```bash
mkdir -p migration-source
cp /opt/loft-hall-internship-unified/data/db.json migration-source/db.json
chmod 600 migration-source/db.json
```

Start only PostgreSQL and build the application image:

```bash
docker compose -f deploy/docker-compose.migration-staging.yml up -d postgres-migration-staging
docker compose -f deploy/docker-compose.migration-staging.yml build app-migration-staging
```

Apply the schema, import the copied JSON and verify field-level parity:

```bash
docker compose -f deploy/docker-compose.migration-staging.yml run --rm app-migration-staging npm run db:migrate
docker compose -f deploy/docker-compose.migration-staging.yml run --rm \
  -v "$PWD/migration-source:/migration-source:ro" \
  app-migration-staging npm run db:import-json -- --source /migration-source/db.json
docker compose -f deploy/docker-compose.migration-staging.yml run --rm \
  -v "$PWD/migration-source:/migration-source:ro" \
  app-migration-staging npm run db:verify-parity -- --source /migration-source/db.json
```

Only after parity succeeds:

```bash
docker compose -f deploy/docker-compose.migration-staging.yml up -d app-migration-staging
curl -fsS http://127.0.0.1:3502/api/health
```

Expected health fields:

```json
{
  "telegramDeliveryMode": "dry_run",
  "bookingStorageMode": "postgres",
  "bookingStorageWritable": true
}
```

## Last verified QA

2026-07-30:

- refreshed the dedicated migration-staging PostgreSQL volume from a current
  production `data/db.json` copy;
- parity passed for 16 shifts, 83 applications, 37 invite groups,
  39 invite-group members and 25 mentor reports;
- `/api/health` returned `BOOKING_STORAGE_MODE=postgres`,
  `bookingStorageWritable=true` and `TELEGRAM_DELIVERY_MODE=dry_run`;
- `scripts/postgres-staging-role-qa.js` passed against the live staging HTTP
  runtime;
- `scripts/process-postgres-notifications.js` processed the accumulated QA
  outbox in dry-run mode: 6 claimed, 0 sent, 6 skipped, 0 failed.

This QA used synthetic staging-only applications and did not send real Telegram
messages.

## Refreshing production data

Do not import over an existing database. Create a PostgreSQL dump for
diagnostics, then recreate only the migration-staging volume or use a new
versioned volume. Never remove or modify production volumes.

The copied `migration-source/db.json` contains PII. Keep mode `0600`, do not
commit it, and delete it when the verification cycle is complete.
