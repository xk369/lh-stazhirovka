import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingConflictError,
  BookingValidationError,
  applyBookingCommand,
  bookingStateForActor,
  composeBookingStageChangedMessage,
  composeShiftCancellationMessage,
  composeShiftCapacityChangedMessage,
  shiftCapacityChangeNotificationPlan,
  traineeTableRowsFromState,
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

test('rejects duplicate internship dates', () => {
  assert.throws(
    () => applyBookingCommand(
      bookingState(),
      { action: 'create_shift', baseVersion: 2, date: '2026-07-10', seats: 2 },
      recruiterActor
    ),
    /Такая дата стажировки уже создана/
  );
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
            phone: '+7 999 123-45-67',
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

test('rejects trainee booking without registration phone', () => {
  assert.throws(
    () =>
      applyBookingCommand(
        bookingState(),
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

test('rejects non-Telegram invite group links on the server', () => {
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
              name: 'Confirmed Trainee',
              training: 'passed',
              attempt: 'first',
              status: 'confirmed'
            }
          ],
          inviteGroups: []
        },
        {
          action: 'send_invites',
          baseVersion: 4,
          shiftId: 1,
          venueId: 'loft1',
          link: 'https://example.com/not-a-telegram-group',
          memberIds: [10]
        },
        recruiterActor
      ),
    error =>
      error instanceof BookingValidationError &&
      /Telegram-ссылка/.test(error.message)
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
    mentorCommentDeliveryStatus: 'sent',
    experience: 'experienced'
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
  assert.equal(next.applications[0].experience, undefined);
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

test('marks only passed trainees as experienced', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Passed Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'passed'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'mark_experienced', baseVersion: 2, applicationId: 10 },
    recruiterActor
  );

  assert.equal(next.applications[0].experience, 'experienced');
});

test('rejects experienced status before the trainee passes internship', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Feedback Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'feedback'
  }];

  assert.throws(
    () => applyBookingCommand(
      source,
      { action: 'mark_experienced', baseVersion: 2, applicationId: 10 },
      recruiterActor
    ),
    /Опытным стажёром можно отметить только того, кто прошёл стажировку/
  );
});

test('legacy yes/no experience values do not block booking writes', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Legacy Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'queue',
    experience: 'yes'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'create_shift', baseVersion: 2, date: '2026-07-11', seats: 2 },
    recruiterActor
  );

  assert.equal(next.applications[0].experience, undefined);
});

test('trainee registry export includes experienced status', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Experienced Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'passed',
    experience: 'experienced'
  }];

  const rows = traineeTableRowsFromState(source);
  const csv = traineesCsvFromState(source);

  assert.equal(rows[0].experience, 'Опытный стажёр');
  assert.match(csv, /Статус опыта/);
  assert.match(csv, /Опытный стажёр/);
});

test('formats a clear status-change notification for the trainee', () => {
  const message = composeBookingStageChangedMessage({ status: 'feedback' }, 'passed');

  assert.match(message, /Этап стажировки изменён/);
  assert.match(message, /Стажировка пройдена/);
  assert.match(message, /Текущий статус:<\/b> Ждем отчет/);
});

test('cancels a shift and returns only pre-attendance candidates to the queue', () => {
  const source = bookingState();
  source.applications = [
    {
      id: 10,
      shiftId: 1,
      name: 'Pending Trainee',
      training: 'passed',
      attempt: 'first',
      status: 'pending'
    },
    {
      id: 11,
      shiftId: 1,
      name: 'Invited Trainee',
      training: 'passed',
      attempt: 'first',
      status: 'invited',
      inviteGroupId: 20,
      venueId: 'loft1',
      groupLink: 'https://t.me/+group'
    },
    {
      id: 12,
      shiftId: 1,
      name: 'Attended Trainee',
      training: 'passed',
      attempt: 'first',
      status: 'feedback',
      inviteGroupId: 20,
      venueId: 'loft1',
      groupLink: 'https://t.me/+group'
    }
  ];
  source.inviteGroups = [{
    id: 20,
    shiftId: 1,
    venueId: 'loft1',
    link: 'https://t.me/+group',
    memberIds: [11, 12],
    sentAt: '2026-07-10T12:00:00.000Z'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'cancel_shift', baseVersion: 2, shiftId: 1 },
    recruiterActor,
    new Date('2026-07-10T14:00:00.000Z')
  );

  assert.equal(next.shifts[0].open, false);
  assert.equal(next.shifts[0].canceled, true);
  assert.equal(next.shifts[0].canceledAt, '2026-07-10T14:00:00.000Z');
  assert.deepEqual(
    next.applications.slice(0, 2).map(application => ({
      status: application.status,
      shiftId: application.shiftId,
      inviteGroupId: application.inviteGroupId,
      groupLink: application.groupLink
    })),
    [
      { status: 'queue', shiftId: null, inviteGroupId: null, groupLink: '' },
      { status: 'queue', shiftId: null, inviteGroupId: null, groupLink: '' }
    ]
  );
  assert.equal(next.applications[2].status, 'feedback');
  assert.deepEqual(next.inviteGroups[0].memberIds, [12]);
});

