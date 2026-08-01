import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandValidationError,
  assignShiftInPostgres
} from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

const QUEUE_APP_A = 900003;
const QUEUE_APP_B = 900004;

async function seedQueueApplication({ legacyId, seedIso, telegramSuffix }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          venue_id, group_link,
          candidate_report, mentor_report_received,
          created_at, updated_at
        ) VALUES (
          $1, $2, NULL, NULL,
          $3, $3, $4,
          'Queue Smoke Trainee', $5, 'passed', '2026-07-20', 'first', '', 'queue',
          NULL, '',
          false, false,
          $6, $6
        )
      `,
      [
        randomUUID(),
        legacyId,
        `92${telegramSuffix}`,
        `queue_smoke_${telegramSuffix}`,
        `+7 999 000-01-${String(telegramSuffix).padStart(2, '0')}`,
        seedIso
      ]
    );
    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const openShift = beforeState.shifts.find(shift => shift.open === true);
  assert.ok(openShift, 'expected at least one open shift (created by create_shift smoke) to exist');
  const closedShift = beforeState.shifts.find(shift => shift.open === false);
  assert.ok(closedShift, 'expected the fixture closed shift to exist');
  assert.equal(closedShift.id, 100);

  const seedIso = '2026-07-29T14:00:00.000Z';
  await seedQueueApplication({ legacyId: QUEUE_APP_A, seedIso, telegramSuffix: 1 });

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const queuedApp = seededState.applications.find(app => Number(app.id) === QUEUE_APP_A);
  assert.ok(queuedApp);
  assert.equal(queuedApp.status, 'queue');
  assert.equal(queuedApp.shiftId, null);

  const assignNow = new Date('2026-07-29T14:05:00.000Z');
  const assignResult = await assignShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'assign_shift',
      baseVersion: seededState.version,
      applicationId: QUEUE_APP_A,
      shiftId: openShift.id
    },
    now: assignNow
  });
  assert.equal(assignResult.changed, true);
  assert.equal(assignResult.previousStatus, 'queue');
  assert.equal(assignResult.nextStatus, 'pending');
  assert.equal(assignResult.previousShiftId, null);
  assert.equal(assignResult.shiftLegacyId, openShift.id);
  assert.equal(assignResult.shiftDate, openShift.date);
  assert.equal(assignResult.previousVersion, seededState.version);
  assert.equal(assignResult.version, seededState.version + 1);
  assert.equal(assignResult.updatedAt, assignNow.toISOString());

  const afterAssignState = await readBookingStateFromPostgres(pool);
  assert.equal(afterAssignState.version, assignResult.version);
  const assignedApp = afterAssignState.applications.find(app => Number(app.id) === QUEUE_APP_A);
  assert.equal(assignedApp.status, 'pending');
  assert.equal(Number(assignedApp.shiftId), openShift.id);

  const statusEventResult = await pool.query(
    `
      SELECT event_type, payload
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE applications.legacy_id = $1
         AND application_events.event_type = 'application_status_changed'
    `,
    [QUEUE_APP_A]
  );
  assert.equal(statusEventResult.rowCount, 1);
  assert.equal(statusEventResult.rows[0].payload.action, 'assign_shift');
  assert.equal(statusEventResult.rows[0].payload.previousStatus, 'queue');
  assert.equal(statusEventResult.rows[0].payload.nextStatus, 'pending');
  assert.equal(statusEventResult.rows[0].payload.nextShiftId, openShift.id);

  const assignedEventResult = await pool.query(
    `
      SELECT event_type, payload
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE applications.legacy_id = $1
         AND application_events.event_type = 'application_assigned_to_shift'
    `,
    [QUEUE_APP_A]
  );
  assert.equal(assignedEventResult.rowCount, 1);
  assert.equal(assignedEventResult.rows[0].payload.action, 'assign_shift');
  assert.equal(assignedEventResult.rows[0].payload.nextShiftId, openShift.id);
  assert.equal(assignedEventResult.rows[0].payload.date, openShift.date);

  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'assign_shift',
        baseVersion: afterAssignState.version,
        applicationId: QUEUE_APP_A,
        shiftId: openShift.id
      },
      now: new Date('2026-07-29T14:10:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /предварительной записи/.test(err.message)
  );

  await seedQueueApplication({
    legacyId: QUEUE_APP_B,
    seedIso: '2026-07-29T14:15:00.000Z',
    telegramSuffix: 2
  });
  const afterSecondSeedState = await readBookingStateFromPostgres(pool);
  assert.equal(afterSecondSeedState.version, afterAssignState.version + 1);

  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'assign_shift',
        baseVersion: afterSecondSeedState.version,
        applicationId: QUEUE_APP_B,
        shiftId: closedShift.id
      },
      now: new Date('2026-07-29T14:20:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /закрытую дату/.test(err.message)
  );

  await assert.rejects(
    () => assignShiftInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'assign_shift',
        baseVersion: afterSecondSeedState.version,
        applicationId: QUEUE_APP_B,
        shiftId: 987654321
      },
      now: new Date('2026-07-29T14:25:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterSecondSeedState.version);
  const finalQueuedB = finalState.applications.find(app => Number(app.id) === QUEUE_APP_B);
  assert.equal(finalQueuedB.status, 'queue');
  assert.equal(finalQueuedB.shiftId, null);

  console.log('PostgreSQL assign_shift write smoke test passed.');
} finally {
  await pool.end();
}
