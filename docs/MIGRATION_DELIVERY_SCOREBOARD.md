# Migration Delivery Scoreboard

Этот файл нужен для практического контроля прогресса. Процент растет только
после того, как работа интегрирована в `migration/postgres-foundation`, прошла
тестовый gate и не требует production deploy.

## Current Progress

- Общий прогресс: 95%.
- Production: не трогаем.
- Migration base: `migration/postgres-foundation`.
- Текущий stage: notification worker complete; staging-only writable runtime
  wiring and QA next.

## Что Уже Интегрировано В Base

- PostgreSQL schema/import/read-only parity.
- Migration staging с `BOOKING_STORAGE_MODE=postgres_readonly`.
- Telegram dry-run delivery gateway.
- `application_events` planning/writer foundation.
- Storage adapter seam.
- Transaction helper.
- `upsert_trainee_application` writable PostgreSQL command:
  - trainee-only;
  - `booking_state_meta FOR UPDATE`;
  - optional target `shifts` row `FOR UPDATE` for date bookings;
  - existing `applications` row `FOR UPDATE` when updating a previous trainee
    application;
  - optimistic `baseVersion` check;
  - validates required trainee profile fields, phone, training date for
    passed training, attempt and trainee-writable statuses;
  - attaches Telegram user/chat/username from the verified actor, never from
    client-supplied payload;
  - enforces `queue` applications without `shift_id` and `pending`
    applications with an open, non-canceled shift;
  - refuses to book closed/canceled/full shifts;
  - rejects updates to another trainee's application;
  - rejects updates once the application has progressed beyond `pending` or
    `queue`; repeat application after `failed`/`noshow` should use the existing
    frontend behavior of creating a new application id, preserving old reports
    and history;
  - inserts or updates `applications`;
  - clears stale invite/mentor/result fields on update so a preliminary
    trainee-side edit cannot carry old workflow state forward;
  - writes PII-safe `application_created`, `application_updated`,
    `application_status_changed`, `application_assigned_to_shift` and
    `application_returned_to_queue` events as needed;
  - no trainee notification/outbox write, because this is a trainee-owned form
    submission/update rather than a recruiter/mentor stage message;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `cancel_application` writable PostgreSQL command:
  - trainee/recruiter;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - trainees can delete only their own application;
  - accepts only early `pending`/`queue` applications before invite/mentor side
    effects exist;
  - rejects progressed statuses, invite-group links and mentor-result state so
    history is not silently erased by the simple delete command;
  - writes `application_cancelled` before deleting the row, preserving legacy
    identifiers in event payload after `application_events.application_id`
    becomes `NULL` through `ON DELETE SET NULL`;
  - deletes the `applications` row;
  - no trainee notification/outbox write, because this is the trainee-owned
    cancellation action before confirmation/invite; recruiter-facing
    cancellation with trainee message remains `cancel_internship`;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
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
- `toggle_shift` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `shifts` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - supports explicit `open=true/false` and implicit toggle when `open` is not
    supplied;
  - closes a date without marking it canceled;
  - reopens a date and clears `canceled/canceled_at`, matching JSON runtime
    behavior;
  - writes `shift_closed` or `shift_opened` audit events;
  - returns an idempotent no-op when requested `open` state is already current;
  - version bump only when `open` actually changes;
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
  - writes durable `shift_capacity_changed` notification/outbox rows for
    trainees on that date in upcoming statuses `pending`, `confirmed` and
    `invited`;
  - excludes `feedback`/final/no-show trainees from capacity-change
    notifications because their internship already moved past the date-change
    stage;
  - uses explicit `status='skipped'` + `telegram_chat_missing` when the trainee
    has no Telegram target;
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
- `return_to_queue` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - linked `invite_groups` row `FOR UPDATE` when present;
  - optimistic `baseVersion` check;
  - accepts only `queue`, `pending`, `confirmed` and `invited` applications;
  - rejects post-attendance/final statuses so mentor results and history are not
    silently erased;
  - returns the application to preliminary queue with `status='queue'`;
  - clears shift, invite group, venue, group link, candidate-report and mentor
    result/delivery fields;
  - removes the application from `invite_group_members`;
  - updates the previous invite group timestamp or deletes the group when it
    becomes empty;
  - writes invite-group cleanup events plus `application_returned_to_queue`;
  - returns an idempotent no-op for an already clean queue application;
  - intentionally does not write a trainee notification/outbox row because this
    is an internal recruiter correction path;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `update_comment` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - optimistic `baseVersion` check;
  - trims comments the same way as the server JSON normalizer;
  - rejects comments over 1200 characters;
  - updates `applications.recruiter_comment`;
  - writes `application_comment_updated` with previous/new comment lengths only,
    avoiding raw recruiter-comment PII in event payloads;
  - returns an idempotent no-op when the trimmed comment is unchanged;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `clear_state` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - optimistic `baseVersion` check;
  - deletes booking rows, invite group links, mentor report rows/topics and
    pending notification rows so a destructive reset cannot leave stale side
    effects behind;
  - preserves `application_events` audit history;
  - writes `booking_state_cleared` with removed row counts;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `reset_demo_state` writable PostgreSQL command:
  - recruiter-only;
  - `booking_state_meta FOR UPDATE`;
  - optimistic `baseVersion` check;
  - performs the same safe cleanup as `clear_state`;
  - seeds a normalized three-shift/three-application demo state through the
    existing JSON import planner rather than hand-building invalid rows;
  - writes `booking_state_reset` with removed and inserted row counts;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `mentor_report_result` writable PostgreSQL command:
  - mentor-only;
  - `booking_state_meta FOR UPDATE`;
  - target `applications` row `FOR UPDATE`;
  - active `mentor_reports` duplicate check with `FOR UPDATE` before writing
    anything, so repeated mentor submits cannot create duplicate reports or
    notification spam;
  - validates that the selected trainee, venue and hall still match the
    application;
  - accepts only applications that are already invited/awaiting mentor feedback
    and still have an invite group or group link;
  - writes `mentor_reports` and `mentor_report_topics`;
  - updates the application final status from the mentor decision
    (`passed`/`failed`) and stores mentor result metadata;
  - writes a durable trainee `mentor_result` notification/outbox row with
    `status='pending'`, or `status='skipped'` +
    `telegram_chat_missing` when no Telegram target exists;
  - writes `mentor_report_received`, `application_passed` or
    `application_failed`, `mentor_result_notification_queued` or
    `mentor_result_notification_skipped`, and optional `shift_auto_closed`
    events;
  - auto-closes the shift when this report makes every attached application
    final;
  - version bump;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- `trainee_report_submission` writable PostgreSQL command:
  - trainee-only;
  - server-supplied trainee report chat id is required, so report-group
    misconfiguration fails before writes instead of silently accepting a report;
  - writes one durable `trainee_report` notification/outbox row for the trainee
    report group;
  - deduplicates repeated submits by `telegram_user_id + report_checksum`, so
    double taps do not create duplicate outbox rows or audit events;
  - writes a PII-safe `trainee_report_received` audit event with checksum and
    length, not raw report text;
  - does not mutate booking state, application status, shifts or
    `booking_state_meta.version`;
  - returns no fresh booking state through the adapter;
  - live PostgreSQL smoke inside `npm run test:postgres`.