test('cancels one trainee internship without affecting other trainees on the same shift', () => {
  const source = bookingState();
  source.applications = [
    {
      id: 10,
      shiftId: 1,
      name: 'Canceled Trainee',
      training: 'passed',
      attempt: 'first',
      status: 'invited',
      inviteGroupId: 20,
      venueId: 'loft1',
      groupLink: 'https://t.me/+group',
      mentorReport: true,
      mentorDecision: 'Стажировка пройдена'
    },
    {
      id: 11,
      shiftId: 1,
      name: 'Active Trainee',
      training: 'passed',
      attempt: 'first',
      status: 'invited',
      inviteGroupId: 20,
      venueId: 'loft1',
      groupLink: 'https://t.me/+group'
    }
  ];
  source.inviteGroups = [{
    id: 20,
    shiftId: 1,
    venueId: 'loft1',
    link: 'https://t.me/+group',
    memberIds: [10, 11],
    sentAt: '2026-07-10T12:00:00.000Z'
  }];

  const next = applyBookingCommand(
    source,
    { action: 'cancel_internship', baseVersion: 2, applicationId: 10 },
    recruiterActor
  );

  assert.equal(next.shifts[0].open, true);
  assert.equal(next.shifts[0].canceled, false);
  assert.deepEqual(
    {
      status: next.applications[0].status,
      shiftId: next.applications[0].shiftId,
      inviteGroupId: next.applications[0].inviteGroupId,
      venueId: next.applications[0].venueId,
      groupLink: next.applications[0].groupLink,
      mentorReport: next.applications[0].mentorReport
    },
    {
      status: 'queue',
      shiftId: null,
      inviteGroupId: null,
      venueId: null,
      groupLink: '',
      mentorReport: false
    }
  );
  assert.equal(next.applications[1].status, 'invited');
  assert.equal(next.applications[1].shiftId, 1);
  assert.deepEqual(next.inviteGroups[0].memberIds, [11]);
});

test('does not cancel internship after trainee attendance is already marked', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: 1,
    name: 'Attended Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'feedback',
    inviteGroupId: 20,
    venueId: 'loft1',
    groupLink: 'https://t.me/+group'
  }];

  assert.throws(
    () => applyBookingCommand(
      source,
      { action: 'cancel_internship', baseVersion: 2, applicationId: 10 },
      recruiterActor
    ),
    BookingValidationError
  );
});

test('formats the shift cancellation message with a new-date instruction', () => {
  const message = composeShiftCancellationMessage({ date: '2026-07-11' });

  assert.match(message, /Стажировка отменена/);
  assert.match(message, /11\.07\.2026/);
  assert.match(message, /выберите другую доступную дату/);
});

