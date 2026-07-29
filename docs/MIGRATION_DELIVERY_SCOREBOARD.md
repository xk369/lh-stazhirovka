# Migration Delivery Scoreboard

Этот файл нужен для практического контроля прогресса. Процент растет только
после того, как работа интегрирована в `migration/postgres-foundation`, прошла
тестовый gate и не требует production deploy.

## Current Progress

- Общий прогресс: 50%.
- Production: не трогаем.
- Migration base: `migration/postgres-foundation`.
- Текущий stage: writable PostgreSQL command layer.

## Что Уже Интегрировано В Base

- PostgreSQL schema/import/read-only parity.
- Migration staging с `BOOKING_STORAGE_MODE=postgres_readonly`.
- Telegram dry-run delivery gateway.
- `application_events` planning/writer foundation.
- Storage adapter seam.
- Transaction helper.
- `create_shift` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - optimistic `baseVersion` check;
  - duplicate/past date validation;
  - Europe/Moscow date boundary;
  - `shifts` insert;
  - `shift_created` event;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- PR safety check.
- PostgreSQL command contracts.

## Gate Для Каждой Следующей Команды

Команда считается готовой только если:

- реализована в Postgres write layer;
- подключена в storage adapter, но не подключена к production runtime;
- есть unit tests на success, validation, conflict и rollback/release;
- есть live PostgreSQL smoke или покрытие в `npm run test:postgres`;
- `npm test` проходит;
- `npm run test:postgres` проходит;
- `git diff --check` проходит;
- `scripts/check-migration-pr-safety.js` не находит forbidden changes;
- есть короткая запись в `docs/CODEX_PROGRESS.md`.

## Очередь Writable Команд

1. `update_shift_capacity`
2. `set_application_status`
3. `assign_shift`
4. `send_invites`
5. `cancel_internship`
6. `cancel_shift`
7. `step_back_application`
8. `mark_experienced`
9. `return_to_queue`
10. `update_comment`
11. `upsert_trainee_application`
12. `cancel_application`
13. `toggle_shift`
14. `clear_state`
15. `reset_demo_state`
16. `mentor_report_result` через `/api/report`

## Two-Agent Rules

- Codex owns architecture, merge decisions, migration percent and production
  safety.
- Claude implements one scoped command per branch and ends with
  `Report For Codex Review`.
- Side branches do not count as progress until Codex merges them into
  `migration/postgres-foundation` and reruns gates.
- Claude must not change strategy docs, progress percent, production deploy,
  `main`, Telegram routing or runtime secrets.
- Codex must not let side branches pile up without integration.

## Next Concrete Step

Claude: implement `update_shift_capacity` in a branch based on current
`migration/postgres-foundation`.

Codex: review, merge into `migration/postgres-foundation`, run full gates, then
raise progress only if the command is integrated and tested.
