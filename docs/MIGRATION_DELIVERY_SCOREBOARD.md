# Migration Delivery Scoreboard

Этот файл нужен для практического контроля прогресса. Процент растет только
после того, как работа интегрирована в `migration/postgres-foundation`, прошла
тестовый gate и не требует production deploy.

## Current Progress

- Общий прогресс: 55%.
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
- `update_shift_capacity` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `shifts` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - refuses to shrink below current seat-holding applications;
  - updates `shifts.seats`, `updated_at` and `row_version`;
  - no-op when requested seats equal current seats;
  - `shift_capacity_changed` event;
  - version bump only when capacity actually changes;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `set_application_status` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - uses shared recruiter state-machine rules;
  - supports forward recruiter transitions:
    `pending -> confirmed`, `invited -> feedback`, `invited -> noshow`;
  - requires invite group data before attendance/no-show transitions;
  - auto-closes a shift when the transition makes every application final;
  - writes status and optional `shift_auto_closed` events;
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

1. `assign_shift`
2. `send_invites`
3. `cancel_internship`
4. `cancel_shift`
5. `step_back_application`
6. `mark_experienced`
7. `return_to_queue`
8. `update_comment`
9. `upsert_trainee_application`
10. `cancel_application`
11. `toggle_shift`
12. `clear_state`
13. `reset_demo_state`
14. `mentor_report_result` через `/api/report`

## Runtime-Wiring Blockers

- The current UI action `Вернуть в новые заявки` still uses
  `set_application_status -> pending` in JSON runtime. PostgreSQL
  `set_application_status` intentionally rejects this until a dedicated command
  decides how to handle the previous invite group, venue and archive links.
  Do not wire `BOOKING_STORAGE_MODE=postgres` into `src/server.js` until this
  correction path is implemented or the UI/API is adjusted.

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

Claude: implement `assign_shift` in a branch based on current
`migration/postgres-foundation`.

Codex: review, merge into `migration/postgres-foundation`, run full gates, then
raise progress only if the command is integrated and tested.
