import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  mentorReportResultInPostgres
} from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const mentor = {
  role: 'mentor',
  telegram: {
    user: {
      id: 'postgres-smoke-mentor',
      username: 'mentor_smoke',
      first_name: 'Mentor',
      last_name: 'Smoke'
    }
  }
};

const SHIFT_LEGACY_ID = 950000;
const INVITE_GROUP_LEGACY_ID = 950100;
const APP_LEGACY_ID = 950001;

async function seedMentorReportApplication(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftUuid = randomUUID();
    const groupUuid = randomUUID();
    const appUuid = randomUUID();

    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled,
          created_at, updated_at
        )
        VALUES ($1, $2, '2026-09-18', 2, true, false, $3, $3)
      `,
      [shiftUuid, SHIFT_LEGACY_ID, seedIso]
    );

    await client.query(
      `
        INSERT INTO invite_groups (
          id, legacy_id, shift_id, venue_id, link, sent_at,
          created_by_telegram_user_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'loft5_small', 'https://t.me/+mentor_report_smoke', $4, $5, $4, $4)
      `,
      [groupUuid, INVITE_GROUP_LEGACY_ID, shiftUuid, seedIso, 'postgres-smoke-recruiter']
    );

    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          venue_id, group_link,
          candidate_report, experience,
          mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
          mentor_decision, mentor_report_venue_id, mentor_report_venue,
          mentor_report_loft, mentor_report_hall,
          mentor_comment_for_trainee, mentor_comment_sent_at,
          mentor_comment_delivery_status, mentor_comment_delivery_error,
          created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4,
          '950001', '950001', 'mentor_report_waiting',
          'Mentor Report Waiting', '+7 999 050-00-01',
          'passed', '2026-08-01', 'first', '', 'feedback',
          'loft5_small', 'https://t.me/+mentor_report_smoke',
          false, NULL,
          false, NULL, NULL,
          '', '', '',
          '', '',
          '', NULL,
          NULL, '',
          $5, $5
        )
      `,
      [appUuid, APP_LEGACY_ID, shiftUuid, groupUuid, seedIso]
    );

    await client.query(
      'INSERT INTO invite_group_members (invite_group_id, application_id, created_at) VALUES ($1, $2, $3)',
      [groupUuid, appUuid, seedIso]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
    return { shiftUuid, groupUuid, appUuid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-30T10:00:00.000Z';
  const seeded = await seedMentorReportApplication(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const waitingApp = seededState.applications.find(app => Number(app.id) === APP_LEGACY_ID);
  assert.equal(waitingApp.status, 'feedback');
  assert.equal(waitingApp.mentorReport, false);

  const now = new Date('2026-07-30T10:05:00.000Z');
  const result = await mentorReportResultInPostgres({
    pool,
    actor: mentor,
    command: {
      action: 'mentor_report_result',
      applicationId: APP_LEGACY_ID,
      mentorTraineeName: 'Mentor Report Waiting',
      mentorDecision: 'Стажировка пройдена',
      mentorCommentForTrainee: 'Комментарий наставника для внутренней истории.',
      reportText: 'Полный текст отчёта наставника.',
      mentorTraineeResult: {
        date: '2026-09-18',
        venue: 'LOFT #5 · SMALL',
        venueId: 'loft5_small',
        venueLoft: 'LOFT #5',
        hall: 'SMALL',
        mastered: 28,
        total: 29,
        decision: 'Стажировка пройдена',
        topicsToRepeat: [
          { order: 16, title: 'Синхронная подача и сервировка тарелок' }
        ]
      }
    },
    reportChatId: '-1000000000002',
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousStatus, 'feedback');
  assert.equal(result.nextStatus, 'passed');
  assert.equal(result.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(result.shiftAutoClosed, true);
  assert.deepEqual(result.notifications, {
    total: 2,
    pending: 2,
    skipped: 0,
    inserted: 2
  });
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  const passedApp = afterState.applications.find(app => Number(app.id) === APP_LEGACY_ID);
  assert.equal(passedApp.status, 'passed');
  assert.equal(passedApp.mentorReport, true);
  assert.equal(passedApp.mentorDecision, 'Стажировка пройдена');
  assert.equal(passedApp.mentorReportVenueId, 'loft5_small');
  assert.equal(passedApp.mentorReportHall, 'SMALL');
  assert.equal(passedApp.mentorCommentDeliveryStatus, '');

  const closedShift = afterState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.equal(closedShift.open, false);

  const reportRows = await pool.query(
    `
      SELECT mentor_reports.id,
             mentor_reports.result_status,
             mentor_reports.source,
             mentor_reports.mastered,
             mentor_reports.total,
             mentor_reports.trainee_message_text
        FROM mentor_reports
        JOIN applications ON applications.id = mentor_reports.application_id
       WHERE applications.legacy_id = $1
         AND mentor_reports.voided_at IS NULL
    `,
    [APP_LEGACY_ID]
  );
  assert.equal(reportRows.rowCount, 1);
  assert.equal(reportRows.rows[0].result_status, 'passed');
  assert.equal(reportRows.rows[0].source, 'api_report');
  assert.equal(Number(reportRows.rows[0].mastered), 28);
  assert.equal(Number(reportRows.rows[0].total), 29);
  assert.ok(reportRows.rows[0].trainee_message_text.includes('📋 <b>Итоги стажировки</b>'));

  const topicRows = await pool.query(
    'SELECT topic_order, title FROM mentor_report_topics WHERE mentor_report_id = $1',
    [reportRows.rows[0].id]
  );
  assert.equal(topicRows.rowCount, 1);
  assert.equal(Number(topicRows.rows[0].topic_order), 16);

  const notificationRows = await pool.query(
    `
      SELECT mentor_report_id, type, status, chat_id, chat_target, idempotency_key, text
        FROM notifications
       WHERE application_id = $1
       ORDER BY type
    `,
    [seeded.appUuid]
  );
  assert.equal(notificationRows.rowCount, 2);
  const reportGroupNotification = notificationRows.rows.find(row => row.type === 'mentor_report');
  const traineeNotification = notificationRows.rows.find(row => row.type === 'mentor_result');
  assert.equal(reportGroupNotification.mentor_report_id, reportRows.rows[0].id);
  assert.equal(reportGroupNotification.status, 'pending');
  assert.equal(reportGroupNotification.chat_id, '-1000000000002');
  assert.equal(reportGroupNotification.chat_target, 'mentor_report_group');
  assert.equal(reportGroupNotification.text, 'Полный текст отчёта наставника.');
  assert.match(reportGroupNotification.idempotency_key, /^mentor_report_group:950001:/);
  assert.equal(traineeNotification.mentor_report_id, reportRows.rows[0].id);
  assert.equal(traineeNotification.status, 'pending');
  assert.equal(traineeNotification.chat_target, 'trainee');
  assert.match(traineeNotification.idempotency_key, /^mentor_report_result:950001:/);

  const eventRows = await pool.query(
    `
      SELECT event_type
        FROM application_events
       WHERE application_id = $1
       ORDER BY created_at, event_type
    `,
    [seeded.appUuid]
  );
  assert.deepEqual(
    eventRows.rows.map(row => row.event_type).sort(),
    [
      'application_passed',
      'mentor_report_received',
      'mentor_report_group_notification_queued',
      'mentor_result_notification_queued'
    ].sort()
  );

  const shiftEventRows = await pool.query(
    `
      SELECT event_type
        FROM application_events
       WHERE shift_id = $1
         AND event_type = 'shift_auto_closed'
    `,
    [seeded.shiftUuid]
  );
  assert.equal(shiftEventRows.rowCount, 1);

  await assert.rejects(
    () => mentorReportResultInPostgres({
      pool,
      actor: mentor,
      command: {
        action: 'mentor_report_result',
        applicationId: APP_LEGACY_ID,
        mentorTraineeName: 'Mentor Report Waiting',
        mentorDecision: 'Стажировка пройдена',
        reportText: 'Повторная отправка',
        mentorTraineeResult: {
          date: '2026-09-18',
          venue: 'LOFT #5 · SMALL',
          venueId: 'loft5_small',
          venueLoft: 'LOFT #5',
          hall: 'SMALL',
          mastered: 29,
          total: 29,
          decision: 'Стажировка пройдена',
          topicsToRepeat: []
        }
      },
      now: new Date('2026-07-30T10:06:00.000Z')
    }),
    PostgresCommandConflictError
  );

  const duplicateReportRows = await pool.query(
    `
      SELECT count(*)::int AS count
        FROM mentor_reports
        JOIN applications ON applications.id = mentor_reports.application_id
       WHERE applications.legacy_id = $1
         AND mentor_reports.voided_at IS NULL
    `,
    [APP_LEGACY_ID]
  );
  assert.equal(Number(duplicateReportRows.rows[0].count), 1);

  console.log('PostgreSQL mentor_report_result write smoke passed.');
} finally {
  await pool.end();
}
