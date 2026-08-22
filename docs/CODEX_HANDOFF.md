# Codex Handoff: LOFT HALL Internship Unified

This file is a compact handoff for future Codex turns. It is not a secret store. Do not put bot tokens or private `.env` values here.

## Current Production

- Project: `loft_hall_internship_unified`
- GitHub: `https://github.com/xk369/lh-stazhirovka`
- Production URL: `https://stazhirovka.151.244.243.164.sslip.io`
- Server: `roma@151.244.243.164`
- Server path: `/opt/loft-hall-internship-unified`
- Docker container: `loft-internship-unified`
- Notification worker container: `loft-internship-notification-worker`
- Host port: `127.0.0.1:3500 -> 3000`
- To check the currently deployed commit: `cd /opt/loft-hall-internship-unified && git rev-parse --short HEAD`
- Production now runs PostgreSQL storage:
  `BOOKING_STORAGE_MODE=postgres`, `bookingStorageWritable=true`,
  `TELEGRAM_DELIVERY_MODE=live`.
- Telegram report delivery is asynchronous in PostgreSQL mode. `/api/report`
  writes `notifications` outbox rows; the notification worker service must be
  running or reports/status messages will stay `pending`.
- During the 2026-08-22 worker enablement, old personal trainee backlog was
  intentionally protected with `NOTIFICATION_WORKER_CREATED_AFTER` so stale
  personal messages are not sent automatically. Mentor report group backlog was
  manually flushed first.

## Current Migration Work

- Local worktree:
  `Helper_bot/loft_hall_internship_unified_migration_integrate`
- Branch: `migration/postgres-foundation`
- This branch is the current production branch after the approved PostgreSQL
  cutover. Do not assume production is on `main` or JSON storage.
- PostgreSQL schema/import/runtime tools require an explicit `DATABASE_URL`.
- `BOOKING_STORAGE_MODE=json` remains the local fallback default.
  `postgres_readonly` rejects writes with `503 BOOKING_STORAGE_READ_ONLY`.
  `postgres` routes `/api/state`, `/api/report` and `/api/telegram/link`
  through the PostgreSQL command adapter and `notifications` outbox.
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
- 2026-08-05 local verification after merging the latest production
  queue-assignment flow into the migration branch: `node --check` passed for the
  new/changed PostgreSQL smoke scripts, `bash -n scripts/test-postgres-foundation.sh`
  passed, `npm test` passed 309/309, `git diff --cached --check` passed. A
  sandboxed `npm run test:postgres` failed at local PostgreSQL startup with the
  same `shmget Operation not permitted`; outside-sandbox rerun was not executed
  in this session.
- On 2026-07-30 migration staging imported a fresh production snapshot:
  16 shifts, 83 applications, 37 invite groups, 39 memberships and
  25 mentor reports. Field-level parity passed before writable staging QA.
- Migration staging is deployed at
  `https://stazhirovka-migration.151.244.243.164.sslip.io` from commit
  `bae4e07`, server path `/opt/loft-hall-internship-migration-staging`.
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
  latest run also checked `/api/telegram/link` against a synthetic unlinked
  application.
- Staging notification worker dry-run processed accumulated QA outbox rows
  without real Telegram delivery. Latest run after `bae4e07`: 3 claimed,
  0 sent, 3 skipped, 0 failed.
- Branch `migration/postgres-foundation` is published in draft PR #3. Do not
  merge it into `main` until writable staging QA, cutover rehearsal and rollback
  plan are approved.
- Local `migration/postgres-foundation` now contains the newer production
  queue-assignment features and PostgreSQL support for
  `application_assignment_offers`; migration staging is still at `bae4e07`
  until explicitly refreshed.
- Current migration progress is 100% for the internship production cutover, but
  operational fixes must keep the outbox worker running and monitored.

## Staging / Manual Copy

Use the server copy for non-urgent product changes before touching production.

- Staging URL: `https://stazhirovka-manual.151.244.243.164.sslip.io`
- Server path: `/opt/loft-hall-internship-unified-manual`
- Docker container: `loft-internship-unified-manual`
- Host port: `127.0.0.1:3501 -> 3000`
- Preferred flow: create a feature branch locally, push it to GitHub, switch the staging copy to that branch, rebuild staging, test there, then merge/deploy production only after user approval.
- Keep staging data close to production for realistic checks: before testing, back up `/opt/loft-hall-internship-unified-manual/data/db.json` and copy `/opt/loft-hall-internship-unified/data/db.json` into the manual copy.
- Keep `SUPPRESS_TRAINEE_NOTIFICATIONS=yes` in the staging `.env` when using real production trainee data. This allows recruiter/mentor flow testing without sending personal Telegram notifications to trainees.
- Queue assignment flow: trainees do not see public free dates and can only enter `queue`. Recruiter sends a 1-hour assignment confirmation request from the queue; trainee `Да` moves the application to `confirmed`, `Нет` keeps it in `queue`, and timeout moves it to `queue_expired` so the active queue seat hold is released. A trainee can withdraw back to `queue` before or after workgroup invite; `RECRUITER_WITHDRAWAL_CHAT_ID` receives a service notification.

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
- `scripts/postgres-assignment-offer-write-smoke.js` - live PostgreSQL smoke for
  queue comments, assignment offers, accept/decline/expiry and trainee
  withdrawal back to queue.
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
- `scripts/run-postgres-notification-worker.js` - long-running worker process
  used by the production Compose worker service.
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
git merge --ff-only origin/migration/postgres-foundation
docker compose up -d --build
curl -fsS http://127.0.0.1:3500/api/health
docker compose ps
```