test('allows a canceled trainee returned to queue to choose another shift', () => {
  const source = bookingState();
  source.applications = [{
    id: 10,
    shiftId: null,
    name: 'Queued Trainee',
    training: 'passed',
    attempt: 'first',
    status: 'queue',
    telegramUserId: '999'
  }];

  const next = applyBookingCommand(
    source,
    {
      action: 'upsert_trainee_application',
      baseVersion: 2,
      application: {
        id: 10,
        shiftId: 1,
        name: 'Queued Trainee',
        phone: '+7 999 000-11-22',
        training: 'passed',
        attempt: 'first',
        status: 'pending'
      }
    },
    traineeActor
  );

  assert.equal(next.applications[0].shiftId, 1);
  assert.equal(next.applications[0].status, 'pending');
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
        phone: '+7 999 123-45-67',
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

  assert.ok(csv.startsWith('\uFEFFID;ФИО;Телефон;Статус;'));
  assert.match(csv, /Иванов Иван/);
  assert.match(csv, /\+7 999 123-45-67/);
  assert.match(csv, /Ждем отчет/);
  assert.match(csv, /2026-07-10/);
  assert.match(csv, /LOFT#5 SMALL/);
  assert.match(csv, /@ivanov/);
  assert.match(csv, /Стажировка пройдена/);
});

test('cancellation message no longer mentions an event', () => {
  const message = composeShiftCancellationMessage({ date: '2026-07-11' });

  assert.doesNotMatch(message, /мероприятие/i);
  assert.match(message, /Стажировка отменена/);
  assert.match(message, /стажировка на .* не состоится/is);
});

test('recruiter can increase internship capacity for a date', () => {
  const next = applyBookingCommand(
    bookingState(),
    { action: 'update_shift_capacity', baseVersion: 2, shiftId: 1, seats: 6 },
    recruiterActor
  );

  assert.equal(next.shifts[0].seats, 6);
});

test('recruiter can decrease capacity down to (but not below) the assigned-trainee count', () => {
  const source = bookingState();
  source.applications = [
    { id: 10, shiftId: 1, name: 'A', training: 'passed', attempt: 'first', status: 'pending' },
    { id: 11, shiftId: 1, name: 'B', training: 'passed', attempt: 'first', status: 'confirmed' },
    { id: 12, shiftId: 1, name: 'C', training: 'passed', attempt: 'first', status: 'invited' },
    { id: 13, shiftId: 1, name: 'D', training: 'passed', attempt: 'first', status: 'feedback' },
    { id: 14, shiftId: 1, name: 'E', training: 'passed', attempt: 'first', status: 'passed' }
  ];

  const next = applyBookingCommand(
    source,
    { action: 'update_shift_capacity', baseVersion: 2, shiftId: 1, seats: 5 },
    recruiterActor
  );

  assert.equal(next.shifts[0].seats, 5);
  assert.deepEqual(
    next.applications.map(app => app.status),
    ['pending', 'confirmed', 'invited', 'feedback', 'passed']
  );
});

test('rejects reducing capacity below the number of already assigned trainees', () => {
  const source = bookingState();
  source.applications = [
    { id: 10, shiftId: 1, name: 'A', training: 'passed', attempt: 'first', status: 'pending' },
    { id: 11, shiftId: 1, name: 'B', training: 'passed', attempt: 'first', status: 'confirmed' },
    { id: 12, shiftId: 1, name: 'C', training: 'passed', attempt: 'first', status: 'invited' },
    { id: 13, shiftId: 1, name: 'D', training: 'passed', attempt: 'first', status: 'feedback' },
    { id: 14, shiftId: 1, name: 'E', training: 'passed', attempt: 'first', status: 'passed' }
  ];

  assert.throws(
    () =>
      applyBookingCommand(
        source,
        { action: 'update_shift_capacity', baseVersion: 2, shiftId: 1, seats: 3 },
        recruiterActor
      ),
    error =>
      error instanceof BookingValidationError &&
      error.message === 'Нельзя уменьшить количество мест до 3: на эту дату уже записано 5 стажёров.'
  );

  // rejected change must leave the existing state completely untouched
  assert.equal(source.shifts[0].seats, 3);
  assert.equal(source.applications.length, 5);
  assert.deepEqual(
    source.applications.map(app => app.status),
    ['pending', 'confirmed', 'invited', 'feedback', 'passed']
  );
});

test('an unchanged capacity produces no notification plan', () => {
  const previous = bookingState();
  const next = { ...previous, shifts: previous.shifts.map(shift => ({ ...shift })) };

  assert.equal(shiftCapacityChangeNotificationPlan(previous, next, 1), null);
});

test('a real capacity change notifies only trainees still upcoming on that date', () => {
  const previous = bookingState();
  previous.applications = [
    { id: 10, shiftId: 1, name: 'A', status: 'pending', telegramChatId: '100001' },
    { id: 11, shiftId: 1, name: 'B', status: 'confirmed', telegramChatId: '100002' },
    { id: 12, shiftId: 1, name: 'C', status: 'invited', telegramChatId: '100003' },
    { id: 13, shiftId: 1, name: 'D', status: 'feedback', telegramChatId: '100004' },
    { id: 14, shiftId: 1, name: 'E', status: 'passed', telegramChatId: '100005' }
  ];

  const next = applyBookingCommand(
    previous,
    { action: 'update_shift_capacity', baseVersion: 2, shiftId: 1, seats: 5 },
    recruiterActor
  );

  const plan = shiftCapacityChangeNotificationPlan(previous, next, 1);
  assert.ok(plan);
  assert.equal(plan.shift.seats, 5);
  assert.deepEqual(plan.applications.map(app => app.id), [10, 11, 12]);
  // application statuses/assignments themselves must be untouched by the capacity change
  assert.deepEqual(
    next.applications.map(app => ({ id: app.id, status: app.status, shiftId: app.shiftId })),
    previous.applications.map(app => ({ id: app.id, status: app.status, shiftId: app.shiftId }))
  );
});

test('capacity change notification does not reveal old or new seat counts', () => {
  const text = composeShiftCapacityChangedMessage({ date: '2026-07-11' });

  assert.match(text, /Изменения по стажировке/);
  assert.match(text, /11\.07\.2026/);
  assert.match(text, /Ваша запись на эту дату сохраняется/);
  assert.match(text, /Дополнительных действий не требуется/);
  assert.doesNotMatch(text, /\d+\s*(мест|места|мес)\b/i);
});

test('closing a date keeps existing trainee assignments untouched', () => {
  const source = bookingState();
  source.applications = [{ id: 10, shiftId: 1, name: 'A', training: 'passed', attempt: 'first', status: 'confirmed' }];

  const next = applyBookingCommand(
    source,
    { action: 'toggle_shift', baseVersion: 2, shiftId: 1, open: false },
    recruiterActor
  );

  assert.equal(next.shifts[0].open, false);
  assert.equal(next.applications[0].status, 'confirmed');
  assert.equal(next.applications[0].shiftId, 1);
});
