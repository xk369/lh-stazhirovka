# Migration Delivery Scoreboard

Этот файл нужен для практического контроля прогресса. Процент растет только
после того, как работа интегрирована в `migration/postgres-foundation`, прошла
тестовый gate и не требует production deploy.

## Current Progress

- Общий прогресс: 58%.
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
- `assign_shift` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - source `applications` row `FOR UPDATE`;
  - target `shifts` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - accepts only preliminary queue applications (`status=queue`,
    `shift_id IS NULL`);
  - requires target shift to be open and not canceled;
  - refuses assignment when seat-holding applications already fill all seats;
  - moves the application to the target shift with `status=pending`;
  - writes `application_status_changed` and `application_assigned_to_shift`
    events;
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

1. `send_invites`
2. `cancel_internship`
3. `cancel_shift`
4. `step_back_application`
5. `mark_experienced`
6. `return_to_queue`
7. `update_comment`
8. `upsert_trainee_application`
9. `cancel_application`
10. `toggle_shift`
11. `clear_state`
12. `reset_demo_state`
13. `mentor_report_result` через `/api/report`

## Runtime-Wiring Blockers

- The current UI action `Вернуть в новые заявки` still uses
  `set_application_status -> pending` in JSON runtime. PostgreSQL
  `set_application_status` intentionally rejects this until a dedicated command
  decides how to handle the previous invite group, venue and archive links.
  Do not wire `BOOKING_STORAGE_MODE=postgres` into `src/server.js` until this
  correction path is implemented or the UI/API is adjusted.
- PostgreSQL `assign_shift` is intentionally stricter than the legacy JSON
  helper: it only moves preliminary queue applications to open, non-canceled
  shifts. If UI/API needs to move an already assigned, confirmed or invited
  application, add a separate command that explicitly handles old shift,
  invite-group, venue and archive links before runtime cutover.

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

Claude: implement `send_invites` in a branch based on current
`migration/postgres-foundation`.

Codex: review, merge into `migration/postgres-foundation`, run full gates, then
raise progress only if the command is integrated and tested.
