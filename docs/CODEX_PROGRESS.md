# Codex Progress Log

This is the active worklog for the LOFT HALL internship project. Keep it short,
current and safe to read after context compaction. Do not put secrets, tokens,
passwords, raw production data, trainee PII dumps or private `.env` values here.

## Last Updated

- Date: 2026-07-29
- Agent task: continue PostgreSQL migration work without touching production,
  keep handoff docs current, and prepare the next safe QA/implementation steps.

## Active Context

- Production project is live and must remain untouched unless the user
  explicitly asks for a production deploy.
- Production URL: `https://stazhirovka.151.244.243.164.sslip.io`
- Production server path: `/opt/loft-hall-internship-unified`
- Production container: `loft-internship-unified`
- Production still uses JSON storage: `data/db.json`.
- Migration worktree:
  `/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_migration_integrate`
- Active branch: `migration/postgres-foundation`
- Draft PR: `https://github.com/xk369/lh-stazhirovka/pull/3`
- PR status: draft, not merged.
- Migration execution plan: `docs/MIGRATION_EXECUTION_PLAN.md`
- Current migration progress: 72%.

## Migration Staging

- URL: `https://stazhirovka-migration.151.244.243.164.sslip.io`
- Server path: `/opt/loft-hall-internship-migration-staging`
- App container: `loft-internship-app-migration-staging`
- PostgreSQL container: `loft-internship-postgres-migration-staging`
- Host port: `127.0.0.1:3502 -> 3000`
- Storage mode: `BOOKING_STORAGE_MODE=postgres_readonly`
- Telegram mode: `TELEGRAM_DELIVERY_MODE=dry_run`
- Personal trainee notifications: `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`
- Safety result: staging can validate requests but cannot write booking state
  and cannot send real Telegram messages.

## Completed In This Migration Branch

- Added PostgreSQL schema in `db/migrations/001_initial.sql`.
- Added migration runner, JSON importer and parity verifier.
- Added read-only PostgreSQL booking-state reconstruction.
- Added strict import guard against unknown JSON fields and non-empty target DB.
- Added centralized Telegram delivery gateway with `live` and `dry_run` modes.
- Added explicit booking storage modes: `json` default and `postgres_readonly`.
- Added isolated Docker Compose contour for migration staging.
- Deployed read-only migration staging with a copied production snapshot.
- Verified import/parity/runtime smoke before exposing staging.
- Added a Postgres write adapter seam and transactional `create_shift` path.
- Added live PostgreSQL write smoke for `create_shift` inside `npm run test:postgres`.
- Added a transactional `update_shift_capacity` Postgres write path with live
  PostgreSQL smoke inside `npm run test:postgres`.
- Added a transactional `set_application_status` Postgres write path for
  forward recruiter transitions with live PostgreSQL smoke inside
  `npm run test:postgres`.
- Added a transactional `assign_shift` Postgres write path for moving queue
  applications to open shifts with live PostgreSQL smoke inside
  `npm run test:postgres`.
- Added a transactional `send_invites` Postgres write path for creating invite
  groups, linking members and moving confirmed applications to `invited` with
  live PostgreSQL smoke inside `npm run test:postgres`.
- Added durable `notifications` outbox rows to the transactional
  `send_invites` Postgres write path: one `pending` row per reachable trainee,
  explicit `skipped` row when the Telegram target is missing, stable
  idempotency key and live PostgreSQL smoke inside `npm run test:postgres`.
- Added a transactional `cancel_internship` Postgres write path for returning
  a single pre-attendance trainee to preliminary queue, cleaning invite group
  membership, removing an empty invite group, writing audit events and writing
  a durable trainee notification/outbox row inside the same transaction.
- Added a transactional `cancel_shift` Postgres write path for canceling a
  whole internship date, returning only pre-attendance trainees to preliminary
  queue, preserving attended trainees on the canceled date for history, cleaning
  invite group membership, writing audit events and writing durable trainee
  notification/outbox rows in the same transaction.
