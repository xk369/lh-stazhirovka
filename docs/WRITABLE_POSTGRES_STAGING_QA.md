# Writable PostgreSQL Staging QA

Этот документ описывает QA-проверку будущего writable PostgreSQL staging. Он
нужен после того, как будет добавлен `BOOKING_STORAGE_MODE=postgres`, но до
любого production cutover.

## Safety Preconditions

Staging only:

- `TELEGRAM_DELIVERY_MODE=dry_run`;
- `SUPPRESS_TRAINEE_NOTIFICATIONS=yes`;
- отдельный app container;
- отдельный PostgreSQL volume;
- no production `data/db.json` writes;
- no production deploy.

Stop immediately if health does not show safe mode.

## Health Check

Expected for writable staging:

```json
{
  "ok": true,
  "bookingStorageMode": "postgres",
  "bookingStorageWritable": true,
  "telegramDeliveryMode": "dry_run"
}
```

If `telegramDeliveryMode` is `live`, do not test actions that send messages.

## Baseline Data Check

Before manual QA:

- import fresh production snapshot into empty staging DB;
- verify parity against JSON snapshot;
- delete temporary JSON copy with PII after verification.

Check counts:

- shifts;
- applications;
- invite groups;
- invite group members;
- mentor reports;
- application events.

## Smoke Scenarios

### 1. Create Shift

Actions:

1. Recruiter opens dates.
2. Creates a future date.
3. Tries to create the same date again.

Expected:

- first create succeeds;
- duplicate returns clear validation error;
- state version changes once;
- `shift_created` event exists;
- no Telegram notification is sent.

### 2. Capacity Change

Actions:

1. Increase seats.
2. Decrease seats to assigned count.
3. Try decreasing below assigned count.

Expected:

- valid changes persist;
- invalid decrease is rejected;
- `shift_capacity_changed` event exists only for real change;
- notifications are dry-run or queued safely, depending on current stage.

### 3. Recruiter Status Change

Actions:

1. Move `pending -> confirmed`.
2. Try illegal stage skip.
3. Mark `invited -> feedback`.
4. Mark `invited -> noshow`.

Expected:

- valid transitions persist;
- illegal transitions fail;
- corresponding events exist:
  - `recruiter_confirmed`;
  - `attendance_marked_feedback`;
  - `attendance_marked_noshow`.

### 4. Invite Group

Actions:

1. Select date.
2. Select venue.
3. Add multiple confirmed trainees.
4. Send group with Telegram link.
5. Try sending duplicate invite for same trainee.

Expected:

- one `invite_group` row;
- many `invite_group_members` rows;
- applications status becomes `invited`;
- `invite_group_sent` and `application_invited` events exist;
- duplicate invite is rejected.

### 5. Mentor Report

Actions:

1. Mentor selects trainee.
2. Sends report with passed decision.
3. Repeats submit.

Expected:

- application becomes `passed`;
- mentor report row exists;
- trainee disappears from mentor dropdown;
- duplicate submit is rejected or idempotent;
- no duplicate report spam;
- mentor result notification is dry-run/outbox-safe.

### 6. Cancellation

Actions:

1. Cancel one trainee internship on a date with several trainees.
2. Cancel whole shift with pre-attendance trainees.

Expected:

- one-trainee cancellation affects only selected application;
- shift cancellation returns only pre-attendance trainees to queue;
- final/feedback trainees are not silently reset;
- invite group membership is updated;
- `internship_cancelled` / `shift_cancelled` events exist.

### 7. Registry And Archive

Actions:

1. Open registry.
2. Search by FIO, Telegram and phone.
3. Export CSV.
4. Open group archive.

Expected:

- registry reflects Postgres state;
- phone and training date are visible where expected;
- CSV contains current data;
- archive grouping remains correct;
- old dates do not pollute active group selector.

## Conflict Checks

Run two stale writes:

1. Read state version `N`.
2. Apply one command successfully.
3. Re-submit another command with baseVersion `N`.

Expected:

- second command returns `409`;
- response includes fresh state;
- no partial DB write happened.

## Go/No-Go

Go to next migration stage only if:

- automated tests pass;
- parity passed on fresh prod snapshot;
- staging manual QA passed;
- no live Telegram messages sent;
- event log explains every tested state change;
- rollback to JSON remains documented.

No-go if:

- duplicate mentor reports are possible;
- status can change without event;
- Postgres write can fall back to JSON silently;
- staging sends live Telegram messages;
- any PII dump is committed or left in repo.
