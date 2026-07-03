import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMentorReportResultToBookingState,
  mentorTraineesFromState
} from '../src/server.js';

function stateWithApplications() {
  return {
    version: 1,
    updatedAt: '2026-07-03T00:00:00.000Z',
    shifts: [{ id: 1, date: '2026-07-10', seats: 5, open: true }],
    applications: [
      {
        id: 1,
        shiftId: 1,
        name: 'Иванов Иван',
        training: 'passed',
        attempt: 'first',
        limits: '',
        status: 'invited',
        comment: '',
        inviteGroupId: 10,
        venueId: 'loft1',
        groupLink: 'https://t.me/+invite',
        telegramCode: '',
        telegramChatId: '100001',
        telegramUserId: '100001',
        telegramUsername: 'ivanov',
        candidateReport: false,
        mentorReport: false
      },
      {
        id: 2,
        shiftId: 1,
        name: 'Петров Петр',
        training: 'passed',
        attempt: 'repeat',
        limits: '',
        status: 'feedback',
        comment: '',
        inviteGroupId: 10,
        venueId: 'loft1',
        groupLink: 'https://t.me/+invite',
        telegramCode: '',
        telegramChatId: '',
        telegramUserId: '',
        telegramUsername: '',
        candidateReport: false,
        mentorReport: true,
        mentorReportAt: '2026-07-03T02:00:00.000Z'
      },
      {
        id: 3,
        shiftId: 1,
        name: 'Сидоров Семен',
        training: 'not_passed',
        attempt: 'first',
        limits: '',
        status: 'confirmed',
        comment: '',
        inviteGroupId: null,
        venueId: null,
        groupLink: '',
        telegramCode: '',
        telegramChatId: '100003',
        telegramUserId: '100003',
        telegramUsername: '',
        candidateReport: false,
        mentorReport: false
      },
      {
        id: 4,
        shiftId: 1,
        name: 'Кузнецов Кирилл',
        training: 'passed',
        attempt: 'first',
        limits: '',
        status: 'noshow',
        comment: '',
        inviteGroupId: 10,
        venueId: 'loft1',
        groupLink: 'https://t.me/+invite',
        telegramCode: '',
        telegramChatId: '100004',
        telegramUserId: '100004',
        telegramUsername: '',
        candidateReport: false,
        mentorReport: false
      },
      {
        id: 5,
        shiftId: 1,
        name: 'Орлова Ольга',
        training: 'passed',
        attempt: 'first',
        limits: '',
        status: 'invited',
        comment: '',
        inviteGroupId: null,
        venueId: null,
        groupLink: '',
        telegramCode: '',
        telegramChatId: '100005',
        telegramUserId: '100005',
        telegramUsername: '',
        candidateReport: false,
        mentorReport: false
      }
    ],
    inviteGroups: [
      {
        id: 10,
        shiftId: 1,
        venueId: 'loft1',
        link: 'https://t.me/+invite',
        memberIds: [1, 2, 4],
        sentAt: '2026-07-03T01:00:00.000Z'
      }
    ]
  };
}

test('mentor trainee list includes only invited group members waiting for report/final result', () => {
  const trainees = mentorTraineesFromState(stateWithApplications());

  assert.deepEqual(trainees.map(item => item.applicationId), [1, 2]);
  assert.equal(trainees[0].telegramUsername, '@ivanov');
  assert.equal(trainees[0].telegramChatAvailable, true);
  assert.equal(trainees[1].statusLabel, 'Фидбек наставника отправлен');
  assert.equal(trainees[1].telegramChatAvailable, false);
});

test('mentor report result marks application as waiting for final feedback and stores delivery status', () => {
  const next = applyMentorReportResultToBookingState(
    stateWithApplications(),
    {
      applicationId: 1,
      reporterTelegramUserId: '1294774551',
      mentorDecision: 'Стажировка пройдена',
      mentorCommentForTrainee: 'Потренировать сервировку и подачу напитков.',
      traineeMessage: {
        status: 'sent',
        sentAt: '2026-07-03T03:00:00.000Z'
      }
    },
    new Date('2026-07-03T03:00:00.000Z')
  );

  const application = next.applications.find(item => item.id === 1);
  assert.equal(next.version, 2);
  assert.equal(application.status, 'feedback');
  assert.equal(application.mentorReport, true);
  assert.equal(application.mentorReportAt, '2026-07-03T03:00:00.000Z');
  assert.equal(application.mentorCommentDeliveryStatus, 'sent');
  assert.equal(application.mentorCommentForTrainee, 'Потренировать сервировку и подачу напитков.');
});
