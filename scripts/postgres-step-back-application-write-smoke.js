import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  stepBackApplicationInPostgres
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

const SHIFT_LEGACY_ID = 930000;
const INVITE_GROUP_LEGACY_ID = 930100;
const PASSED_APP_LEGACY_ID = 930001;
const NOSHOW_APP_LEGACY_ID = 930002;

async function seedStepBackApplications(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftUuid = randomUUID();
    const groupUuid = randomUUID();
    const passedUuid = randomUUID();
    const noshowUuid = randomUUID();
    const reportUuid = randomUUID();

    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled,
          created_at, updated_at
        )
        VALUES ($1, $2, '2026-09-12', 4, false, false, $3, $3)
      `,
      [shiftUuid, SHIFT_LEGACY_ID, seedIso]
    );

    await client.query(
      `
        INSERT INTO invite_groups (
          id, legacy_id, shift_id, venue_id, link, sent_at,
          created_by_telegram_user_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'loft3', 'https://t.me/+step_back_smoke', $4, $5, $4, $4)
      `,
      [groupUuid, INVITE_GROUP_LEGACY_ID, shiftUuid, seedIso, recruiter.telegram.user.id]
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
        ) VALUES
          ($1, $2, $3, $4,
           '930001', '930001', 'step_back_passed',
           'Step Back Passed', '+7 999 030-00-01', 'passed', '2026-08-01',
           'first', '', 'passed',
           'loft3', 'https://t.me/+step_back_smoke',
           true, 'experienced',
           true, $7, 'mentor-smoke',
           'passed', 'loft3', 'LOFT #3',
           'LOFT #3', 'Большой зал',
           'Комментарий стажеру', $7,
           'sent', '',
           $7, $7),
          ($5, $6, $3, $4,
           '930002', '930002', 'step_back_noshow',
           'Step Back Noshow', '+7 999 030-00-02', 'not_passed', NULL,
           'repeat', '', 'noshow',
           'loft3', 'https://t.me/+step_back_smoke',
           false, NULL,
           false, NULL, NULL,
           '', '', '',
           '', '',
           '', NULL,
           NULL, '',
           $7, $7)
      `,
      [
        passedUuid,
        PASSED_APP_LEGACY_ID,
        shiftUuid,
        groupUuid,
        noshowUuid,
        NOSHOW_APP_LEGACY_ID,
        seedIso
      ]
    );

    await client.query(
      `
        INSERT INTO invite_group_members (invite_group_id, application_id, created_at)
        VALUES ($1, $2, $4), ($1, $3, $4)
      `,
      [groupUuid, passedUuid, noshowUuid, seedIso]
    );

    await client.query(
      `
        INSERT INTO mentor_reports (
          id, application_id, mentor_telegram_user_id, mentor_username,
          mentor_name, result_status, decision, mastered, total,
          venue_id, venue_label, venue_loft, hall,
          mentor_comment, trainee_message_text, report_text,
          source, created_at, voided_at
        )
        VALUES (
          $1, $2, 'mentor-smoke', 'mentor_smoke',
          'Mentor Smoke', 'passed', 'passed', 29, 29,
          'loft3', 'LOFT #3', 'LOFT #3', 'Большой зал',
          'Комментарий наставника', 'Текст стажеру', 'Полный отчет наставника',
          'postgres_step_back_smoke', $3, NULL
        )
      `,
      [reportUuid, passedUuid, seedIso]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
    return { shiftUuid, groupUuid, passedUuid, noshowUuid, reportUuid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T19:00:00.000Z';
  const seeded = await seedStepBackApplications(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const passedApp = seededState.applications.find(app => Number(app.id) === PASSED_APP_LEGACY_ID);
  const noshowApp = seededState.applications.find(app => Number(app.id) === NOSHOW_APP_LEGACY_ID);
  assert.equal(passedApp.status, 'passed');
  assert.equal(passedApp.mentorReport, true);
  assert.equal(passedApp.mentorCommentDeliveryStatus, 'sent');
  assert.equal(passedApp.experience, 'experienced');
  assert.equal(noshowApp.status, 'noshow');

  const firstStepBackNow = new Date('2026-07-29T19:05:00.000Z');
  const firstResult = await stepBackApplicationInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'step_back_application',
      baseVersion: seededState.version,
      applicationId: PASSED_APP_LEGACY_ID
    },
    now: firstStepBackNow
  });

  assert.equal(firstResult.changed, true);
  assert.equal(firstResult.applicationLegacyId, PASSED_APP_LEGACY_ID);
  assert.equal(firstResult.previousStatus, 'passed');
  assert.equal(firstResult.nextStatus, 'feedback');
  assert.equal(firstResult.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(firstResult.mentorReportVoided, true);
  assert.deepEqual(firstResult.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(firstResult.previousVersion, seededState.version);
  assert.equal(firstResult.version, seededState.version + 1);

  const afterPassedRollbackState = await readBookingStateFromPostgres(pool);
  assert.equal(afterPassedRollbackState.version, firstResult.version);
  const rolledBackPassedApp = afterPassedRollbackState.applications.find(
    app => Number(app.id) === PASSED_APP_LEGACY_ID
  );
  assert.equal(rolledBackPassedApp.status, 'feedback');
  assert.equal(rolledBackPassedApp.mentorReport, false);
  assert.equal(rolledBackPassedApp.mentorReportAt, '');
  assert.equal(rolledBackPassedApp.mentorReporterTelegramUserId, '');
  assert.equal(rolledBackPassedApp.mentorDecision, '');
  assert.equal(rolledBackPassedApp.mentorReportVenueId, '');
  assert.equal(rolledBackPassedApp.mentorReportVenue, '');
  assert.equal(rolledBackPassedApp.mentorReportLoft, '');
  assert.equal(rolledBackPassedApp.mentorReportHall, '');
  assert.equal(rolledBackPassedApp.mentorCommentForTrainee, '');
  assert.equal(rolledBackPassedApp.mentorCommentSentAt, '');
  assert.equal(rolledBackPassedApp.mentorCommentDeliveryStatus, '');
  assert.equal(rolledBackPassedApp.experience, undefined);
  assert.equal(Number(rolledBackPassedApp.shiftId), SHIFT_LEGACY_ID);
  assert.equal(Number(rolledBackPassedApp.inviteGroupId), INVITE_GROUP_LEGACY_ID);

  const reportResult = await pool.query(
    `
      SELECT voided_at
        FROM mentor_reports
       WHERE id = $1
    `,
    [seeded.reportUuid]
  );
  assert.equal(reportResult.rowCount, 1);
  assert.equal(new Date(reportResult.rows[0].voided_at).toISOString(), firstStepBackNow.toISOString());

  const firstEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.actor_type,
             application_events.actor_telegram_user_id,
             application_events.payload,
             applications.legacy_id AS application_legacy_id,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'application_step_back'
         AND applications.legacy_id = $1
    `,
    [PASSED_APP_LEGACY_ID]
  );
  assert.equal(firstEventResult.rowCount, 1);
  const firstEvent = firstEventResult.rows[0];
  assert.equal(firstEvent.actor_type, 'recruiter');
  assert.equal(firstEvent.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(firstEvent.application_legacy_id), PASSED_APP_LEGACY_ID);
  assert.equal(Number(firstEvent.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(firstEvent.payload.action, 'step_back_application');
  assert.equal(firstEvent.payload.previousStatus, 'passed');
  assert.equal(firstEvent.payload.nextStatus, 'feedback');
  assert.equal(firstEvent.payload.mentorReportVoided, true);
  assert.equal(firstEvent.payload.previousVersion, seededState.version);
  assert.equal(firstEvent.payload.nextVersion, firstResult.version);

  const firstNotificationResult = await pool.query(
    `
      SELECT notifications.type,
             notifications.status,
             notifications.chat_id,
             notifications.chat_target,
             notifications.parse_mode,
             notifications.text,
             notifications.idempotency_key
        FROM notifications
        JOIN applications ON applications.id = notifications.application_id
       WHERE applications.legacy_id = $1
         AND notifications.type = 'booking_stage_changed'
         AND notifications.created_at = $2::timestamptz
    `,
    [PASSED_APP_LEGACY_ID, firstStepBackNow.toISOString()]
  );
  assert.equal(firstNotificationResult.rowCount, 1);
  const firstNotification = firstNotificationResult.rows[0];
  assert.equal(firstNotification.status, 'pending');
  assert.equal(firstNotification.chat_id, '930001');
  assert.equal(firstNotification.chat_target, 'trainee');
  assert.equal(firstNotification.parse_mode, 'HTML');
  assert.match(firstNotification.text, /Этап стажировки изменён/);
  assert.match(firstNotification.text, /Стажировка пройдена/);
  assert.match(firstNotification.text, /Ждем отчет/);
  assert.match(firstNotification.idempotency_key, /^step_back_application:930001:/);

  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'step_back_application',
        baseVersion: afterPassedRollbackState.version - 1,
        applicationId: PASSED_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T19:07:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  const secondStepBackNow = new Date('2026-07-29T19:10:00.000Z');
  const secondResult = await stepBackApplicationInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'step_back_application',
      baseVersion: afterPassedRollbackState.version,
      applicationId: NOSHOW_APP_LEGACY_ID
    },
    now: secondStepBackNow
  });
  assert.equal(secondResult.previousStatus, 'noshow');
  assert.equal(secondResult.nextStatus, 'invited');
  assert.equal(secondResult.mentorReportVoided, false);
  assert.equal(secondResult.version, afterPassedRollbackState.version + 1);

  const afterNoshowRollbackState = await readBookingStateFromPostgres(pool);
  assert.equal(afterNoshowRollbackState.version, secondResult.version);
  const rolledBackNoshowApp = afterNoshowRollbackState.applications.find(
    app => Number(app.id) === NOSHOW_APP_LEGACY_ID
  );
  assert.equal(rolledBackNoshowApp.status, 'invited');
  assert.equal(Number(rolledBackNoshowApp.shiftId), SHIFT_LEGACY_ID);
  assert.equal(Number(rolledBackNoshowApp.inviteGroupId), INVITE_GROUP_LEGACY_ID);

  await assert.rejects(
    () => stepBackApplicationInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'step_back_application',
        baseVersion: afterNoshowRollbackState.version,
        applicationId: NOSHOW_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T19:15:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /нельзя вернуть/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterNoshowRollbackState.version);

  console.log('PostgreSQL step_back_application write smoke passed.');
} finally {
  await pool.end();
}