- Added a transactional `step_back_application` Postgres write path for
  recruiter stage correction: `passed`/`failed` back to `feedback`,
  `feedback` back to `invited`, and `noshow` back to `invited`, with previous
  mentor reports voided when a final result is rolled back and a durable trainee
  notification/outbox row written in the same transaction.
- Added a transactional `mark_experienced` Postgres write path for setting the
  recruiter-owned `experience='experienced'` flag only on passed trainees, with
  an `experienced_marked` audit event and no trainee notification.
- Added migration PR safety check and command contracts for future write commands.
- Published the branch and opened draft PR #3.

## Current Checks

- 2026-07-29: `npm test` passed, 144/144 tests after integrating
  `update_shift_capacity` into `migration/postgres-foundation` and importing
  seat-holding statuses from the shared state machine.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `update_shift_capacity` PostgreSQL write smoke.
- 2026-07-29: `npm test` passed, 158/158 tests after integrating
  `set_application_status` into `migration/postgres-foundation`.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `set_application_status` PostgreSQL write smoke.
- 2026-07-29: `npm test` passed, 171/171 tests after integrating
  `assign_shift` into `migration/postgres-foundation`.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `assign_shift` PostgreSQL write smoke.
- 2026-07-29: migration PR safety check passed after integrating
  `assign_shift`, 7 changed paths checked.
- 2026-07-29: `npm test` passed, 186/186 tests after integrating
  `send_invites` into `migration/postgres-foundation` and adding Codex
  release assertions around commit/rollback paths.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `send_invites` PostgreSQL write smoke.
- 2026-07-29: migration PR safety check passed after integrating
  `send_invites`, 7 changed paths checked.
- 2026-07-29: `npm test` passed, 188/188 tests after adding durable
  `notifications` outbox rows to PostgreSQL `send_invites`.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `send_invites` notification/outbox assertions.
- 2026-07-29: `npm test` passed, 197/197 tests after adding transactional
  PostgreSQL `cancel_internship`, adapter routing and unit coverage.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `cancel_internship` PostgreSQL write smoke. A sandboxed run failed first
  because local PostgreSQL could not create shared memory (`shmget Operation
  not permitted`), then the same command passed with escalation.
- 2026-07-29: `npm test` passed, 205/205 tests after adding transactional
  PostgreSQL `cancel_shift`, adapter routing and unit coverage.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `cancel_shift` PostgreSQL write smoke. A sandboxed run failed first
  because local PostgreSQL could not create shared memory (`shmget Operation
  not permitted`), then the same command passed with escalation.
- 2026-07-29: `npm test` passed, 212/212 tests after adding transactional
  PostgreSQL `step_back_application`, adapter routing and unit coverage.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `step_back_application` PostgreSQL write smoke. A sandboxed run failed
  first because local PostgreSQL could not create shared memory (`shmget
  Operation not permitted`), then the same command passed with escalation.
- 2026-07-29: `npm test` passed, 217/217 tests after adding transactional
  PostgreSQL `mark_experienced`, adapter routing and unit coverage.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `mark_experienced` PostgreSQL write smoke.
- 2026-07-29: `npm test` passed, 135/135 tests after integrating
  `create_shift` writable Postgres slice, safety check and command contracts
  into `migration/postgres-foundation`.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox after adding
  live `create_shift` PostgreSQL write smoke.
- 2026-07-29: migration PR safety check passed for integrated
  `migration/postgres-foundation` changes, 17 changed paths checked.
- 2026-07-29: `npm test` passed, 109/109 tests after expanding
  `application_events` coverage.
- 2026-07-29: `git diff --check` passed after expanding event coverage.
- 2026-07-29: `git fetch origin` confirmed `origin/main` is already included
  in `migration/postgres-foundation` (`10 ahead / 0 behind` versus
  `origin/main`).
