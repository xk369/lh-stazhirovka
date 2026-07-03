import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingConflictError,
  BookingValidationError,
  applyBookingCommand,
  bookingStateForActor
} from '../src/server.js';

const recruiterActor = {
  role: 'recruiter',
  userId: '1294774551',
  telegram: { user: { id: 1294774551, username: 'recruiter' } }
};

const traineeActor = {
  role: 'trainee',
  userId: '999',
  telegram: { user: { id: 999, username: 'trainee' } }
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

test('public booking state exposes server-side seat availability without leaking other applications', () => {
  const result = bookingStateForActor(
    {
      version: 3,
      updatedAt: '2026-07-03T00:00:00.000Z',
      shifts: [{ id: 1, date: '2026-07-10', seats: 4, open: true }],
      applications: [
        { id: 10, shiftId: 1, name: 'Own Trainee', status: 'pending', telegramUserId: '999' },
        { id: 11, shiftId: 1, name: 'Other Pending', status: 'pending', telegramUserId: '111' },
        { id: 12, shiftId: 1, name: 'Other Passed', status: 'passed', telegramUserId: '222' },
        { id: 13, shiftId: null, name: 'Queue Trainee', status: 'queue', telegramUserId: '333' }
      ],
      inviteGroups: []
    },
    traineeActor
  );

  assert.equal(result.shifts[0].bookedSeats, 3);
  assert.equal(result.shifts[0].remainingSeats, 1);
  assert.deepEqual(result.applications.map(application => application.id), [10]);
});

test('rejects trainee booking when shift has no free seats', () => {
  assert.throws(
    () =>
      applyBookingCommand(
        {
          version: 2,
          updatedAt: '2026-07-03T00:00:00.000Z',
          shifts: [{ id: 1, date: '2026-07-10', seats: 1, open: true }],
          applications: [
            {
              id: 10,
              shiftId: 1,
              name: 'Existing Trainee',
              training: 'passed',
              attempt: 'first',
              status: 'pending',
              telegramUserId: '111'
            }
          ],
          inviteGroups: []
        },
        {
          action: 'upsert_trainee_application',
          baseVersion: 2,
          application: {
            id: 20,
            shiftId: 1,
            name: 'New Trainee',
            training: 'passed',
            attempt: 'first',
            status: 'pending'
          }
        },
        traineeActor
      ),
    BookingValidationError
  );
});
