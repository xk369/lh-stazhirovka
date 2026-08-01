import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  toggleShiftInPostgres
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

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const targetShift = beforeState.shifts.find(shift => shift.date === '2026-08-03')
    || beforeState.shifts.find(shift => shift.open);
  assert.ok(targetShift, 'toggle smoke needs an open shift');
  assert.equal(targetShift.open, true);

  const closeNow = new Date('2026-07-29T12:10:00.000Z');
  const closeResult = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'toggle_shift',
      baseVersion: beforeState.version,
      shiftId: targetShift.id,
      open: false
    },
    now: closeNow
  });

  assert.equal(closeResult.previousVersion, beforeState.version);
  assert.equal(closeResult.version, beforeState.version + 1);
  assert.equal(closeResult.shiftLegacyId, targetShift.id);
  assert.equal(closeResult.previousOpen, true);
  assert.equal(closeResult.open, false);
  assert.equal(closeResult.changed, true);

  const afterCloseState = await readBookingStateFromPostgres(pool);
  const closedShift = afterCloseState.shifts.find(shift => shift.id === targetShift.id);
  assert.ok(closedShift);
  assert.equal(closedShift.open, false);
  assert.equal(closedShift.canceled, false);
  assert.equal(afterCloseState.version, closeResult.version);

  const noOpResult = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'toggle_shift',
      baseVersion: afterCloseState.version,
      shiftId: targetShift.id,
      open: false
    },
    now: new Date('2026-07-29T12:11:00.000Z')
  });
  assert.equal(noOpResult.changed, false);
  assert.equal(noOpResult.version, afterCloseState.version);

  const reopenNow = new Date('2026-07-29T12:12:00.000Z');
  const reopenResult = await toggleShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'toggle_shift',
      baseVersion: afterCloseState.version,
      shiftId: targetShift.id
    },
    now: reopenNow
  });

  assert.equal(reopenResult.previousVersion, afterCloseState.version);
  assert.equal(reopenResult.version, afterCloseState.version + 1);
  assert.equal(reopenResult.previousOpen, false);
  assert.equal(reopenResult.open, true);
  assert.equal(reopenResult.changed, true);

  const afterReopenState = await readBookingStateFromPostgres(pool);
  const reopenedShift = afterReopenState.shifts.find(shift => shift.id === targetShift.id);
  assert.ok(reopenedShift);
  assert.equal(reopenedShift.open, true);
  assert.equal(reopenedShift.canceled, false);
  assert.equal(afterReopenState.version, reopenResult.version);

  const eventResult = await pool.query(
    `
      SELECT event_type, payload
        FROM application_events
       WHERE shift_id = (
         SELECT id FROM shifts WHERE legacy_id = $1
       )
         AND event_type IN ('shift_closed', 'shift_opened')
       ORDER BY created_at ASC
    `,
    [targetShift.id]
  );
  const eventTypes = eventResult.rows.map(row => row.event_type);
  assert.ok(eventTypes.includes('shift_closed'));
  assert.ok(eventTypes.includes('shift_opened'));
  const closeEvent = eventResult.rows.find(row => row.event_type === 'shift_closed');
  assert.equal(closeEvent.payload.action, 'toggle_shift');
  assert.equal(closeEvent.payload.baseVersion, beforeState.version);
  assert.equal(closeEvent.payload.previousVersion, beforeState.version);
  assert.equal(closeEvent.payload.nextVersion, closeResult.version);
  assert.equal(closeEvent.payload.previousOpen, true);
  assert.equal(closeEvent.payload.nextOpen, false);

  await assert.rejects(
    () => toggleShiftInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'toggle_shift',
        baseVersion: afterReopenState.version - 1,
        shiftId: targetShift.id,
        open: false
      },
      now: new Date('2026-07-29T12:13:00.000Z')
    }),
    PostgresCommandConflictError
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterReopenState.version);
  console.log('PostgreSQL toggle_shift write smoke test passed.');
} finally {
  await pool.end();
}