- 2026-07-29: `npm test` passed, 106/106 tests after documenting the
  migration execution plan and confirming main synchronization.
- 2026-07-29: `git diff --check` passed after documenting the migration plan.
- 2026-07-29: `npm test` passed, 106/106 tests after adding the
  event-log foundation.
- 2026-07-29: `git diff --check` passed.
- 2026-07-29: `npm run test:postgres` passed outside the sandbox. The first
  sandboxed run failed on local PostgreSQL shared memory (`shmget Operation not
  permitted`), then the same command passed with escalation.
- Server smoke proved:
  - recruiter read works from PostgreSQL;
  - booking writes return `503 BOOKING_STORAGE_READ_ONLY`;
  - report and notify requests return dry-run results;
  - no real Telegram messages are sent from migration staging.

## Latest Worklog Entry

- 2026-07-29: audited existing Markdown instructions and found stale migration
  staging commit references plus an old README backup path. Added this progress
  log, linked it from `AGENTS.md`, updated staging commit references to
  `f96caed`, and corrected the production backup path in `README.md`.
- 2026-07-29: started Stage D safely without enabling runtime Postgres writes.
  Added `src/booking-state-events.js` to plan audit events from
  `currentState -> nextState`, covering recruiter actions, invite groups,
  attendance, mentor final results, step-back and clear-state. Added
  `src/postgres/write-application-events.js` to insert those events into
  PostgreSQL with legacy IDs preserved in JSON payloads. Added tests for both.
- 2026-07-29: added `docs/MIGRATION_EXECUTION_PLAN.md` with stage weights,
  go/no-go gates, QA scope and production cutover rollback rules. Confirmed
  migration branch already contains current `origin/main`, ran `npm test`
  successfully, and raised migration progress to 40%.
- 2026-07-29: expanded `src/booking-state-events.js` coverage without
  touching production runtime writes. Added explicit events for trainee profile
  updates, recruiter comment updates, trainee reports, internship cancellation,
  invite group membership changes, automatic shift close, and mentor result
  notification delivery statuses. Added tests and raised migration progress to
  45%.
- 2026-07-29: added `docs/CLAUDE_MIGRATION_BRIEF.md` so Claude can join the
  migration safely through a separate branch/PR without touching production,
  `main`, live Telegram delivery or runtime data.
- 2026-07-29: tightened Claude collaboration rules: Claude is an implementer
  for scoped work packages, must not change migration strategy/progress/cutover
  docs, and must end every iteration with `Report For Codex Review`.
- 2026-07-29 (Claude, branch `migration/postgres-write-adapter-claude`): added
  a Postgres transaction helper, a booking storage adapter seam and a
  transactional `create_shift` write path with unit tests. `BOOKING_STORAGE_MODE`
  enum now also accepts `postgres`, gated by `isRuntimeWiredBookingStorageMode`
  and a source-level assertion that `src/server.js` still does not branch on
  it, so runtime remains JSON. No wiring into `server.js`, no Telegram/outbox
  changes, no production or staging deploy. Draft PR opened into
  `migration/postgres-foundation` for Codex review.
- 2026-07-29 (Codex, branch `migration/postgres-create-shift-integration-codex`):
  added a real PostgreSQL write smoke for `create_shift` inside
  `npm run test:postgres`, verifying the inserted shift, version bump and
  `shift_created` application event after JSON import/parity checks.
- 2026-07-29: integrated accepted Claude/Codex migration slices into
  `migration/postgres-foundation`: transactional Postgres `create_shift`,
  live write smoke, PR safety check and command contracts. Raised migration
  progress to 50% because Stage 5 is now genuinely in progress on the base
  migration branch, not only in side branches.