- PostgreSQL notification worker/dry-run runner:
  - claims due `notifications` rows with `FOR UPDATE SKIP LOCKED`;
  - marks claimed rows `sending` and increments `attempt_count`;
  - sends only through the existing Telegram delivery gateway, so dry-run/live
    policy stays centralized in `TELEGRAM_DELIVERY_MODE`;
  - records successful live delivery as `sent`;
  - records dry-run and malformed rows as `skipped`;
  - returns transient failures to `pending` with `next_attempt_at`;
  - marks final failures as `failed`;
  - includes unit coverage for claim, live success, dry-run skip, malformed
    rows and retry/fail behavior;
  - includes a dry-run PostgreSQL smoke inside `npm run test:postgres`;
  - is not wired into production runtime.
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

Все текущие контракты write-команд для `/api/state` и `/api/report`
реализованы в PostgreSQL write layer. Notification worker/dry-run processing
тоже реализован. Следующая работа: staging-only writable runtime wiring and
full role QA.

## Runtime-Wiring Blockers

- PostgreSQL `return_to_queue` now implements the safe cleanup path for moving
  pre-attendance trainees back to preliminary queue. The current JSON runtime UI
  action `Вернуть в новые заявки` still uses `set_application_status ->
  pending`; before writable runtime cutover, the UI/API must either call
  `return_to_queue` where queue return is intended or define a separate
  back-to-`pending` command.
- PostgreSQL `assign_shift` is intentionally stricter than the legacy JSON
  helper: it only moves preliminary queue applications to open, non-canceled
  shifts. If UI/API needs to move an already assigned, confirmed or invited
  application, add a separate command that explicitly handles old shift,
  invite-group, venue and archive links before runtime cutover.
- PostgreSQL notification worker exists and is tested in dry-run, but
  production must remain disabled. Staging writable runtime can be wired only
  with `TELEGRAM_DELIVERY_MODE=dry_run` and explicit QA.

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

Claude: paused/exhausted. If Claude is reintroduced, give it only a scoped
staging-QA or docs-verification task, not production runtime work.

Codex: continue from `migration/postgres-foundation`; next recommended slice is
controlled staging-only writable runtime wiring, followed by full role QA and a
plan-vs-implementation audit before any production cutover discussion.
