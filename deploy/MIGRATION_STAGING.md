# Migration Staging Deployment

This contour is separate from:

- production: port `3500`;
- mentor-manual staging: port `3501`;
- migration staging: port `3502`.

Current deployment:

- URL: `https://stazhirovka-migration.151.244.243.164.sslip.io`;
- server path: `/opt/loft-hall-internship-migration-staging`;
- branch: `migration/postgres-foundation`.

Production must not be stopped, rebuilt or connected to this PostgreSQL
database.

## Safety properties

- independent project directory and Docker Compose project;
- independent PostgreSQL container and named volume;
- no host PostgreSQL port;
- application port is bound only to `127.0.0.1:3502`;
- `TELEGRAM_DELIVERY_MODE=dry_run` is forced by Compose;
- `BOOKING_STORAGE_MODE=postgres_readonly` is forced by Compose;
- every operation that would change booking state returns
  `503 BOOKING_STORAGE_READ_ONLY`;
- report and notification requests can still run through validation in
  `dry_run`, but cannot deliver anything to Telegram;
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
  "bookingStorageMode": "postgres_readonly",
  "bookingStorageWritable": false
}
```

## Refreshing production data

Do not import over an existing database. Create a PostgreSQL dump for
diagnostics, then recreate only the migration-staging volume or use a new
versioned volume. Never remove or modify production volumes.

The copied `migration-source/db.json` contains PII. Keep mode `0600`, do not
commit it, and delete it when the verification cycle is complete.