- 2026-07-29 (Claude, branch `migration/postgres-write-capacity-claude`): added
  a transactional `update_shift_capacity` Postgres write path for Codex review.
  Uses `FOR UPDATE` on `booking_state_meta` and on the target `shifts` row,
  refuses to shrink `seats` below the current seat-holding count, writes a
  `shift_capacity_changed` row into `application_events` and bumps the meta
  version. When requested seats equal current seats the command is a no-op:
  no `UPDATE shifts`, no event, no version bump. Still not wired into
  `src/server.js`. No Telegram/outbox/notifications changes, no deploy.
- 2026-07-29: integrated the `update_shift_capacity` slice into
  `migration/postgres-foundation`, moved seat-holding status usage to the
  shared state-machine source, added real PostgreSQL write smoke for increasing
  seats and rejecting shrink-below-usage, and raised migration progress to 52%.
- 2026-07-29 (Claude, branch `migration/postgres-write-status-claude`): added
  a transactional `set_application_status` Postgres write path for Codex
  review. Recruiter-only, `FOR UPDATE` on `booking_state_meta` and on the
  target `applications` row, reuses `canRecruiterSetApplicationStatus` from
  the shared state machine, guards `feedback`/`noshow`/`invited` by
  `invite_group_id OR group_link`, requires `shift_id` for the `confirmed`
  target, refuses the `→ pending` back transitions until a dedicated command
  exists, writes the matching audit event and (if applicable) a
  `shift_auto_closed` event in the same transaction, updates
  `applications.status`, `experience`, `row_version` and bumps the meta
  version. Wired through the Postgres write adapter and covered by a live
  Postgres write smoke inside `npm run test:postgres`. Still not wired into
  `src/server.js`, no Telegram/outbox/notifications changes, no deploy.
- 2026-07-29: reviewed and integrated `set_application_status` into
  `migration/postgres-foundation`. Confirmed the explicit `→ pending` rejection
  matches `docs/POSTGRES_MIGRATION_ROADMAP.md`: the current UI correction
  action must become a separate business command before Postgres write runtime
  is enabled. Raised migration progress to 55%.
- 2026-07-29 (Claude, branch `migration/postgres-write-assign-shift-claude`):
  added a transactional `assign_shift` Postgres write path for Codex review.
  Recruiter-only, `FOR UPDATE` on `booking_state_meta`, the target
  `applications` row and the target `shifts` row. Requires the source
  application to be in preliminary queue (`status=queue` and `shift_id IS NULL`),
  requires the target shift to exist, be `open=true` and not `canceled`, and
  refuses assignment when seat-holding usage already fills seats. Updates
  `applications.shift_id`/`status`/`row_version`, writes both
  `application_status_changed` (queue → pending) and
  `application_assigned_to_shift` audit events in the same transaction, and
  bumps the meta version. Wired through the Postgres write adapter and covered
  by a live Postgres write smoke inside `npm run test:postgres`. Still not
  wired into `src/server.js`, no Telegram/outbox/notifications changes, no
  deploy.
- 2026-07-29: reviewed and integrated `assign_shift` into
  `migration/postgres-foundation`. Added a Codex assertion that the command
  releases the client after commit. Confirmed the stricter queue-only/open-shift
  guard matches `docs/DATA_MODEL.md`; any future move of an already assigned or
  invited application should become a separate command before runtime cutover.
  Raised migration progress to 58%.
- 2026-07-29 (Claude, branch `migration/postgres-write-send-invites-claude`):
  added a transactional `send_invites` Postgres write path for Codex review.
  Recruiter-only, `FOR UPDATE` on `booking_state_meta`, the target `shifts`
  row and the bulk of selected `applications` rows (ordered by `legacy_id`
  ASC for stable lock order). Deduplicates `memberIds`, requires each member
  to exist, live on the selected shift and be in `status='confirmed'`,
  validates Telegram-only http/https link (same host set as JSON runtime),
  creates one new `invite_groups` row and one `invite_group_members` row per
  member, bulk-updates `applications.status='invited'` +
  `invite_group_id`/`venue_id`/`group_link`/`updated_at`/`row_version+1`,
  writes one `invite_group_sent` event plus one `application_invited` event
  per member in the same transaction, and bumps the meta version. Wired
  through the Postgres write adapter and covered by a live Postgres write
  smoke inside `npm run test:postgres`. Still not wired into `src/server.js`,
  no Telegram/outbox/notifications changes, no deploy.
