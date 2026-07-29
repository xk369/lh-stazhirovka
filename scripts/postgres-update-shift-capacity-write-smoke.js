import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandValidationError,
  updateShiftCapacityInPostgres
} from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const now = new Date('2026-07-29T12:30:00.000Z');
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
  const targetShift = beforeState.shifts.find(shift => Number(shift.id) === 100);
  assert.ok(targetShift);
  assert.equal(targetShift.seats, 4);

  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_shift_capacity',
      baseVersion: beforeState.version,
      shiftId: 100,
      seats: 5
    },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.legacyId, 100);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.seats, 5);
  assert.equal(result.previousVersion, beforeState.version);
  assert.equal(result.version, beforeState.version + 1);
  assert.equal(result.updatedAt, now.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, beforeState.version + 1);
  assert.equal(afterState.updatedAt, now.toISOString());
  const updatedShift = afterState.shifts.find(shift => Number(shift.id) === 100);
  assert.ok(updatedShift);
  assert.equal(updatedShift.seats, 5);

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
      WHERE application_events.event_type = 'shift_capacity_changed'
        AND shifts.legacy_id = 100
    `
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'recruiter');
  assert.equal(event.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(event.shift_legacy_id), 100);
  assert.equal(event.payload.action, 'update_shift_capacity');
  assert.equal(event.payload.baseVersion, beforeState.version);
  assert.equal(event.payload.previousVersion, beforeState.version);
  assert.equal(event.payload.nextVersion, beforeState.version + 1);
  assert.equal(event.payload.previousSeats, 4);
  assert.equal(event.payload.nextSeats, 5);
  assert.equal(event.payload.date, '2026-07-26');
  assert.equal(event.payload.legacyShiftId, 100);

  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'update_shift_capacity',
        baseVersion: afterState.version,
        shiftId: 100,
        seats: 1
      },
      now: new Date('2026-07-29T12:31:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже записано 2 стажёров/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterState.version);
  const finalShift = finalState.shifts.find(shift => Number(shift.id) === 100);
  assert.ok(finalShift);
  assert.equal(finalShift.seats, 5);

  console.log('PostgreSQL update_shift_capacity write smoke test passed.');
} finally {
  await pool.end();
}
