import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { returnToQueueInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

const SHIFT_LEGACY_ID = 910010;
const RETURNED_APP_LEGACY_ID = 910011;
const REMAINING_APP_LEGACY_ID = 910012;
const GROUP_LEGACY_ID = 910013;
const VENUE_ID = 'loft5_small';
const LINK = 'https://t.me/+return_to_queue_smoke';

async function seedInvitedPair(seedIso) {
  const shiftId = randomUUID();
  const groupId = randomUUID();
  const returnedAppId = randomUUID();
  const remainingAppId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, '2026-10-01'::date, 4, true, false, NULL, $3, $3)
      `,
      [shiftId, SHIFT_LEGACY_ID, seedIso]
    );
    await client.query(
      `
        INSERT INTO invite_groups (
          id, legacy_id, shift_id, venue_id, link, sent_at,
          created_by_telegram_user_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'postgres-smoke-recruiter', $6, $6)
      `,
      [groupId, GROUP_LEGACY_ID, shiftId, VENUE_ID, LINK, seedIso]
    );
    for (const [appId, legacyId, username, chatId] of [
      [returnedAppId, RETURNED_APP_LEGACY_ID, 'return_queue_smoke_a', '930011'],
      [remainingAppId, REMAINING_APP_LEGACY_ID, 'return_queue_smoke_b', '930012']
    ]) {
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
            $5, $5, $6,
            $7, '+7 999 000-10-01', 'passed', '2026-09-20', 'first', '', 'invited',
            $8, $9,
            false, false,
            $10, $10
          )
        `,
        [
          appId,
          legacyId,
          shiftId,
          groupId,
          chatId,
          username,
          legacyId === RETURNED_APP_LEGACY_ID
            ? 'Return Queue Smoke A'
            : 'Return Queue Smoke B',
          VENUE_ID,
          LINK,
          seedIso
        ]
      );
      await client.query(
        `INSERT INTO invite_group_members (invite_group_id, application_id, created_at)
         VALUES ($1, $2, $3)`,
        [groupId, appId, seedIso]
      );
    }
    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T17:20:00.000Z';
  await seedInvitedPair(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const targetApp = seededState.applications.find(
    app => Number(app.id) === RETURNED_APP_LEGACY_ID
  );
  assert.ok(targetApp);
  assert.equal(targetApp.status, 'invited');
  assert.equal(Number(targetApp.shiftId), SHIFT_LEGACY_ID);
  assert.equal(Number(targetApp.inviteGroupId), GROUP_LEGACY_ID);
  const targetGroup = seededState.inviteGroups.find(
    group => Number(group.id) === GROUP_LEGACY_ID
  );
  assert.ok(targetGroup);
  assert.deepEqual(
    targetGroup.memberIds.map(Number).sort((left, right) => left - right),
    [RETURNED_APP_LEGACY_ID, REMAINING_APP_LEGACY_ID]
  );

  const returnNow = new Date('2026-07-29T17:25:00.000Z');
  const result = await returnToQueueInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'return_to_queue',
      baseVersion: seededState.version,
      applicationId: RETURNED_APP_LEGACY_ID
    },
    now: returnNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, RETURNED_APP_LEGACY_ID);
  assert.equal(result.previousStatus, 'invited');
  assert.equal(result.nextStatus, 'queue');
  assert.equal(result.previousShiftId, SHIFT_LEGACY_ID);
  assert.equal(result.previousInviteGroupId, GROUP_LEGACY_ID);
  assert.equal(result.inviteGroupChanged, true);
  assert.equal(result.inviteGroupRemoved, false);
  assert.deepEqual(result.remainingMemberLegacyIds, [REMAINING_APP_LEGACY_ID]);
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);
  assert.equal(result.updatedAt, returnNow.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  const returnedApp = afterState.applications.find(
    app => Number(app.id) === RETURNED_APP_LEGACY_ID
  );
  assert.equal(returnedApp.status, 'queue');
  assert.equal(returnedApp.shiftId, null);
  assert.equal(returnedApp.inviteGroupId, null);
  assert.equal(returnedApp.venueId, null);
  assert.equal(returnedApp.groupLink, '');
  assert.equal(returnedApp.candidateReport, false);
  assert.equal(returnedApp.mentorReport, false);

  const remainingApp = afterState.applications.find(
    app => Number(app.id) === REMAINING_APP_LEGACY_ID
  );
  assert.equal(remainingApp.status, 'invited');
  assert.equal(Number(remainingApp.shiftId), SHIFT_LEGACY_ID);
  assert.equal(Number(remainingApp.inviteGroupId), GROUP_LEGACY_ID);

  const remainingGroup = afterState.inviteGroups.find(
    group => Number(group.id) === GROUP_LEGACY_ID
  );
  assert.ok(remainingGroup);
  assert.deepEqual(remainingGroup.memberIds.map(Number), [REMAINING_APP_LEGACY_ID]);

  const returnEventResult = await pool.query(
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
       WHERE application_events.event_type = 'application_returned_to_queue'
         AND applications.legacy_id = $1
    `,
    [RETURNED_APP_LEGACY_ID]
  );
  assert.equal(returnEventResult.rowCount, 1);
  const returnEvent = returnEventResult.rows[0];
  assert.equal(returnEvent.actor_type, 'recruiter');
  assert.equal(returnEvent.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(returnEvent.application_legacy_id), RETURNED_APP_LEGACY_ID);
  assert.equal(Number(returnEvent.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(returnEvent.payload.action, 'return_to_queue');
  assert.equal(returnEvent.payload.previousStatus, 'invited');
  assert.equal(returnEvent.payload.nextStatus, 'queue');
  assert.equal(returnEvent.payload.previousInviteGroupId, GROUP_LEGACY_ID);
  assert.equal(returnEvent.payload.previousVersion, seededState.version);
  assert.equal(returnEvent.payload.nextVersion, result.version);

  const groupEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.payload,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'invite_group_updated'
         AND (application_events.payload ->> 'inviteGroupId')::bigint = $1
    `,
    [GROUP_LEGACY_ID]
  );
  assert.equal(groupEventResult.rowCount, 1);
  assert.equal(Number(groupEventResult.rows[0].shift_legacy_id), SHIFT_LEGACY_ID);
  assert.deepEqual(
    groupEventResult.rows[0].payload.removedMemberIds.map(Number),
    [RETURNED_APP_LEGACY_ID]
  );
  assert.deepEqual(
    groupEventResult.rows[0].payload.memberIds.map(Number),
    [REMAINING_APP_LEGACY_ID]
  );

  const notificationCount = await pool.query(
    `
      SELECT COUNT(*)::int AS count
        FROM notifications
        JOIN applications ON applications.id = notifications.application_id
       WHERE applications.legacy_id = $1
         AND notifications.type = 'return_to_queue'
    `,
    [RETURNED_APP_LEGACY_ID]
  );
  assert.equal(notificationCount.rows[0].count, 0);

  const noopResult = await returnToQueueInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'return_to_queue',
      baseVersion: afterState.version,
      applicationId: RETURNED_APP_LEGACY_ID
    },
    now: new Date('2026-07-29T17:30:00.000Z')
  });
  assert.equal(noopResult.changed, false);
  assert.equal(noopResult.version, afterState.version);

  console.log('PostgreSQL return_to_queue write smoke test passed.');
} finally {
  await pool.end();
}
