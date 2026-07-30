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

- Local worktree:
  `Helper_bot/loft_hall_internship_unified_migration_integrate`
- Branch: `migration/postgres-foundation`
- This branch is not deployed to production.
- Production still reads and writes only `data/db.json`.
- PostgreSQL schema/import/runtime tools are isolated and require an explicit
  `DATABASE_URL`.
- `BOOKING_STORAGE_MODE=json` is the production-safe default.
  `postgres_readonly` is allowed for read-only migration staging and rejects
  writes with `503 BOOKING_STORAGE_READ_ONLY`.
- `postgres` is now implemented for migration staging only: `/api/state` and
  `/api/report` route through the PostgreSQL command adapter and the
  `notifications` outbox; `/api/telegram/link` also routes through the
  PostgreSQL command adapter in writable Postgres mode for old/unlinked
  application identity binding. It must be combined with
  `TELEGRAM_DELIVERY_MODE=dry_run` until production cutover is explicitly
  planned.
- Current migration-staging Compose forces `BOOKING_STORAGE_MODE=postgres`,
  `TELEGRAM_DELIVERY_MODE=dry_run`, `TELEGRAM_POLLING=no` and
  `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`.
- Last local verification: `node --check src/server.js
  src/postgres/write-booking-command.js
  scripts/postgres-link-telegram-application-write-smoke.js
  scripts/postgres-staging-role-qa.js`, `npm test -- --test-reporter=dot`,
  `npm run test:postgres` and `git diff --check` passed on 2026-07-30 after
  adding the PostgreSQL `/api/telegram/link` command route.
  The sandboxed `test:postgres` run fails on local PostgreSQL shared memory
  (`shmget Operation not permitted`); the same command passes outside the
  sandbox.
- On 2026-07-30 migration staging imported a fresh production snapshot:
  16 shifts, 83 applications, 37 invite groups, 39 memberships and
  25 mentor reports. Field-level parity passed before writable staging QA.
- Migration staging is deployed at
  `https://stazhirovka-migration.151.244.243.164.sslip.io`; before the final
  `/api/telegram/link` deploy it was at commit `9f304d0`, server path
  `/opt/loft-hall-internship-migration-staging`.
- Its app is bound to `127.0.0.1:3502`; containers are
  `loft-internship-app-migration-staging` and
  `loft-internship-postgres-migration-staging`; PostgreSQL uses the dedicated
  `loft-internship-postgres-migration-staging-data` volume.
- Server smoke checks proved writable staging health:
  `BOOKING_STORAGE_MODE=postgres`, `bookingStorageWritable=true` and
  `TELEGRAM_DELIVERY_MODE=dry_run`.
- Live staging role QA passed through HTTP runtime: synthetic trainee
  application, recruiter confirmation, invite creation, attendance to
  `feedback`, mentor report finalization, final status `passed`, and durable
  outbox rows for `send_invites`, `mentor_report` and `mentor_result`. The
  next staging QA run also checks `/api/telegram/link` against a synthetic
  unlinked application.
- Staging notification worker dry-run processed accumulated QA outbox rows
  without real Telegram delivery: 6 claimed, 0 sent, 6 skipped, 0 failed.
- Branch `migration/postgres-foundation` is published in draft PR #3. Do not
  merge it into `main` until writable staging QA, cutover rehearsal and rollback
  plan are approved.
- Current migration progress is 95% overall. The remaining 5% is intentionally
  reserved for explicit production cutover and observation; do not claim 100%
  while production still runs JSON.

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
- Keep `docs/CODEX_PROGRESS.md` current during active multi-step work so future agents can resume after compaction.
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
- `scripts/postgres-staging-role-qa.js` - staging-only HTTP role QA for
  writable PostgreSQL mode with synthetic data and dry-run Telegram delivery.
- `src/postgres/read-booking-state.js` - восстанавливает текущую JSON-модель из нормализованных PostgreSQL-таблиц.
- `src/booking-storage-mode.js` - явный выбор
  `json`/`postgres_readonly`/`postgres` и стабильная ошибка запрета legacy
  direct-write in PostgreSQL modes.
- `src/booking-storage/adapter.js` - JSON/read-only/writable PostgreSQL storage
  adapter seam used by server runtime.
- `src/postgres/write-booking-command.js` - transactional PostgreSQL command
  layer for `/api/state`, `/api/report` and `/api/telegram/link`.
- `src/postgres/notification-worker.js` - PostgreSQL outbox processor for
  `notifications`.
- `src/booking-state-events.js` - plans application audit events from current/next booking state.
- `src/postgres/write-application-events.js` - writes planned audit events into PostgreSQL `application_events`.
- `deploy/docker-compose.migration-staging.yml` - отдельные app/PostgreSQL-контейнеры для read-only migration staging.
- `deploy/MIGRATION_STAGING.md` - безопасный порядок импорта, проверки и запуска staging.
- `src/report.js` - report role validation and chat routing.
- `src/telegram.js` - Telegram initData validation and Telegram send helpers.
- `test/booking-state.test.js` - state command and status-flow tests.
- `test/booking-ui.test.js` - UI structure regression checks.
- `test/mentor-report-link.test.js` - mentor report, trainee notification, and report-result tests.
- `docs/INTERNSHIP_WORKFLOW.md` - full business workflow by role.
- `docs/DATA_MODEL.md` - current JSON-state fields, API payloads, relationships, and future-edit rules.
- `docs/POSTGRES_MIGRATION_ROADMAP.md` - planned Postgres schema, event log, outbox, staging sequence, and migration order.
- `docs/CODEX_PROGRESS.md` - active worklog, current checks and next actions.

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
