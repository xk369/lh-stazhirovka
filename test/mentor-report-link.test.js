import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMentorReportResultToBookingState,
  composeMentorTraineeResultMessage,
  ensureMentorReportTargetMatches,
  ensureMentorReportVenueMatches,
  findMentorReportApplicationForLookup,
  mentorAnalyticsFromState,
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
      },
      {
        id: 6,
        shiftId: 1,
        name: 'Яковлев Ян',
        training: 'passed',
        attempt: 'first',
        limits: '',
        status: 'feedback',
        comment: '',
        inviteGroupId: 10,
        venueId: 'loft1',
        groupLink: 'https://t.me/+invite',
        telegramCode: '',
        telegramChatId: '100006',
        telegramUserId: '100006',
        telegramUsername: 'yakovlev',
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
        memberIds: [1, 2, 4, 6],
        sentAt: '2026-07-03T01:00:00.000Z'
      }
    ]
  };
}

test('mentor trainee list includes only invited group members waiting for report/final result', () => {
  const trainees = mentorTraineesFromState(stateWithApplications());

  assert.deepEqual(trainees.map(item => item.applicationId), [1, 6]);
  assert.equal(trainees[0].telegramUsername, '@ivanov');
  assert.equal(trainees[0].telegramChatAvailable, true);
  assert.equal(trainees[0].statusLabel, 'Приглашен в группу');
  assert.equal(trainees[1].statusLabel, 'Ждет отчет');
});

test('mentor report result marks application as passed and stores delivery status', () => {
  const next = applyMentorReportResultToBookingState(
    stateWithApplications(),
      {
        applicationId: 1,
        reporterTelegramUserId: '1294774551',
        reporterName: 'Софья Сучкова',
        reporterUsername: 'user6319642',
        mentorDecision: 'Стажировка пройдена',
        mentorCommentForTrainee: 'Потренировать сервировку и подачу напитков.',
      mentorTraineeResult: {
        venueId: 'loft1',
        venue: 'LOFT #1 · AVANTAGE',
        venueLoft: 'LOFT #1',
        hall: 'AVANTAGE'
      },
      traineeMessage: {
        status: 'sent',
        sentAt: '2026-07-03T03:00:00.000Z'
      }
    },
    new Date('2026-07-03T03:00:00.000Z')
  );

  const application = next.applications.find(item => item.id === 1);
  assert.equal(next.version, 2);
  assert.equal(application.status, 'passed');
  assert.equal(application.mentorReport, true);
  assert.equal(application.mentorReportAt, '2026-07-03T03:00:00.000Z');
  assert.equal(application.mentorReporterName, 'Софья Сучкова');
  assert.equal(application.mentorReporterTelegramUsername, 'user6319642');
  assert.equal(application.mentorCommentDeliveryStatus, 'sent');
  assert.equal(application.mentorCommentForTrainee, 'Потренировать сервировку и подачу напитков.');
  assert.equal(application.mentorReportVenueId, 'loft1');
  assert.equal(application.mentorReportLoft, 'LOFT #1');
  assert.equal(application.mentorReportHall, 'AVANTAGE');
  assert.equal(application.mentorReportVenue, 'LOFT #1 · AVANTAGE');
});

test('mentor report target check rejects mismatched trainee name and application', () => {
  assert.doesNotThrow(() =>
    ensureMentorReportTargetMatches({ name: 'Неудахина Виктория Дмитриевна' }, 'Неудахина Виктория Дмитриевна')
  );
  assert.doesNotThrow(() =>
    ensureMentorReportTargetMatches({ name: 'Семёнова Анна' }, 'Семенова Анна')
  );
  assert.throws(
    () => ensureMentorReportTargetMatches({ name: 'Неудахина Виктория Дмитриевна' }, 'Плешакова Милана Александровна'),
    /Выбранный стажёр не совпадает с заявкой/
  );
});

test('mentor report venue check locks hall to trainee booking venue', () => {
  const application = stateWithApplications().applications[0];

  assert.doesNotThrow(() =>
    ensureMentorReportVenueMatches(application, {
      venueId: 'loft1',
      venueLoft: 'LOFT #1',
      hall: 'CHATEAU',
      venue: 'LOFT #1 · CHATEAU'
    })
  );

  assert.throws(
    () => ensureMentorReportVenueMatches(application, {
      venueId: 'loft3',
      venueLoft: 'LOFT #3',
      hall: 'MONTBLANC',
      venue: 'LOFT #3 · MONTBLANC'
    }),
    /Площадка отчёта не совпадает/
  );

  assert.throws(
    () => ensureMentorReportVenueMatches(application, {
      venueId: 'loft1',
      venueLoft: 'LOFT #1',
      hall: 'MONTBLANC',
      venue: 'LOFT #1 · MONTBLANC'
    }),
    /Зал отчёта не относится/
  );
});

