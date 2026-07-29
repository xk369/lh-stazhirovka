import assert from 'node:assert/strict';
import test from 'node:test';
import { planBookingStateEvents } from '../src/booking-state-events.js';

const recruiterActor = {
  role: 'recruiter',
  userId: '1294774551',
  telegram: { user: { id: 1294774551, username: 'recruiter' } }
};

const mentorActor = {
  role: 'mentor',
  userId: '700',
  telegram: { user: { id: 700, username: 'mentor' } }
};

const now = new Date('2026-07-29T10:00:00.000Z');

function baseState() {
  return {
    version: 10,
    updatedAt: '2026-07-29T09:00:00.000Z',
    shifts: [{ id: 1, date: '2026-07-30', seats: 4, open: true }],
    applications: [{
      id: 100,
      shiftId: 1,
      name: 'Test Trainee',
      phone: '+7 999 000-00-00',
      training: 'passed',
      trainingDate: '2026-07-20',
      attempt: 'first',
      limits: '',
      status: 'confirmed',
      telegramUserId: '900',
      telegramChatId: '900',
      telegramUsername: 'trainee'
    }],
    inviteGroups: []
  };
}

test('booking state event planner records invite group sends and invited status transition', () => {
  const currentState = baseState();
  const nextState = {
    ...currentState,
    version: 11,
    applications: [{
      ...currentState.applications[0],
      status: 'invited',
      inviteGroupId: 200,
      venueId: 'loft5_small',
      groupLink: 'https://t.me/+group'
    }],
    inviteGroups: [{
      id: 200,
      shiftId: 1,
      venueId: 'loft5_small',
      link: 'https://t.me/+group',
      memberIds: [100],
      sentAt: '2026-07-29T09:30:00.000Z'
    }]
  };

  const events = planBookingStateEvents({
    currentState,
    nextState,
    actor: recruiterActor,
    cause: { action: 'send_invites', baseVersion: 10 },
    now
  });

  assert.deepEqual(events.map(event => event.eventType), [
    'invite_group_sent',
    'application_invited'
  ]);
  assert.equal(events[0].payload.inviteGroupId, 200);
  assert.deepEqual(events[0].payload.memberIds, [100]);
  assert.equal(events[1].applicationId, 100);
  assert.equal(events[1].payload.previousStatus, 'confirmed');
  assert.equal(events[1].payload.nextStatus, 'invited');
});

test('booking state event planner records attendance and mentor final result', () => {
  const currentState = {
    ...baseState(),
    applications: [{
      ...baseState().applications[0],
      status: 'feedback',
      inviteGroupId: 200,
      venueId: 'loft5_small',
      groupLink: 'https://t.me/+group'
    }],
    inviteGroups: [{
      id: 200,
      shiftId: 1,
      venueId: 'loft5_small',
      link: 'https://t.me/+group',
      memberIds: [100],
      sentAt: '2026-07-29T09:30:00.000Z'
    }]
  };
  const nextState = {
    ...currentState,
    version: 11,
    applications: [{
      ...currentState.applications[0],
      status: 'passed',
      mentorReport: true,
      mentorReportAt: '2026-07-29T09:50:00.000Z',
      mentorDecision: 'Стажировка пройдена',
      mentorReportVenueId: 'loft5_small',
      mentorReportHall: 'SMALL',
      mentorCommentDeliveryStatus: 'sent'
    }]
  };

  const events = planBookingStateEvents({
    currentState,
    nextState,
    actor: mentorActor,
    cause: { action: 'mentor_report_result' },
    now
  });

  assert.deepEqual(events.map(event => event.eventType), [
    'application_passed',
    'mentor_report_received'
  ]);
  assert.equal(events[0].actorType, 'mentor');
  assert.equal(events[0].actorTelegramUserId, '700');
  assert.equal(events[1].payload.mentorDecision, 'Стажировка пройдена');
  assert.equal(events[1].payload.mentorReportHall, 'SMALL');
  assert.equal(events[1].payload.mentorMessageStatus, 'sent');
});

test('booking state event planner records step back and mentor result cleanup', () => {
  const currentState = {
    ...baseState(),
    applications: [{
      ...baseState().applications[0],
      status: 'passed',
      inviteGroupId: 200,
      venueId: 'loft5_small',
      groupLink: 'https://t.me/+group',
      mentorReport: true,
      mentorDecision: 'Стажировка пройдена',
      mentorCommentDeliveryStatus: 'sent',
      experience: 'experienced'
    }]
  };
  const nextState = {
    ...currentState,
    version: 11,
    applications: [{
      ...currentState.applications[0],
      status: 'feedback',
      mentorReport: false,
      mentorDecision: '',
      mentorCommentDeliveryStatus: '',
      experience: ''
    }]
  };

  const events = planBookingStateEvents({
    currentState,
    nextState,
    actor: recruiterActor,
    cause: { action: 'step_back_application', baseVersion: 10 },
    now
  });

  assert.deepEqual(events.map(event => event.eventType), ['application_step_back']);
  assert.equal(events[0].payload.previousStatus, 'passed');
  assert.equal(events[0].payload.nextStatus, 'feedback');
});

test('booking state event planner records clear state as an explicit audit event', () => {
  const currentState = baseState();
  const nextState = {
    version: 11,
    updatedAt: '2026-07-29T10:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };

  const events = planBookingStateEvents({
    currentState,
    nextState,
    actor: recruiterActor,
    cause: { action: 'clear_state', baseVersion: 10 },
    now
  });

  assert.ok(events.some(event => event.eventType === 'booking_state_cleared'));
  const clearEvent = events.find(event => event.eventType === 'booking_state_cleared');
  assert.equal(clearEvent.payload.removedShifts, 1);
  assert.equal(clearEvent.payload.removedApplications, 1);
  assert.equal(clearEvent.actorType, 'recruiter');
});
