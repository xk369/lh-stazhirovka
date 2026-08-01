import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { traineeReportSubmissionInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const trainee = {
  role: 'trainee',
  telegram: {
    user: {
      id: 'postgres-smoke-trainee-report',
      username: 'trainee_report_smoke'
    }
  }
};

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const command = {
    action: 'trainee_report_submission',
    reportText: [
      'Отчёт стажёра smoke-test',
      'Дата: 30.07.2026',
      'Все основные пункты заполнены.'
    ].join('\n')
  };

  const first = await traineeReportSubmissionInPostgres({
    pool,
    actor: trainee,
    command,
    reportChatId: '-1003951918570',
    now: new Date('2026-07-30T15:00:00.000Z')
  });

  assert.equal(first.changed, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.notificationStatus, 'pending');
  assert.deepEqual(first.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });

  const afterFirstState = await readBookingStateFromPostgres(pool);
  assert.equal(afterFirstState.version, beforeState.version);

  const notificationRows = await pool.query(
    `
      SELECT application_id, mentor_report_id, type, chat_id, chat_target,
             status, text, idempotency_key
        FROM notifications
       WHERE idempotency_key = $1
    `,
    [first.idempotencyKey]
  );
  assert.equal(notificationRows.rowCount, 1);
  assert.equal(notificationRows.rows[0].application_id, null);
  assert.equal(notificationRows.rows[0].mentor_report_id, null);
  assert.equal(notificationRows.rows[0].type, 'trainee_report');
  assert.equal(notificationRows.rows[0].chat_id, '-1003951918570');
  assert.equal(notificationRows.rows[0].chat_target, 'trainee_report_group');
  assert.equal(notificationRows.rows[0].status, 'pending');
  assert.equal(notificationRows.rows[0].text, command.reportText);

  const eventRows = await pool.query(
    `
      SELECT event_type, actor_type, actor_telegram_user_id, payload
        FROM application_events
       WHERE event_type = 'trainee_report_received'
         AND payload->>'idempotencyKey' = $1
    `,
    [first.idempotencyKey]
  );
  assert.equal(eventRows.rowCount, 1);
  assert.equal(eventRows.rows[0].actor_type, 'trainee');
  assert.equal(eventRows.rows[0].actor_telegram_user_id, 'postgres-smoke-trainee-report');
  assert.equal(eventRows.rows[0].payload.notificationStatus, 'pending');
  assert.equal(eventRows.rows[0].payload.reportChecksum, first.reportChecksum);

  const duplicate = await traineeReportSubmissionInPostgres({
    pool,
    actor: trainee,
    command,
    reportChatId: '-1003951918570',
    now: new Date('2026-07-30T15:01:00.000Z')
  });

  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.idempotencyKey, first.idempotencyKey);
  assert.deepEqual(duplicate.notifications, {
    total: 1,
    pending: 0,
    skipped: 0,
    inserted: 0
  });

  const duplicateNotificationRows = await pool.query(
    'SELECT count(*)::int AS count FROM notifications WHERE idempotency_key = $1',
    [first.idempotencyKey]
  );
  assert.equal(duplicateNotificationRows.rows[0].count, 1);

  const duplicateEventRows = await pool.query(
    `
      SELECT count(*)::int AS count
        FROM application_events
       WHERE event_type = 'trainee_report_received'
         AND payload->>'idempotencyKey' = $1
    `,
    [first.idempotencyKey]
  );
  assert.equal(duplicateEventRows.rows[0].count, 1);

  console.log('PostgreSQL trainee_report_submission write smoke passed.');
} finally {
  await pool.end();
}