test('mentor report result marks application as failed when repeat internship is required', () => {
  const next = applyMentorReportResultToBookingState(
    stateWithApplications(),
    {
      applicationId: 1,
      reporterTelegramUserId: '1294774551',
      mentorDecision: 'Требуется повторная стажировка',
      mentorCommentForTrainee: 'Нужна повторная тренировка по стандартам.',
      traineeMessage: {
        status: 'sent',
        sentAt: '2026-07-03T03:00:00.000Z'
      }
    },
    new Date('2026-07-03T03:00:00.000Z')
  );

  const application = next.applications.find(item => item.id === 1);
  assert.equal(application.status, 'failed');
  assert.equal(application.mentorReport, true);
});

test('mentor analytics counts old linked reports by stored mentor id', () => {
  const state = stateWithApplications();
  state.applications[0] = {
    ...state.applications[0],
    status: 'passed',
    mentorReport: true,
    mentorDecision: 'Стажировка пройдена',
    mentorReporterTelegramUserId: '777',
    mentorReportAt: '2026-07-10T20:00:00.000Z'
  };
  state.applications[1] = {
    ...state.applications[1],
    status: 'failed',
    mentorReport: true,
    mentorDecision: 'Требуется повторная стажировка',
    mentorReporterTelegramUserId: '777',
    mentorReportAt: '2026-07-10T21:00:00.000Z'
  };

  const analytics = mentorAnalyticsFromState(state);

  assert.equal(analytics.totals.mentors, 1);
  assert.equal(analytics.totals.reports, 2);
  assert.equal(analytics.totals.passed, 1);
  assert.equal(analytics.totals.failed, 1);
  assert.equal(analytics.totals.waiting, 1);
  assert.equal(analytics.mentors[0].name, 'Наставник ID 777');
  assert.deepEqual(analytics.mentors[0].trainees.map(item => item.applicationId).sort(), [1, 2]);
  assert.deepEqual(analytics.waiting.map(item => item.applicationId), [6]);
});

test('manual mentor report lookup links the matching booking application by trainee data', () => {
  const application = findMentorReportApplicationForLookup(
    stateWithApplications(),
    {
      traineeFio: 'Иванов Иван',
      traineeTelegram: '@ivanov',
      date: '2026-07-10'
    }
  );

  assert.equal(application?.id, 1);
});

test('manual mentor report lookup does not guess when trainee data is ambiguous', () => {
  const state = stateWithApplications();
  state.applications.push({
    ...state.applications[0],
    id: 7,
    name: 'Иванов Иван',
    telegramUsername: '',
    telegramChatId: '100007',
    telegramUserId: '100007'
  });

  const application = findMentorReportApplicationForLookup(
    state,
    {
      traineeFio: 'Иванов Иван',
      date: '2026-07-10'
    }
  );

  assert.equal(application, null);
});

test('mentor trainee result message hides mentor free-text comments', () => {
  const text = composeMentorTraineeResultMessage(
    { name: 'Иванов Иван' },
    {
      date: '2026-07-04',
      venue: 'LOFT #5 · SMALL',
      mastered: 26,
      total: 29,
      decision: 'Стажировка пройдена',
      topicsToRepeat: [
        { order: 16, title: 'Синхронная подача и сервировка тарелок' },
        { order: 23, title: 'Вынос горячих закусок и основных блюд' },
        { order: 25, title: 'Закрытие смены и порядок в рабочих зонах' }
      ],
      mentorCommentForTrainee: 'Этот текст стажер видеть не должен'
    }
  );

  assert.match(text, /📋 <b>Итоги стажировки<\/b>/);
  assert.match(text, /Дата: 04\.07\.2026/);
  assert.match(text, /Площадка: LOFT #5 · SMALL/);
  assert.match(text, /Освоено: 26 из 29 тем\./);
  assert.match(text, /• 16\. Синхронная подача и сервировка тарелок/);
  assert.match(text, /🟢 Стажировка пройдена\./);
  assert.doesNotMatch(text, /Этот текст стажер видеть не должен/);
});

test('mentor trainee result message congratulates when all topics are passed', () => {
  const text = composeMentorTraineeResultMessage(
    { name: 'Иванов Иван' },
    {
      date: '2026-07-04',
      venue: 'LOFT #5 · SMALL',
      mastered: 29,
      total: 29,
      decision: 'Стажировка пройдена',
      topicsToRepeat: []
    }
  );

  assert.match(text, /🎉 Поздравляем! Все темы успешно освоены\./);
  assert.match(text, /🟢 Стажировка пройдена\./);
});
