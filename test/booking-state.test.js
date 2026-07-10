import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingConflictError,
  BookingValidationError,
  applyBookingCommand,
  bookingStateForActor,
  composeBookingStageChangedMessage,
  traineesCsvFromState
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

test('rejects duplicate invite for already invited application', () => {
  assert.throws(
    () =>
      applyBookingCommand(
        {
          version: 4,
          updatedAt: '2026-07-03T00:00:00.000Z',
          shifts: [{ id: 1, date: '2026-07-10', seats: 3, open: true }],
          applications: [
            {
              id: 10,
              shiftId: 1,
              name: 'Invited Trainee',
              training: 'passed',
              attempt: 'first',
              status: 'invited',
              inviteGroupId: 1,
              venueId: 'loft1',
              groupLink: 'https://t.me/+old'
            }
          ],
          inviteGroups: [
            {
              id: 1,
              shiftId: 1,
              venueId: 'loft1',
              link: 'https://t.me/+old',
              memberIds: [10],
              sentAt: '2026-07-03T00:30:00.000Z'
            }
          ]
        },
        {
          action: 'send_invites',
          baseVersion: 4,
          shiftId: 1,
          venueId: 'loft1',
          link: 'https://t.me/+new',
          memberIds: [10]
        },
        recruiterActor
      ),
    BookingValidationError
  );
});

test('rejects attendance status before group invite is sent', () => {
  assert.throws(
    () =>
      applyBookingCommand(
        {
          version: 5,
          updatedAt: '2026-07-03T00:00:00.000Z',
          shifts: [{ id: 1, date: '2026-07-10', seats: 3, open: true }],
          applications: [
            {
              id: 10,
              shiftId: 1,
              name: 'Confirmed Trainee',
              training: 'passed',
              attempt: 'first',
              status: 'confirmed'
            }
          ],
          inviteGroups: []
        },
        { action: 'set_application_status', baseVersion: 5, applicationId: 10, status: 'feedback' },
        recruiterActor
      ),
    BookingValidationError
  );
});

test('allows attendance status after group invite is sent', () => {
  const next = applyBookingCommand(
    {
      version: 5,
      updatedAt: '2026-07-03T00:00:00.000Z',
      shifts: [{ id: 1, date: '2026-07-10', seats: 3, open: true }],
      applications: [
        {
          id: 10,
          shiftId: 1,
          name: 'Invited Trainee',
          training: 'passed',
          attempt: 'first',
          status: 'invited',
          inviteGroupId: 20,
          venueId: 'loft5_small',
          groupLink: 'https://t.me/+group'
        }
      ],
      inviteGroups: [
        {
          id: 20,
          shiftId: 1,
          venueId: 'loft5_small',
          link: 'https://t.me/+group',
          memberIds: [10],
          sentAt: '2026-07-03T00:30:00.000Z'
        }
      ]
    },
    { action: 'set_application_status', baseVersion: 5, applicationId: 10, status: 'feedback' },
    recruiterActor,
    new Date('2026-07-03T02:00:00.000Z')
  );

  assert.equal(next.applications[0].status, 'feedback');
});

test('steps a completed candidate back to feedback and clears the previous mentor result', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Completed Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'passed',
    inviteGroupId: 20,
    venueId: 'loft1',
    groupLink: 'https://t.me/+group',
    mentorReport: true,
    mentorReportAt: '2026-07-10T18:00:00.000Z',
    mentorReporterTelegramUserId: '100',
    mentorDecision: 'Стажировка пройдена',
    mentorCommentForTrainee: 'Old result',
    mentorCommentDeliveryStatus: 'sent'
  }];
  source.inviteGroups = [{
    id: 20,
    shiftId: 1,
    venueId: 'loft1',
    link: 'https://t.me/+group',
    memberIds: [10],
    sentAt: '2026-07-10T12:00:00.000Z'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'step_back_application', baseVersion: 2, applicationId: 10 },
    recruiterActor
  );

  assert.equal(next.applications[0].status, 'feedback');
  assert.equal(next.applications[0].mentorReport, false);
  assert.equal(next.applications[0].mentorDecision, '');
  assert.equal(next.applications[0].mentorCommentDeliveryStatus, '');
});

test('steps a no-show candidate back to the invitation stage', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'No-show Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'noshow',
    inviteGroupId: 20,
    venueId: 'loft1',
    groupLink: 'https://t.me/+group'
  }];
  source.inviteGroups = [{
    id: 20,
    shiftId: 1,
    venueId: 'loft1',
    link: 'https://t.me/+group',
    memberIds: [10],
    sentAt: '2026-07-10T12:00:00.000Z'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'step_back_application', baseVersion: 2, applicationId: 10 },
    recruiterActor
  );

  assert.equal(next.applications[0].status, 'invited');
});

test('rejects step back when the current status has no correction path', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Confirmed Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'confirmed'
  }];

  assert.throws(
    () => applyBookingCommand(
      source,
      { action: 'step_back_application', baseVersion: 2, applicationId: 10 },
      recruiterActor
    ),
    BookingValidationError
  );
});

test('formats a clear status-change notification for the trainee', () => {
  const message = composeBookingStageChangedMessage({ status: 'feedback' }, 'passed');

  assert.match(message, /Этап стажировки изменён/);
  assert.match(message, /Стажировка пройдена/);
  assert.match(message, /Текущий статус:<\/b> Ждем отчет/);
});

test('exports trainee table as excel-friendly csv', () => {
  const csv = traineesCsvFromState({
    version: 7,
    updatedAt: '2026-07-03T02:00:00.000Z',
    shifts: [{ id: 1, date: '2026-07-10', seats: 3, open: true }],
    applications: [
      {
        id: 10,
        shiftId: 1,
        name: 'Иванов Иван',
        training: 'passed',
        attempt: 'repeat',
        limits: 'После 17:00',
        status: 'feedback',
        inviteGroupId: 20,
        venueId: 'loft5_small',
        groupLink: 'https://t.me/+group',
        telegramUsername: 'ivanov',
        telegramUserId: '999',
        telegramChatId: '999',
        mentorReport: true,
        mentorReportAt: '2026-07-10T20:00:00.000Z',
        mentorDecision: 'Стажировка пройдена',
        mentorCommentDeliveryStatus: 'sent',
        createdAt: '2026-07-01T10:00:00.000Z'
      }
    ],
    inviteGroups: [
      {
        id: 20,
        shiftId: 1,
        venueId: 'loft5_small',
        link: 'https://t.me/+group',
        memberIds: [10],
        sentAt: '2026-07-03T00:30:00.000Z'
      }
    ]
  });

  assert.ok(csv.startsWith('\uFEFFID;ФИО;Статус;'));
  assert.match(csv, /Иванов Иван/);
  assert.match(csv, /Ждем отчет/);
  assert.match(csv, /2026-07-10/);
  assert.match(csv, /LOFT#5 SMALL/);
  assert.match(csv, /@ivanov/);
  assert.match(csv, /Стажировка пройдена/);
});
