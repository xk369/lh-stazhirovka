# Migration Delivery Scoreboard

Этот файл нужен для практического контроля прогресса. Процент растет только
после того, как работа интегрирована в `migration/postgres-foundation`, прошла
тестовый gate и не требует production deploy.

## Current Progress

- Общий прогресс: 72%.
- Production: не трогаем.
- Migration base: `migration/postgres-foundation`.
- Текущий stage: writable PostgreSQL command layer + notifications/outbox.

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
- `send_invites` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `shifts` row `FOR UPDATE`;
  - selected `applications` rows `FOR UPDATE`, ordered by `legacy_id`;
  - optimistic `baseVersion` check;
  - accepts only selected applications on that shift in `status=confirmed`;
  - validates Telegram group links;
  - creates `invite_groups` and `invite_group_members`;
  - updates selected applications to `status=invited` with venue/group link;
  - writes `invite_group_sent` and `application_invited` events;
  - writes one durable `notifications` row per selected trainee in the same
    transaction;
  - uses `status='pending'` when a Telegram target exists;
  - uses explicit `status='skipped'` + `telegram_chat_missing` when the trainee
    has no Telegram target;
  - uses stable idempotency keys and `ON CONFLICT (idempotency_key) DO NOTHING`;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `cancel_internship` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - linked `invite_groups` row `FOR UPDATE` when present;
  - optimistic `baseVersion` check;
  - accepts only pre-attendance statuses:
    `pending`, `confirmed`, `invited`;
  - returns the application to preliminary queue with `status=queue`;
  - clears shift, invite group, venue, group link, candidate report and mentor
    result/delivery fields on the application;
  - removes the application from `invite_group_members`;
  - deletes the invite group when that application was the last member;
  - writes `invite_group_updated` or `invite_group_removed` plus
    `internship_cancelled` events;
  - writes one durable trainee `notifications` row in the same transaction;
  - uses `status='pending'` when a Telegram target exists;
  - uses explicit `status='skipped'` + `telegram_chat_missing` when the trainee
    has no Telegram target;
  - uses stable idempotency keys and `ON CONFLICT (idempotency_key) DO NOTHING`;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `cancel_shift` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `shifts` row `FOR UPDATE`;
  - affected pre-attendance `applications` rows `FOR UPDATE`, ordered by
    `legacy_id`;
  - linked `invite_groups` rows `FOR UPDATE` when affected trainees belong to
    groups;
  - optimistic `baseVersion` check;
  - cancels the shift with `open=false`, `canceled=true` and `canceled_at`;
  - returns only pre-attendance applications (`pending`, `confirmed`,
    `invited`) to preliminary queue;
  - leaves post-attendance applications (`feedback`, `passed`, `failed`,
    `noshow`) attached for history/result visibility, matching JSON runtime
    behavior;
  - clears shift, invite group, venue, group link, candidate report and mentor
    result/delivery fields on affected applications;
  - removes affected applications from `invite_group_members`;
  - updates invite groups that still have remaining members and deletes groups
    that become empty;
  - writes `shift_cancelled`, `invite_group_updated` or
    `invite_group_removed`, and one `internship_cancelled` event per affected
    application;
  - writes one durable trainee `notifications` row per affected application in
    the same transaction;
  - uses `status='pending'` when a Telegram target exists;
  - uses explicit `status='skipped'` + `telegram_chat_missing` when the trainee
    has no Telegram target;
  - uses stable idempotency keys and `ON CONFLICT (idempotency_key) DO NOTHING`;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `step_back_application` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - uses shared `BOOKING_STEP_BACK_STATUSES`;
  - supports `passed -> feedback`, `failed -> feedback`,
    `feedback -> invited`, and `noshow -> invited`;
  - voids the active `mentor_reports` row when a final result is rolled back;
  - clears mentor-result, mentor-delivery and `experience` fields when rolling
    back a final result;
  - writes `application_step_back` event;
  - writes one durable trainee `booking_stage_changed` notification row in the
    same transaction;
  - uses `status='pending'` when a Telegram target exists;
  - uses explicit `status='skipped'` + `telegram_chat_missing` when the trainee
    has no Telegram target;
  - uses stable idempotency keys and `ON CONFLICT (idempotency_key) DO NOTHING`;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `mark_experienced` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - accepts only applications with `status='passed'`;
  - sets `experience='experienced'`;
  - writes `experienced_marked` event;
  - returns an idempotent no-op when the trainee is already marked experienced;
  - no trainee notification/outbox write, because this is a recruiter-owned
    internal experience flag rather than a trainee-facing stage change;
  - version bump only when the flag changes;
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

1. `return_to_queue`
2. `update_comment`
3. `upsert_trainee_application`
4. `cancel_application`
5. `toggle_shift`
6. `clear_state`
7. `reset_demo_state`
8. `mentor_report_result` через `/api/report`

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
- PostgreSQL `send_invites` now writes durable `notifications` rows, but there
  is still no worker that claims pending rows and marks delivery as `sent`,
  `failed` or `skipped`. Do not wire writable Postgres into runtime until the
  worker/dry-run policy is implemented and tested.

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

Claude: paused/exhausted. If Claude is reintroduced, give it the next single
command work package, not the already completed `send_invites` outbox slice.

Codex: continue from `migration/postgres-foundation`; next recommended command
slice is `return_to_queue`, then `update_comment`.
