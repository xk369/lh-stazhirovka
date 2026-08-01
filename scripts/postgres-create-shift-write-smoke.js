import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { createShiftInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const now = new Date('2026-07-29T12:00:00.000Z');
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  assert.equal(beforeState.version, 7);
  assert.equal(beforeState.shifts.some(shift => shift.date === '2026-08-03'), false);

  const result = await createShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'create_shift',
      baseVersion: beforeState.version,
      date: '2026-08-03',
      seats: 6
    },
    now
  });

  assert.equal(result.previousVersion, 7);
  assert.equal(result.version, 8);
  assert.equal(result.date, '2026-08-03');
  assert.equal(result.seats, 6);
  assert.equal(result.updatedAt, now.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, 8);
  assert.equal(afterState.updatedAt, now.toISOString());
  const createdShift = afterState.shifts.find(shift => shift.date === '2026-08-03');
  assert.ok(createdShift);
  assert.equal(createdShift.id, result.legacyId);
  assert.equal(createdShift.seats, 6);
  assert.equal(createdShift.open, true);
  assert.equal(createdShift.canceled, false);

  const eventResult = await pool.query(
    `
      SELECT
        application_events.event_type,
        application_events.actor_type,
        application_events.actor_telegram_user_id,
        application_events.payload,
        shifts.legacy_id AS shift_legacy_id
      FROM application_events
      JOIN shifts ON shifts.id = application_events.shift_id
      WHERE application_events.event_type = 'shift_created'
        AND shifts.legacy_id = $1
    `,
    [result.legacyId]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'recruiter');
  assert.equal(event.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(event.shift_legacy_id), result.legacyId);
  assert.equal(event.payload.action, 'create_shift');
  assert.equal(event.payload.baseVersion, 7);
  assert.equal(event.payload.previousVersion, 7);
  assert.equal(event.payload.nextVersion, 8);
  assert.equal(event.payload.date, '2026-08-03');
  assert.equal(event.payload.seats, 6);
  assert.equal(event.payload.legacyShiftId, result.legacyId);

  console.log('PostgreSQL create_shift write smoke test passed.');
} finally {
  await pool.end();
}