- 2026-07-29: reviewed and integrated the `send_invites` state/events slice
  into `migration/postgres-foundation`. Added Codex assertions that the command
  releases the client after both commit and rollback. Confirmed this slice is
  not runtime-ready by itself because it intentionally does not write
  `notifications`/outbox rows yet, even though the command contract requires
  outbox before production runtime wiring. Raised migration progress to 61%.
- 2026-07-29: closed the `send_invites` notification/outbox gap directly in
  `migration/postgres-foundation` after Claude limits ended. The command now
  writes durable `notifications` rows in the same transaction as invite group,
  member links, application status updates and audit events. Pending rows are
  created for trainees with Telegram targets; missing targets are recorded as
  explicit skipped rows with `telegram_chat_missing`, so the business action
  does not silently fail. Added unit coverage, adapter assertions and live
  PostgreSQL smoke assertions. No `src/server.js` runtime wiring, no live
  Telegram worker and no deploy. Raised migration progress to 64%.
- 2026-07-29: added transactional PostgreSQL `cancel_internship` directly in
  `migration/postgres-foundation`. The command is recruiter-only, locks
  `booking_state_meta`, the application and any linked invite group, rejects
  stale versions and post-attendance statuses, moves the trainee back to
  `queue`, clears shift/group/venue/report fields, removes invite group
  membership, deletes an empty group, writes `invite_group_updated` or
  `invite_group_removed` plus `internship_cancelled`, and writes a durable
  trainee notification/outbox row with pending/skipped semantics. Added adapter
  routing, unit coverage and live PostgreSQL smoke. No `src/server.js` runtime
  wiring, no live Telegram worker and no deploy. Raised migration progress to
  66%.
- 2026-07-29: added transactional PostgreSQL `cancel_shift` directly in
  `migration/postgres-foundation`. The command is recruiter-only, locks
  `booking_state_meta`, the shift, affected pre-attendance applications and
  linked invite groups, rejects stale versions, marks the date as canceled,
  returns only `pending`/`confirmed`/`invited` trainees to `queue`, preserves
  post-attendance trainees on the canceled date for history/result visibility,
  cleans affected application assignment/report fields, removes affected invite
  memberships, updates or deletes invite groups, writes `shift_cancelled`,
  `invite_group_updated`/`invite_group_removed` and `internship_cancelled`
  events, and writes durable trainee notification/outbox rows with
  pending/skipped semantics. Added adapter routing, unit coverage and live
  PostgreSQL smoke. No `src/server.js` runtime wiring, no live Telegram worker
  and no deploy. Raised migration progress to 68%.
- 2026-07-29: added transactional PostgreSQL `step_back_application` directly
  in `migration/postgres-foundation`. The command is recruiter-only, locks
  `booking_state_meta` and the target application, rejects stale versions and
  unsupported statuses, uses the shared step-back state-machine map, rolls final
  `passed`/`failed` results back to `feedback` while voiding the active mentor
  report and clearing mentor-result/delivery/experience fields, rolls
  `feedback` or `noshow` back to `invited`, writes an `application_step_back`
  event and a durable `booking_stage_changed` notification/outbox row with
  pending/skipped semantics. Added adapter routing, unit coverage and live
  PostgreSQL smoke. No `src/server.js` runtime wiring, no live Telegram worker
  and no deploy. Raised migration progress to 70%.
