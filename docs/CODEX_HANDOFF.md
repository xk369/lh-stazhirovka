# Codex Handoff: LOFT HALL Internship Unified

This file is a compact handoff for future Codex turns. It is not a secret store. Do not put bot tokens or private `.env` values here.

## Current Production

- Project: `loft_hall_internship_unified`
- GitHub: `https://github.com/xk369/lh-stazhirovka`
- Production URL: `https://stazhirovka.151.244.243.164.sslip.io`
- Server: `roma@151.244.243.164`
- Server path: `/opt/loft-hall-internship-unified`
- Docker container: `loft-internship-unified`
- Host port: `127.0.0.1:3500 -> 3000`
- To check the currently deployed commit: `cd /opt/loft-hall-internship-unified && git rev-parse --short HEAD`
- Last verified deployed commit before Postgres roadmap was added: `9930db8`

## Current Migration Work

- Local worktree: `Helper_bot/loft_hall_internship_unified_hall_sync`
- Branch: `migration/postgres-foundation`
- This branch is not deployed to production.
- Production still reads and writes only `data/db.json`.
- PostgreSQL schema/import tools are isolated and require an explicit `DATABASE_URL`.
- Last local verification: `npm test` passed 93 tests; `npm run test:postgres`
  applied the schema, imported a fixture, reconstructed booking state from
  PostgreSQL, verified field-level parity and rejected a repeated import
  against a temporary PostgreSQL 14 database.
- On 2026-07-26 the isolated importer/parity verifier passed against a fresh
  read-only copy of production state version 912: 15 shifts, 79 applications,
  35 invite groups, 37 memberships and 20 mentor reports. The temporary copy
  containing PII was deleted after the check.
- This verification did not connect PostgreSQL to the application runtime and
  did not write to the production server.

## Report Routing

Report routing is server-side only. Do not hardcode chat ids in HTML.

- Trainee reports use `TRAINEE_CHAT_ID`.
- Mentor reports use `MENTOR_CHAT_ID`.
- Last verified production values:
  - `TRAINEE_CHAT_ID=-1003951918570`
  - `MENTOR_CHAT_ID=-1001521852218`

## Core Rules

- Production is already live. Avoid broad refactors during urgent UI fixes.
- Preserve the end-to-end chain: booking -> recruiter confirmation -> workgroup invite -> attendance -> mentor report -> trainee result -> registry.
- Do not weaken Telegram `initData` verification or recruiter server-side authorization.
- Do not edit runtime `data/db.json` unless explicitly requested and backed up.
- Keep this file current. Update it in the same commit as any change to production state, deploy procedure, server path, report chat routing, or important UI/business decisions.
- Keep `docs/INTERNSHIP_WORKFLOW.md` current when the actual role flow, statuses, Telegram messages, report side effects, or recruiter/mentor/trainee actions change.
- Keep `docs/DATA_MODEL.md` current when fields, entities, validation rules, or relationships change.
- Keep `docs/POSTGRES_MIGRATION_ROADMAP.md` current while planning or implementing the Postgres/event-log migration.
- Do not start the Postgres migration directly on production. Use a fresh branch from `origin/main`, a staging copy, copied prod data, and `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`.
- `SUPPRESS_TRAINEE_NOTIFICATIONS=yes` is enforced by `src/notification-policy.js`; it skips every personal trainee delivery path, including `/api/notify` and mentor results.
- Migration staging must also set `TELEGRAM_DELIVERY_MODE=dry_run`. This blocks
  both personal notifications and reports to Telegram groups through the
  centralized `src/telegram-delivery.js` gateway. Production defaults to
  `TELEGRAM_DELIVERY_MODE=live`.
- Before each production deploy:
  - run `npm test`;
  - run `git diff --check`;
  - commit and push to `origin/main`;
  - create a server backup under `backups/deploy-YYYYMMDD-HHMMSS`;
  - pull on the server with fast-forward only;
  - rebuild with `docker compose up -d --build`;
  - check `/api/health` locally and publicly.

## Important Files

- `public/booking.html` - main booking/recruiter UI. Large file; keep edits scoped.
- `src/server.js` - backend API, state commands, Telegram notifications, report side effects.
- `src/booking-state-machine.js` - единые статусы, подписи и допустимые переходы заявки.
- `db/migrations/001_initial.sql` - первая целевая PostgreSQL-схема; прод ее пока не использует.
- `scripts/db-migrate.js` - применяет неизменяемые SQL-миграции к `DATABASE_URL`.
- `scripts/import-booking-json.js` - импортирует копию JSON в пустую PostgreSQL-БД транзакционно.
- `scripts/verify-postgres-parity.js` - читает PostgreSQL обратно и сравнивает бизнес-поля с исходным JSON.
- `src/postgres/read-booking-state.js` - восстанавливает текущую JSON-модель из нормализованных PostgreSQL-таблиц.
- `src/report.js` - report role validation and chat routing.
- `src/telegram.js` - Telegram initData validation and Telegram send helpers.
- `test/booking-state.test.js` - state command and status-flow tests.
- `test/booking-ui.test.js` - UI structure regression checks.
- `test/mentor-report-link.test.js` - mentor report, trainee notification, and report-result tests.
- `docs/INTERNSHIP_WORKFLOW.md` - full business workflow by role.
- `docs/DATA_MODEL.md` - current JSON-state fields, API payloads, relationships, and future-edit rules.
- `docs/POSTGRES_MIGRATION_ROADMAP.md` - planned Postgres schema, event log, outbox, staging sequence, and migration order.

## Recent UI Decisions

- Trainee/candidate cards should not show the old status badge stack.
- Do not show `Комментарий стажеру отправлен` in cards.
- FIO should have its own first row and not conflict with the status.
- Phone must stay visible in trainee cards near the top, under FIO.
- Current status is rendered in a separate full-width row.
- Training and internship type are visually separated as two compact tags without the header `Профиль стажировки`.

## Useful Commands

```bash
npm test
git diff --check
curl -fsS https://stazhirovka.151.244.243.164.sslip.io/api/health
```

Server deploy shape:

```bash
cd /opt/loft-hall-internship-unified
git fetch origin
git merge --ff-only origin/main
docker compose up -d --build
curl -fsS http://127.0.0.1:3500/api/health
```
