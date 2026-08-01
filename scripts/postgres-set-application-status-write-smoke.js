import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  setApplicationStatusInPostgres
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

const PENDING_LEGACY_ID = 900001;
const INVITED_LEGACY_ID = 900002;

async function seedTestApplications({ shiftId, inviteGroupId, seedIso }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pendingId = randomUUID();
    const invitedId = randomUUID();

    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          venue_id, group_link,
          candidate_report, mentor_report_received,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, NULL,
          '910', '910', 'pending_smoke',
          'Pending Smoke Trainee', '+7 999 000-00-01', 'passed', '2026-07-20', 'first', '', 'pending',
          NULL, '',
          false, false,
          $4, $4
        )
      `,
      [pendingId, PENDING_LEGACY_ID, shiftId, seedIso]
    );

    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          venue_id, group_link,
          candidate_report, mentor_report_received,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          '911', '911', 'invited_smoke',
          'Invited Smoke Trainee', '+7 999 000-00-02', 'passed', '2026-07-20', 'first', '', 'invited',
          'loft5_small', 'https://t.me/+group',
          false, false,
          $5, $5
        )
      `,
      [invitedId, INVITED_LEGACY_ID, shiftId, inviteGroupId, seedIso]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
    return { pendingId, invitedId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const targetShift = beforeState.shifts.find(shift => Number(shift.id) === 100);
  assert.ok(targetShift, 'fixture shift 100 must exist');
  const targetInviteGroup = beforeState.inviteGroups.find(group => Number(group.id) === 300);
  assert.ok(targetInviteGroup, 'fixture invite group 300 must exist');

  const shiftUuidResult = await pool.query('SELECT id FROM shifts WHERE legacy_id = 100');
  const shiftUuid = shiftUuidResult.rows[0].id;
  const inviteUuidResult = await pool.query('SELECT id FROM invite_groups WHERE legacy_id = 300');
  const inviteGroupUuid = inviteUuidResult.rows[0].id;

  const seedIso = '2026-07-29T13:00:00.000Z';
  await seedTestApplications({ shiftId: shiftUuid, inviteGroupId: inviteGroupUuid, seedIso });

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const pendingApp = seededState.applications.find(app => Number(app.id) === PENDING_LEGACY_ID);
  const invitedApp = seededState.applications.find(app => Number(app.id) === INVITED_LEGACY_ID);
  assert.ok(pendingApp, 'seeded pending application must be visible');
  assert.equal(pendingApp.status, 'pending');
  assert.ok(invitedApp, 'seeded invited application must be visible');
  assert.equal(invitedApp.status, 'invited');

  const confirmedNow = new Date('2026-07-29T13:05:00.000Z');
  const confirmedResult = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'set_application_status',
      baseVersion: seededState.version,
      applicationId: PENDING_LEGACY_ID,
      status: 'confirmed'
    },
    now: confirmedNow
  });
  assert.equal(confirmedResult.changed, true);
  assert.equal(confirmedResult.previousStatus, 'pending');
  assert.equal(confirmedResult.nextStatus, 'confirmed');
  assert.equal(confirmedResult.eventType, 'recruiter_confirmed');
  assert.equal(confirmedResult.shiftLegacyId, 100);
  assert.equal(confirmedResult.shiftAutoClosed, false);
  assert.equal(confirmedResult.previousVersion, seededState.version);
  assert.equal(confirmedResult.version, seededState.version + 1);
  assert.equal(confirmedResult.updatedAt, confirmedNow.toISOString());

  const afterConfirmedState = await readBookingStateFromPostgres(pool);
  assert.equal(afterConfirmedState.version, confirmedResult.version);
  const confirmedApp = afterConfirmedState.applications.find(app => Number(app.id) === PENDING_LEGACY_ID);
  assert.equal(confirmedApp.status, 'confirmed');

  const confirmedEventResult = await pool.query(
    `
      SELECT application_events.actor_type,
             application_events.actor_telegram_user_id,
             application_events.event_type,
             application_events.payload,
             applications.legacy_id AS application_legacy_id,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'recruiter_confirmed'
         AND applications.legacy_id = $1
    `,
    [PENDING_LEGACY_ID]
  );
  assert.equal(confirmedEventResult.rowCount, 1);
  const confirmedEvent = confirmedEventResult.rows[0];
  assert.equal(confirmedEvent.actor_type, 'recruiter');
  assert.equal(confirmedEvent.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(confirmedEvent.application_legacy_id), PENDING_LEGACY_ID);
  assert.equal(Number(confirmedEvent.shift_legacy_id), 100);
  assert.equal(confirmedEvent.payload.action, 'set_application_status');
  assert.equal(confirmedEvent.payload.previousStatus, 'pending');
  assert.equal(confirmedEvent.payload.nextStatus, 'confirmed');
  assert.equal(confirmedEvent.payload.previousVersion, seededState.version);
  assert.equal(confirmedEvent.payload.nextVersion, seededState.version + 1);
  assert.equal(confirmedEvent.payload.shiftId, 100);

  const feedbackNow = new Date('2026-07-29T13:10:00.000Z');
  const feedbackResult = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'set_application_status',
      baseVersion: afterConfirmedState.version,
      applicationId: INVITED_LEGACY_ID,
      status: 'feedback'
    },
    now: feedbackNow
  });
  assert.equal(feedbackResult.eventType, 'attendance_marked_feedback');
  assert.equal(feedbackResult.previousStatus, 'invited');
  assert.equal(feedbackResult.nextStatus, 'feedback');
  assert.equal(feedbackResult.shiftAutoClosed, false);
  assert.equal(feedbackResult.version, afterConfirmedState.version + 1);

  const afterFeedbackState = await readBookingStateFromPostgres(pool);
  const feedbackApp = afterFeedbackState.applications.find(app => Number(app.id) === INVITED_LEGACY_ID);
  assert.equal(feedbackApp.status, 'feedback');

  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'set_application_status',
        baseVersion: afterFeedbackState.version,
        applicationId: INVITED_LEGACY_ID,
        status: 'pending'
      },
      now: new Date('2026-07-29T13:15:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отдельной команды/.test(err.message)
  );

  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'set_application_status',
        baseVersion: afterFeedbackState.version - 1,
        applicationId: PENDING_LEGACY_ID,
        status: 'confirmed'
      },
      now: new Date('2026-07-29T13:20:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'set_application_status',
        baseVersion: afterFeedbackState.version,
        applicationId: 987654321,
        status: 'confirmed'
      },
      now: new Date('2026-07-29T13:25:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterFeedbackState.version);
  const finalPending = finalState.applications.find(app => Number(app.id) === PENDING_LEGACY_ID);
  const finalInvited = finalState.applications.find(app => Number(app.id) === INVITED_LEGACY_ID);
  assert.equal(finalPending.status, 'confirmed');
  assert.equal(finalInvited.status, 'feedback');

  console.log('PostgreSQL set_application_status write smoke test passed.');
} finally {
  await pool.end();
}
