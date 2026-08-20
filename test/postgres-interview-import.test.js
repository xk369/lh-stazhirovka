import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditInterviewStateShape,
  buildInterviewImportPlan
} from '../src/postgres/import-interview-state.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function interviewState() {
  return {
    schemaVersion: 3,
    version: 8,
    updatedAt: '2026-08-13T19:00:00.000Z',
    settings: {},
    slots: [
      {
        id: 'slot-001',
        title: 'Sobesedovanie LOFT HALL',
        date: '2026-08-13',
        time: '12:00',
        timezone: 'Europe/Moscow',
        venueId: 'loft23',
        venueLabel: 'LOFT#2/3',
        venueAddress: 'ul. Leninskaya Sloboda, 26s11',
        seats: 4,
        status: 'open',
        directionsMaterialId: 'loft_23_route',
        bookingText: 'Short booking text',
        createdAt: '2026-08-10T09:00:00.000Z',
        updatedAt: '2026-08-13T19:00:00.000Z'
      }
    ],
    candidates: [
      {
        id: 'cand-001',
        telegramId: '111',
        telegram: '@first_waiter',
        name: 'First Candidate',
        phone: '+79991112233',
        source: 'sobes_mvp',
        status: 'attended',
        candidateLayerStatus: 'resources_sent',
        interviewSlotId: 'slot-001',
        confirmationStatus: 'confirmed',
        confirmedAt: '2026-08-12T21:05:00.000Z',
        attendanceStatus: 'arrived',
        attendanceMarkedAt: '2026-08-13T12:03:00.000Z',
        registrationStatus: 'materials_sent',
        resourcesSentAt: '2026-08-13T12:30:00.000Z',
        resourceStepsSent: [
          { type: 'registration_bot', sentAt: '2026-08-13T12:30:00.000Z' },
          { type: 'staff_bot', sentAt: '2026-08-13T12:31:00.000Z' },
          { type: 'unattested_group', sentAt: '2026-08-13T12:32:00.000Z' },
          { type: 'helper_bot', sentAt: '2026-08-13T12:33:00.000Z' },
          { type: 'self_employment', sentAt: '2026-08-13T12:34:00.000Z' }
        ],
        linkClicks: [
          {
            linkType: 'registration_bot',
            url: 'https://t.me/LoftHallRegistrationBot',
            clickedAt: '2026-08-13T12:40:00.000Z'
          }
        ],
        createdAt: '2026-08-10T10:00:00.000Z',
        updatedAt: '2026-08-13T12:34:00.000Z'
      },
      {
        id: 'cand-002',
        telegramId: '',
        telegram: '@same_weak_identity',
        name: 'Same Weak Identity',
        phone: '+79990001122',
        status: 'waitlist',
        candidateLayerStatus: 'waiting_for_interview_date',
        confirmationStatus: 'not_requested',
        attendanceStatus: 'unknown',
        registrationStatus: 'not_started',
        waitlistJoinedAt: '2026-08-11T10:00:00.000Z',
        createdAt: '2026-08-11T10:00:00.000Z',
        updatedAt: '2026-08-11T10:00:00.000Z'
      },
      {
        id: 'cand-003',
        telegramId: '',
        telegram: '@same_weak_identity',
        name: 'Same Weak Identity',
        phone: '+79990001122',
        status: 'no_show',
        candidateLayerStatus: 'interview_no_show',
        interviewSlotId: 'slot-001',
        confirmationStatus: 'confirmed',
        attendanceStatus: 'no_show',
        attendanceMarkedAt: '2026-08-13T12:30:00.000Z',
        registrationStatus: 'not_started',
        createdAt: '2026-08-12T10:00:00.000Z',
        updatedAt: '2026-08-13T12:30:00.000Z'
      }
    ],
    notifications: [],
    events: [],
    stats: {}
  };
}

test('interview import plan maps sobes state into candidate/interview tables', () => {
  const plan = buildInterviewImportPlan(interviewState(), new Date('2026-08-13T19:00:00.000Z'));

  assert.equal(plan.interviewSlots.length, 1);
  assert.equal(plan.interviewParticipants.length, 3);
  assert.equal(plan.candidateProfiles.length, 3);
  assert.equal(plan.candidateResourceDeliveries.length, 5);
  assert.equal(plan.candidateLinkClicks.length, 1);
  assert.equal(plan.candidateEvents.length, 3);
  assert.ok(plan.candidateProfiles.every(profile => uuidPattern.test(profile.id)));
  assert.ok(plan.interviewSlots.every(slot => uuidPattern.test(slot.id)));
  assert.ok(plan.interviewParticipants.every(participant => uuidPattern.test(participant.id)));

  assert.deepEqual(
    plan.candidateResourceDeliveries.map(row => `${row.sequenceNo}:${row.resourceType}`),
    [
      '1:registration_bot',
      '2:staff_bot',
      '3:unattested_group',
      '4:helper_bot',
      '5:self_employment'
    ]
  );
});

test('interview import never merges candidates by weak identity fields', () => {
  const plan = buildInterviewImportPlan(interviewState());
  const weakCandidates = plan.candidateProfiles.filter(profile => profile.telegramUserId === null);

  assert.equal(weakCandidates.length, 2);
  assert.equal(new Set(weakCandidates.map(profile => profile.id)).size, 2);
});

test('interview import rejects multiple active rows for one Telegram profile', () => {
  const source = interviewState();
  source.candidates.push({
    ...source.candidates[0],
    id: 'cand-004',
    status: 'confirmed',
    candidateLayerStatus: 'interview_confirmed'
  });

  assert.throws(
    () => buildInterviewImportPlan(source),
    /multiple active interview participants/
  );
});

test('interview import rejects unknown candidate fields instead of silently losing them', () => {
  const source = interviewState();
  source.candidates[0].futureImportantField = 'must not disappear';

  assert.throws(
    () => auditInterviewStateShape(source),
    /candidates\[0\]\.futureImportantField/
  );
});
