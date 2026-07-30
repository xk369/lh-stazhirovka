import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  clearStateInPostgres,
  resetDemoStateInPostgres
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
  const beforeClearState = await readBookingStateFromPostgres(pool);
  assert.ok(beforeClearState.shifts.length > 0, 'admin smoke expects populated state before clear');
  assert.ok(beforeClearState.applications.length > 0, 'admin smoke expects applications before clear');

  const clearNow = new Date('2026-07-29T23:00:00.000Z');
  const clearResult = await clearStateInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'clear_state',
      baseVersion: beforeClearState.version
    },
    now: clearNow
  });
  assert.equal(clearResult.previousVersion, beforeClearState.version);
  assert.equal(clearResult.version, beforeClearState.version + 1);
  assert.ok(clearResult.removed.shifts >= beforeClearState.shifts.length);
  assert.ok(clearResult.removed.applications >= beforeClearState.applications.length);

  const afterClearState = await readBookingStateFromPostgres(pool);
  assert.equal(afterClearState.version, clearResult.version);
  assert.equal(afterClearState.shifts.length, 0);
  assert.equal(afterClearState.applications.length, 0);
  assert.equal(afterClearState.inviteGroups.length, 0);

  const clearEventResult = await pool.query(
    `
      SELECT payload
        FROM application_events
       WHERE event_type = 'booking_state_cleared'
       ORDER BY created_at DESC
       LIMIT 1
    `
  );
  assert.equal(clearEventResult.rowCount, 1);
  assert.equal(clearEventResult.rows[0].payload.action, 'clear_state');
  assert.equal(clearEventResult.rows[0].payload.previousVersion, beforeClearState.version);
  assert.equal(clearEventResult.rows[0].payload.nextVersion, clearResult.version);

  const resetNow = new Date('2026-07-29T23:05:00.000Z');
  const resetResult = await resetDemoStateInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'reset_demo_state',
      baseVersion: afterClearState.version
    },
    now: resetNow
  });
  assert.equal(resetResult.previousVersion, afterClearState.version);
  assert.equal(resetResult.version, afterClearState.version + 1);
  assert.deepEqual(resetResult.inserted, { shifts: 3, applications: 3, inviteGroups: 0 });

  const afterResetState = await readBookingStateFromPostgres(pool);
  assert.equal(afterResetState.version, resetResult.version);
  assert.equal(afterResetState.shifts.length, 3);
  assert.equal(afterResetState.applications.length, 3);
  assert.deepEqual(afterResetState.applications.map(app => app.status).sort(), ['confirmed', 'pending', 'queue']);

  const resetEventResult = await pool.query(
    `
      SELECT payload
        FROM application_events
       WHERE event_type = 'booking_state_reset'
       ORDER BY created_at DESC
       LIMIT 1
    `
  );
  assert.equal(resetEventResult.rowCount, 1);
  assert.equal(resetEventResult.rows[0].payload.action, 'reset_demo_state');
  assert.equal(resetEventResult.rows[0].payload.previousVersion, afterClearState.version);
  assert.equal(resetEventResult.rows[0].payload.nextVersion, resetResult.version);
  assert.deepEqual(resetEventResult.rows[0].payload.inserted, { shifts: 3, applications: 3, inviteGroups: 0 });

  await assert.rejects(
    () => clearStateInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'clear_state',
        baseVersion: afterResetState.version - 1
      },
      now: new Date('2026-07-29T23:06:00.000Z')
    }),
    PostgresCommandConflictError
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterResetState.version);
  console.log('PostgreSQL clear_state/reset_demo_state write smoke passed.');
} finally {
  await pool.end();
}
