# Claude PR Review Checklist

Этот чек-лист использует Codex после каждой итерации Claude. Цель - не доверять
словам в отчете, а сверять их с Git, тестами и инвариантами проекта.

## 1. Git Orientation

```bash
git fetch origin
git checkout migration/postgres-foundation
git pull --ff-only origin migration/postgres-foundation
git fetch origin migration/postgres-write-adapter-claude
git log --oneline --decorate --graph --left-right \
  migration/postgres-foundation...origin/migration/postgres-write-adapter-claude
git diff --stat migration/postgres-foundation...origin/migration/postgres-write-adapter-claude
git diff --name-status migration/postgres-foundation...origin/migration/postgres-write-adapter-claude
```

Review must stop if the PR target is `main`.

## 2. Forbidden Changes

Fail the review if Claude changed any of these without explicit approval:

- `.env*`;
- `data/db.json`;
- production dumps or copied PII;
- production deploy configs;
- report chat routing;
- Telegram live delivery defaults;
- `docs/MIGRATION_EXECUTION_PLAN.md`;
- `docs/POSTGRES_MIGRATION_ROADMAP.md`;
- `docs/CODEX_HANDOFF.md`;
- migration progress percent.

## 3. Storage Safety

Check:

- `BOOKING_STORAGE_MODE=json` remains the default.
- `postgres_readonly` still rejects writes.
- New writable mode cannot accidentally run without `DATABASE_URL`.
- No automatic fallback from Postgres to JSON.
- Health endpoint clearly reports storage mode and writability.
- JSON runtime behavior remains unchanged unless explicitly scoped.

## 4. Transaction Safety

For every writable Postgres command in the PR:

- role/initData validation happens before mutation;
- affected rows are read in a transaction;
- state transition is validated;
- domain rows and `application_events` are written in the same transaction;
- command returns fresh state reconstructed from Postgres;
- conflict/stale version path is explicit;
- duplicate clicks cannot create duplicate rows or duplicate final reports.

## 5. Telegram Safety

Writable Postgres work must not directly expand Telegram behavior unless the
task is explicitly about outbox.

Check:

- no live sends in staging mode;
- no chat ids hardcoded in frontend;
- no direct Telegram call bypassing `telegram-delivery.js`;
- no full report/PII text written to logs.

## 6. Data Model Safety

Check mapping for:

- shifts;
- applications;
- invite groups;
- invite group members;
- mentor report fields;
- trainee phone;
- training date;
- status;
- experience;
- group link;
- venue/hall fields.

No unknown JSON field should be silently dropped by import/write paths.

## 7. Required Tests

Always run:

```bash
npm test
git diff --check
```

If Postgres tooling/runtime changed:

```bash
npm run test:postgres
```

If `npm run test:postgres` cannot run locally, note the exact reason and do not
mark the PR production-ready.

## 8. Manual Review Questions

- Does this PR reduce risk, or add another half-mode?
- Can staging run this without real Telegram messages?
- If the command fails after DB write, what happens?
- If Telegram fails, does DB still know what happened?
- Can we explain a trainee status from `application_events` after this PR?
- Does rollback to JSON remain possible?

## 9. Review Result Template

```text
Codex Review Result

PR:
Head commit:
Scope matched Claude report: yes/no
Forbidden files changed: yes/no
Tests:
Postgres tests:
Production touched: yes/no
Telegram risk: low/medium/high
Data/PII risk: low/medium/high

Decision: approve / request changes / block

Required fixes:

Notes:
```
