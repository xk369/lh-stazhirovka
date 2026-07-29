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
  `/Users/a1/Desktop/Loft_Hall/Helper_bot/loft_hall_internship_unified_hall_sync`
- Active branch: `migration/postgres-foundation`
- Draft PR: `https://github.com/xk369/lh-stazhirovka/pull/3`
- PR status: draft, not merged.
- Migration execution plan: `docs/MIGRATION_EXECUTION_PLAN.md`
- Current migration progress: 40%.

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
- Published the branch and opened draft PR #3.

## Current Checks

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

## Documentation Audit

Read before continuing:

- `AGENTS.md`
- `docs/CODEX_HANDOFF.md`
- `docs/MIGRATION_EXECUTION_PLAN.md`
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
- `docs/INTERNSHIP_WORKFLOW.md` is business behavior by role.
- `docs/DATA_MODEL.md` is current JSON state/API fields and relationships.
- `docs/POSTGRES_MIGRATION_ROADMAP.md` is the migration architecture.
- `deploy/MIGRATION_STAGING.md` is the server staging procedure.

## Next Safe Actions

1. Keep production untouched and keep PR #3 in draft.
2. Continue Stage 4: complete `application_events` coverage and decide where
   runtime Postgres writes will call the event planner.
3. Run local tests again after any doc/code changes:
   `npm test` and `git diff --check`.
4. Do full role QA on migration staging:
   trainee view, recruiter view, mentor report validation, registry, groups,
   archive, bad links, duplicate clicks and version conflicts.
5. For UI QA that needs Telegram identity, use signed test `initData` or a
   local harness; do not change the production bot WebApp URL.
6. Only after Stage 4 is complete, implement writable PostgreSQL staging with
   transactional commands, `notifications` and outbox. The first
   `application_events` planning/writing foundation exists, but it is not
   connected to runtime writes yet.

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
