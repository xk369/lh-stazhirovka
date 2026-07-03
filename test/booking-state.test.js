import assert from 'node:assert/strict';
import test from 'node:test';
import { BookingConflictError, applyBookingCommand } from '../src/server.js';

const recruiterActor = {
  role: 'recruiter',
  userId: '1294774551',
  telegram: { user: { id: 1294774551, username: 'recruiter' } }
};

function bookingState() {
  return {
    version: 2,
    updatedAt: '2026-07-03T00:00:00.000Z',
    shifts: [{ id: 1, date: '2026-07-10', seats: 3, open: true }],
    applications: [],
    inviteGroups: []
  };
}

test('rejects stale booking command versions', () => {
  assert.throws(
    () =>
      applyBookingCommand(
        bookingState(),
        { action: 'create_shift', baseVersion: 1, date: '2026-07-11', seats: 2 },
        recruiterActor
      ),
    BookingConflictError
  );
});

test('applies booking command when baseVersion is fresh', () => {
  const next = applyBookingCommand(
    bookingState(),
    { action: 'create_shift', baseVersion: 2, date: '2026-07-11', seats: 2 },
    recruiterActor,
    new Date('2026-07-03T01:00:00.000Z')
  );

  assert.equal(next.version, 3);
  assert.equal(next.updatedAt, '2026-07-03T01:00:00.000Z');
  assert.equal(next.shifts.length, 2);
});
