import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  cancelInternshipInPostgres
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

const INVITED_APP_LEGACY_ID = 900001;
const FEEDBACK_APP_LEGACY_ID = 900002;
const SHIFT_LEGACY_ID = 100;

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const targetApp = beforeState.applications.find(
    app => Number(app.id) === INVITED_APP_LEGACY_ID
  );
  assert.ok(
    targetApp,
    `expected application ${INVITED_APP_LEGACY_ID} to exist (seeded by send_invites smoke)`
  );
  assert.equal(targetApp.status, 'invited');
  assert.equal(Number(targetApp.shiftId), SHIFT_LEGACY_ID);
  assert.ok(targetApp.inviteGroupId, 'target application must have an invite group before cancel');
  assert.equal(targetApp.venueId, 'loft5_small');
  assert.equal(targetApp.groupLink, 'https://t.me/+send_invites_smoke');

  const previousInviteGroupId = Number(targetApp.inviteGroupId);
  const previousInviteGroup = beforeState.inviteGroups.find(
    group => Number(group.id) === previousInviteGroupId
  );
  assert.ok(previousInviteGroup);
  assert.deepEqual(previousInviteGroup.memberIds.map(Number), [INVITED_APP_LEGACY_ID]);

  const cancelNow = new Date('2026-07-29T17:00:00.000Z');
  const result = await cancelInternshipInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'cancel_internship',
      baseVersion: beforeState.version,
      applicationId: INVITED_APP_LEGACY_ID
    },
    now: cancelNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, INVITED_APP_LEGACY_ID);
  assert.equal(result.previousStatus, 'invited');
  assert.equal(result.nextStatus, 'queue');
  assert.equal(result.previousShiftId, SHIFT_LEGACY_ID);
  assert.equal(result.previousInviteGroupId, previousInviteGroupId);
  assert.equal(result.inviteGroupChanged, true);
  assert.equal(result.inviteGroupRemoved, true);
  assert.deepEqual(result.remainingMemberLegacyIds, []);
  assert.deepEqual(result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(result.previousVersion, beforeState.version);
  assert.equal(result.version, beforeState.version + 1);
  assert.equal(result.updatedAt, cancelNow.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  const canceledApp = afterState.applications.find(
    app => Number(app.id) === INVITED_APP_LEGACY_ID
  );
  assert.equal(canceledApp.status, 'queue');
  assert.equal(canceledApp.shiftId, null);
  assert.equal(canceledApp.inviteGroupId, null);
  assert.equal(canceledApp.venueId, null);
  assert.equal(canceledApp.groupLink, '');
  assert.equal(canceledApp.candidateReport, false);
  assert.equal(canceledApp.mentorReport, false);
  assert.equal(canceledApp.mentorCommentDeliveryStatus, '');
  assert.equal(
    afterState.inviteGroups.some(group => Number(group.id) === previousInviteGroupId),
    false
  );

  const membershipResult = await pool.query(
    `
      SELECT COUNT(*)::int AS count
        FROM invite_group_members
        JOIN applications ON applications.id = invite_group_members.application_id
       WHERE applications.legacy_id = $1
    `,
    [INVITED_APP_LEGACY_ID]
  );
  assert.equal(membershipResult.rows[0].count, 0);

  const removedEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.actor_type,
             application_events.actor_telegram_user_id,
             application_events.payload,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'invite_group_removed'
         AND (application_events.payload ->> 'inviteGroupId')::bigint = $1
    `,
    [previousInviteGroupId]
  );
  assert.equal(removedEventResult.rowCount, 1);
  const removedEvent = removedEventResult.rows[0];
  assert.equal(removedEvent.actor_type, 'recruiter');
  assert.equal(removedEvent.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(removedEvent.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(removedEvent.payload.action, 'cancel_internship');
  assert.deepEqual(removedEvent.payload.removedMemberIds.map(Number), [INVITED_APP_LEGACY_ID]);
  assert.deepEqual(removedEvent.payload.memberIds, []);
  assert.equal(removedEvent.payload.previousVersion, beforeState.version);
  assert.equal(removedEvent.payload.nextVersion, result.version);

  const cancelEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.payload,
             applications.legacy_id AS application_legacy_id,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'internship_cancelled'
         AND applications.legacy_id = $1
    `,
    [INVITED_APP_LEGACY_ID]
  );
  assert.equal(cancelEventResult.rowCount, 1);
  const cancelEvent = cancelEventResult.rows[0];
  assert.equal(Number(cancelEvent.application_legacy_id), INVITED_APP_LEGACY_ID);
  assert.equal(Number(cancelEvent.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(cancelEvent.payload.previousStatus, 'invited');
  assert.equal(cancelEvent.payload.nextStatus, 'queue');
  assert.equal(cancelEvent.payload.previousShiftId, SHIFT_LEGACY_ID);
  assert.equal(cancelEvent.payload.nextShiftId, null);
  assert.equal(cancelEvent.payload.previousInviteGroupId, previousInviteGroupId);

  const notificationResult = await pool.query(
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
         AND notifications.type = 'cancel_internship'
         AND notifications.created_at = $2::timestamptz
    `,
    [INVITED_APP_LEGACY_ID, cancelNow.toISOString()]
  );
  assert.equal(notificationResult.rowCount, 1);
  const notification = notificationResult.rows[0];
  assert.equal(notification.status, 'pending');
  assert.equal(notification.chat_id, '910');
  assert.equal(notification.chat_target, 'trainee');
  assert.equal(notification.parse_mode, 'HTML');
  assert.match(notification.text, /Стажировка отменена/);
  assert.match(notification.text, /26\.07\.2026/);
  assert.match(notification.text, /предварительную запись/);
  assert.match(notification.idempotency_key, /^cancel_internship:900001:/);

  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'cancel_internship',
        baseVersion: afterState.version,
        applicationId: INVITED_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T17:05:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /только до выхода/.test(err.message)
  );

  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'cancel_internship',
        baseVersion: afterState.version,
        applicationId: FEEDBACK_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T17:10:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /только до выхода/.test(err.message)
  );

  await assert.rejects(
    () => cancelInternshipInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'cancel_internship',
        baseVersion: afterState.version - 1,
        applicationId: FEEDBACK_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T17:15:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterState.version);
  const finalCanceled = finalState.applications.find(
    app => Number(app.id) === INVITED_APP_LEGACY_ID
  );
  assert.equal(finalCanceled.status, 'queue');

  const finalNotificationCount = await pool.query(
    `
      SELECT COUNT(*)::int AS count
        FROM notifications
        JOIN applications ON applications.id = notifications.application_id
       WHERE applications.legacy_id = $1
         AND notifications.type = 'cancel_internship'
    `,
    [INVITED_APP_LEGACY_ID]
  );
  assert.equal(finalNotificationCount.rows[0].count, 1);

  console.log('PostgreSQL cancel_internship write smoke test passed.');
} finally {
  await pool.end();
}
