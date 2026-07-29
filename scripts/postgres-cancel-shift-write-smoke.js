import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  cancelShiftInPostgres
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

const SHIFT_LEGACY_ID = 920000;
const INVITE_GROUP_LEGACY_ID = 920100;
const PENDING_APP_LEGACY_ID = 920001;
const INVITED_APP_LEGACY_ID = 920002;
const FEEDBACK_APP_LEGACY_ID = 920003;

async function seedCancelableShift(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftUuid = randomUUID();
    const groupUuid = randomUUID();
    const pendingUuid = randomUUID();
    const invitedUuid = randomUUID();
    const feedbackUuid = randomUUID();

    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled,
          created_at, updated_at
        )
        VALUES ($1, $2, '2026-09-10', 4, true, false, $3, $3)
      `,
      [shiftUuid, SHIFT_LEGACY_ID, seedIso]
    );

    await client.query(
      `
        INSERT INTO invite_groups (
          id, legacy_id, shift_id, venue_id, link, sent_at,
          created_by_telegram_user_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, 'loft4', 'https://t.me/+cancel_shift_smoke', $4, $5, $4, $4)
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
          candidate_report, mentor_report_received,
          created_at, updated_at
        ) VALUES
          ($1, $2, $3, NULL,
           '920001', '920001', 'cancel_shift_pending',
           'Cancel Shift Pending', '+7 999 020-00-01', 'passed', '2026-08-01',
           'first', '', 'pending',
           NULL, '',
           true, true,
           $8, $8),
          ($4, $5, $3, $9,
           '920002', '920002', 'cancel_shift_invited',
           'Cancel Shift Invited', '+7 999 020-00-02', 'passed', '2026-08-01',
           'repeat', '', 'invited',
           'loft4', 'https://t.me/+cancel_shift_smoke',
           true, true,
           $8, $8),
          ($6, $7, $3, $9,
           '920003', '920003', 'cancel_shift_feedback',
           'Cancel Shift Feedback', '+7 999 020-00-03', 'passed', '2026-08-01',
           'first', '', 'feedback',
           'loft4', 'https://t.me/+cancel_shift_smoke',
           false, false,
           $8, $8)
      `,
      [
        pendingUuid,
        PENDING_APP_LEGACY_ID,
        shiftUuid,
        invitedUuid,
        INVITED_APP_LEGACY_ID,
        feedbackUuid,
        FEEDBACK_APP_LEGACY_ID,
        seedIso,
        groupUuid
      ]
    );

    await client.query(
      `
        INSERT INTO invite_group_members (invite_group_id, application_id, created_at)
        VALUES ($1, $2, $4), ($1, $3, $4)
      `,
      [groupUuid, invitedUuid, feedbackUuid, seedIso]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
    return { shiftUuid, groupUuid, pendingUuid, invitedUuid, feedbackUuid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T18:10:00.000Z';
  const seeded = await seedCancelableShift(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const seededShift = seededState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(seededShift);
  assert.equal(seededShift.open, true);
  assert.equal(seededShift.canceled, false);

  const cancelNow = new Date('2026-07-29T18:20:00.000Z');
  const result = await cancelShiftInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'cancel_shift',
      baseVersion: seededState.version,
      shiftId: SHIFT_LEGACY_ID
    },
    now: cancelNow
  });

  assert.equal(result.changed, true);
  assert.equal(result.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(result.shiftDate, '2026-09-10');
  assert.deepEqual(result.affectedApplicationLegacyIds, [
    PENDING_APP_LEGACY_ID,
    INVITED_APP_LEGACY_ID
  ]);
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
  const canceledShift = afterState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.equal(canceledShift.open, false);
  assert.equal(canceledShift.canceled, true);
  assert.equal(canceledShift.canceledAt, cancelNow.toISOString());

  const pendingApp = afterState.applications.find(app => Number(app.id) === PENDING_APP_LEGACY_ID);
  const invitedApp = afterState.applications.find(app => Number(app.id) === INVITED_APP_LEGACY_ID);
  const feedbackApp = afterState.applications.find(app => Number(app.id) === FEEDBACK_APP_LEGACY_ID);
  for (const app of [pendingApp, invitedApp]) {
    assert.equal(app.status, 'queue');
    assert.equal(app.shiftId, null);
    assert.equal(app.inviteGroupId, null);
    assert.equal(app.venueId, null);
    assert.equal(app.groupLink, '');
    assert.equal(app.candidateReport, false);
    assert.equal(app.mentorReport, false);
    assert.equal(app.mentorCommentDeliveryStatus, '');
  }
  assert.equal(feedbackApp.status, 'feedback');
  assert.equal(Number(feedbackApp.shiftId), SHIFT_LEGACY_ID);
  assert.equal(Number(feedbackApp.inviteGroupId), INVITE_GROUP_LEGACY_ID);

  const membersResult = await pool.query(
    `
      SELECT applications.legacy_id
        FROM invite_group_members
        JOIN applications ON applications.id = invite_group_members.application_id
       WHERE invite_group_members.invite_group_id = $1
       ORDER BY applications.legacy_id
    `,
    [seeded.groupUuid]
  );
  assert.deepEqual(membersResult.rows.map(row => Number(row.legacy_id)), [FEEDBACK_APP_LEGACY_ID]);

  const eventsResult = await pool.query(
    `
      SELECT event_type, payload
        FROM application_events
       WHERE payload ->> 'action' = 'cancel_shift'
         AND (payload ->> 'legacyShiftId')::bigint = $1
       ORDER BY created_at, event_type
    `,
    [SHIFT_LEGACY_ID]
  );
  assert.equal(eventsResult.rowCount, 4);
  assert.deepEqual(
    eventsResult.rows.map(row => row.event_type).sort(),
    ['internship_cancelled', 'internship_cancelled', 'invite_group_updated', 'shift_cancelled']
  );
  const shiftEvent = eventsResult.rows.find(row => row.event_type === 'shift_cancelled');
  assert.deepEqual(shiftEvent.payload.affectedApplicationIds.map(Number), [
    PENDING_APP_LEGACY_ID,
    INVITED_APP_LEGACY_ID
  ]);
  const groupEvent = eventsResult.rows.find(row => row.event_type === 'invite_group_updated');
  assert.equal(Number(groupEvent.payload.inviteGroupId), INVITE_GROUP_LEGACY_ID);
  assert.deepEqual(groupEvent.payload.removedMemberIds.map(Number), [INVITED_APP_LEGACY_ID]);
  assert.deepEqual(groupEvent.payload.memberIds.map(Number), [FEEDBACK_APP_LEGACY_ID]);

  const notificationResult = await pool.query(
    `
      SELECT applications.legacy_id,
             notifications.type,
             notifications.status,
             notifications.chat_id,
             notifications.chat_target,
             notifications.parse_mode,
             notifications.text,
             notifications.idempotency_key
        FROM notifications
        JOIN applications ON applications.id = notifications.application_id
       WHERE notifications.type = 'cancel_shift'
         AND notifications.created_at = $1::timestamptz
       ORDER BY applications.legacy_id
    `,
    [cancelNow.toISOString()]
  );
  assert.equal(notificationResult.rowCount, 2);
  assert.deepEqual(
    notificationResult.rows.map(row => Number(row.legacy_id)),
    [PENDING_APP_LEGACY_ID, INVITED_APP_LEGACY_ID]
  );
  for (const row of notificationResult.rows) {
    assert.equal(row.status, 'pending');
    assert.equal(row.chat_target, 'trainee');
    assert.equal(row.parse_mode, 'HTML');
    assert.match(row.text, /Стажировка отменена/);
    assert.match(row.text, /10\.09\.2026/);
    assert.match(row.idempotency_key, new RegExp(`^cancel_shift:${row.legacy_id}:`));
  }

  await assert.rejects(
    () => cancelShiftInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'cancel_shift',
        baseVersion: afterState.version - 1,
        shiftId: SHIFT_LEGACY_ID
      },
      now: new Date('2026-07-29T18:25:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterState.version);

  console.log('PostgreSQL cancel_shift write smoke test passed.');
} finally {
  await pool.end();
}
