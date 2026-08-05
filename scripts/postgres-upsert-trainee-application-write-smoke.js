import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { upsertTraineeApplicationInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const trainee = {
  role: 'trainee',
  userId: '930040',
  telegram: {
    user: {
      id: '930040',
      username: 'upsert_smoke'
    }
  }
};

const SHIFT_LEGACY_ID = 910039;
const APPLICATION_LEGACY_ID = 910040;

async function seedOpenShift(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, '2026-10-04'::date, 2, true, false, NULL, $3, $3)
      `,
      [randomUUID(), SHIFT_LEGACY_ID, seedIso]
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

function applicationPayload(overrides = {}) {
  return {
    id: APPLICATION_LEGACY_ID,
    shiftId: null,
    name: 'Upsert Smoke Trainee',
    phone: '+7 999 000-40-40',
    training: 'passed',
    trainingDate: '2026-09-20',
    attempt: 'first',
    limits: 'После 17:00',
    telegramCode: '',
    status: 'queue',
    comment: '',
    ...overrides
  };
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T18:05:00.000Z';
  await seedOpenShift(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const seededShift = seededState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(seededShift);
  assert.equal(seededShift.open, true);

  const createNow = new Date('2026-07-29T18:10:00.000Z');
  const createResult = await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: seededState.version,
      application: applicationPayload()
    },
    now: createNow
  });
  assert.equal(createResult.created, true);
  assert.equal(createResult.previousStatus, null);
  assert.equal(createResult.nextStatus, 'queue');
  assert.equal(createResult.shiftLegacyId, null);
  assert.equal(createResult.previousVersion, seededState.version);
  assert.equal(createResult.version, seededState.version + 1);
  assert.equal(createResult.updatedAt, createNow.toISOString());

  const afterCreateState = await readBookingStateFromPostgres(pool);
  assert.equal(afterCreateState.version, createResult.version);
  const createdApp = afterCreateState.applications.find(
    application => Number(application.id) === APPLICATION_LEGACY_ID
  );
  assert.ok(createdApp);
  assert.equal(createdApp.status, 'queue');
  assert.equal(createdApp.shiftId, null);
  assert.equal(createdApp.telegramUserId, '930040');
  assert.equal(createdApp.telegramChatId, '930040');
  assert.equal(createdApp.telegramUsername, 'upsert_smoke');
  assert.equal(createdApp.phone, '+7 999 000-40-40');
  assert.equal(createdApp.trainingDate, '2026-09-20');

  const createdEventResult = await pool.query(
    `
      SELECT event_type, actor_type, actor_telegram_user_id, payload
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE applications.legacy_id = $1
         AND application_events.event_type = 'application_created'
    `,
    [APPLICATION_LEGACY_ID]
  );
  assert.equal(createdEventResult.rowCount, 1);
  assert.equal(createdEventResult.rows[0].actor_type, 'trainee');
  assert.equal(createdEventResult.rows[0].actor_telegram_user_id, '930040');
  assert.equal(createdEventResult.rows[0].payload.action, 'upsert_trainee_application');
  assert.equal(createdEventResult.rows[0].payload.application.status, 'queue');
  assert.equal(createdEventResult.rows[0].payload.application.shiftId, null);

  const queueNow = new Date('2026-07-29T18:15:00.000Z');
  const queueResult = await upsertTraineeApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'upsert_trainee_application',
      baseVersion: afterCreateState.version,
      application: applicationPayload({
        limits: 'Жду новую дату'
      })
    },
    now: queueNow
  });
  assert.equal(queueResult.created, false);
  assert.equal(queueResult.updated, true);
  assert.equal(queueResult.previousStatus, 'queue');
  assert.equal(queueResult.nextStatus, 'queue');
  assert.equal(queueResult.previousShiftId, null);
  assert.equal(queueResult.shiftLegacyId, null);
  assert.equal(queueResult.previousVersion, afterCreateState.version);
  assert.equal(queueResult.version, afterCreateState.version + 1);

  const afterQueueState = await readBookingStateFromPostgres(pool);
  assert.equal(afterQueueState.version, queueResult.version);
  const queuedApp = afterQueueState.applications.find(
    application => Number(application.id) === APPLICATION_LEGACY_ID
  );
  assert.equal(queuedApp.status, 'queue');
  assert.equal(queuedApp.shiftId, null);
  assert.equal(queuedApp.limits, 'Жду новую дату');

  const queueEventResult = await pool.query(
    `
      SELECT event_type, payload
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE applications.legacy_id = $1
         AND application_events.event_type IN ('application_returned_to_queue', 'application_updated')
       ORDER BY application_events.created_at, application_events.event_type
    `,
    [APPLICATION_LEGACY_ID]
  );
  assert.equal(queueEventResult.rowCount, 1);
  const eventTypes = queueEventResult.rows.map(row => row.event_type).sort();
  assert.deepEqual(eventTypes, ['application_updated']);

  console.log('PostgreSQL upsert_trainee_application write smoke test passed.');
} finally {
  await pool.end();
}