- 2026-07-29: added transactional PostgreSQL `mark_experienced` directly in
  `migration/postgres-foundation`. The command is recruiter-only, locks
  `booking_state_meta` and the target application, rejects stale versions,
  missing applications, invalid ids and non-`passed` statuses, sets
  `experience='experienced'`, writes an `experienced_marked` event and bumps
  the meta version. If the trainee is already marked experienced, the command
  returns an idempotent no-op without a duplicate event or version bump. Added
  adapter routing, unit coverage and live PostgreSQL smoke. No `src/server.js`
  runtime wiring, no live Telegram worker and no deploy. Raised migration
  progress to 72%.

## Documentation Audit

Read before continuing:

- `AGENTS.md`
- `docs/CODEX_HANDOFF.md`
- `docs/MIGRATION_EXECUTION_PLAN.md`
- `docs/MIGRATION_DELIVERY_SCOREBOARD.md`
- `docs/CLAUDE_MIGRATION_BRIEF.md`
- `docs/INTERNSHIP_WORKFLOW.md`
- `docs/DATA_MODEL.md`
- `docs/POSTGRES_MIGRATION_ROADMAP.md`
- `deploy/MIGRATION_STAGING.md`
- `README.md`

Known doc rule:

- `docs/CODEX_HANDOFF.md` is for current production/staging/deploy facts.
- `docs/CODEX_PROGRESS.md` is the live worklog.
- `docs/MIGRATION_EXECUTION_PLAN.md` is the concrete execution plan, percent
  tracking rules and go/no-go gates.
- `docs/MIGRATION_DELIVERY_SCOREBOARD.md` is the practical delivery board:
  integrated slices, next commands, gates and two-agent ownership.
- `docs/CLAUDE_MIGRATION_BRIEF.md` is the safe handoff prompt and guardrail set
  for involving Claude in the migration without touching production.
- `docs/INTERNSHIP_WORKFLOW.md` is business behavior by role.
- `docs/DATA_MODEL.md` is current JSON state/API fields and relationships.
- `docs/POSTGRES_MIGRATION_ROADMAP.md` is the migration architecture.
- `deploy/MIGRATION_STAGING.md` is the server staging procedure.

## Next Safe Actions

1. Keep production untouched and keep PR #3 in draft.
2. Continue Stage 5 by implementing one remaining writable Postgres command per
   iteration; the next high-value backend commands are `return_to_queue`,
   `update_comment` and `upsert_trainee_application`.
3. Continue Stage 6 after enough notifier commands exist: add the notification
   worker/dry-run runner that claims pending rows and records sent/failed/skipped
   delivery results without touching production.
4. Run local tests again after any doc/code changes:
   `npm test` and `git diff --check`.
5. Run `npm run test:postgres` after every Postgres write command.
6. Do full role QA on migration staging:
   trainee view, recruiter view, mentor report validation, registry, groups,
   archive, bad links, duplicate clicks and version conflicts.
7. For UI QA that needs Telegram identity, use signed test `initData` or a
   local harness; do not change the production bot WebApp URL.
8. Only after the critical `/api/state` write commands and required outbox
   paths are implemented and smoke-tested should we wire writable Postgres mode
   into `src/server.js`.

## Do Not Forget

- Do not merge PR #3 into `main` until the user approves.
- Do not deploy migration branch to production.
- Do not enable live Telegram delivery in staging.
- Do not import over a non-empty PostgreSQL staging database.
- Do not add mentor manual-entry behavior to production unless explicitly
  approved; the current production decision is to keep that out.
- Report routing must stay server-side:
  `TRAINEE_CHAT_ID` for trainee reports and `MENTOR_CHAT_ID` for mentor reports.
- If a new application field is added, update the write normalizer, frontend
  normalizer, export/registry if relevant, tests, and `docs/DATA_MODEL.md`.

## Open Decisions

- Whether to keep full mentor report text only in Telegram groups or also store
  full report bodies in PostgreSQL.
- Whether to add a mentors table or only log mentor Telegram user ids.
- Retention policy for trainee personal data.
- Exact QA method for Telegram WebApp role flows in migration staging.
- When to split Stage D into a new branch versus continuing from PR #3.
