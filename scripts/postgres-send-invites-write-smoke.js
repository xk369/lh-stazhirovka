import 'dotenv/config';
import assert from 'node:assert/strict';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandValidationError,
  sendInvitesInPostgres
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

const CONFIRMED_APP_LEGACY_ID = 900001;
const SHIFT_LEGACY_ID = 100;
const VENUE_ID = 'loft5_small';
const LINK = 'https://t.me/+send_invites_smoke';

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const targetShift = beforeState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(targetShift, `expected fixture shift ${SHIFT_LEGACY_ID} to exist`);
  const confirmedApp = beforeState.applications.find(
    app => Number(app.id) === CONFIRMED_APP_LEGACY_ID
  );
  assert.ok(
    confirmedApp,
    `expected application ${CONFIRMED_APP_LEGACY_ID} to exist (seeded by set_application_status smoke)`
  );
  assert.equal(
    confirmedApp.status,
    'confirmed',
    `application ${CONFIRMED_APP_LEGACY_ID} must be in status 'confirmed' before send_invites smoke`
  );
  assert.equal(
    Number(confirmedApp.shiftId),
    SHIFT_LEGACY_ID,
    `application ${CONFIRMED_APP_LEGACY_ID} must be on shift ${SHIFT_LEGACY_ID}`
  );

  const sendNow = new Date('2026-07-29T16:00:00.000Z');
  const result = await sendInvitesInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'send_invites',
      baseVersion: beforeState.version,
      shiftId: SHIFT_LEGACY_ID,
      venueId: VENUE_ID,
      link: LINK,
      memberIds: [CONFIRMED_APP_LEGACY_ID]
    },
    now: sendNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(result.venueId, VENUE_ID);
  assert.equal(result.link, LINK);
  assert.deepEqual(result.memberLegacyIds, [CONFIRMED_APP_LEGACY_ID]);
  assert.equal(result.previousStatus, 'confirmed');
  assert.equal(result.nextStatus, 'invited');
  assert.equal(result.previousVersion, beforeState.version);
  assert.equal(result.version, beforeState.version + 1);
  assert.equal(result.updatedAt, sendNow.toISOString());
  assert.ok(result.inviteGroupLegacyId > 0);

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  const invitedApp = afterState.applications.find(
    app => Number(app.id) === CONFIRMED_APP_LEGACY_ID
  );
  assert.equal(invitedApp.status, 'invited');
  assert.equal(Number(invitedApp.inviteGroupId), result.inviteGroupLegacyId);
  assert.equal(invitedApp.venueId, VENUE_ID);
  assert.equal(invitedApp.groupLink, LINK);

  const createdGroup = afterState.inviteGroups.find(
    group => Number(group.id) === result.inviteGroupLegacyId
  );
  assert.ok(createdGroup, 'created invite group must be visible via read-booking-state');
  assert.equal(Number(createdGroup.shiftId), SHIFT_LEGACY_ID);
  assert.equal(createdGroup.venueId, VENUE_ID);
  assert.equal(createdGroup.link, LINK);
  assert.deepEqual(
    createdGroup.memberIds.map(Number).sort((a, b) => a - b),
    [CONFIRMED_APP_LEGACY_ID]
  );

  const membersRow = await pool.query(
    `
      SELECT invite_group_members.invite_group_id, invite_group_members.application_id
        FROM invite_group_members
        JOIN invite_groups ON invite_groups.id = invite_group_members.invite_group_id
        JOIN applications ON applications.id = invite_group_members.application_id
       WHERE invite_groups.legacy_id = $1
         AND applications.legacy_id = $2
    `,
    [result.inviteGroupLegacyId, CONFIRMED_APP_LEGACY_ID]
  );
  assert.equal(membersRow.rowCount, 1);

  const groupEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.actor_type,
             application_events.actor_telegram_user_id,
             application_events.payload,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'invite_group_sent'
         AND (application_events.payload ->> 'inviteGroupId')::bigint = $1
    `,
    [result.inviteGroupLegacyId]
  );
  assert.equal(groupEventResult.rowCount, 1);
  const groupEvent = groupEventResult.rows[0];
  assert.equal(groupEvent.actor_type, 'recruiter');
  assert.equal(groupEvent.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(groupEvent.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(groupEvent.payload.action, 'send_invites');
  assert.equal(groupEvent.payload.venueId, VENUE_ID);
  assert.deepEqual(groupEvent.payload.memberIds.map(Number), [CONFIRMED_APP_LEGACY_ID]);
  assert.equal(groupEvent.payload.previousVersion, beforeState.version);
  assert.equal(groupEvent.payload.nextVersion, result.version);
  assert.equal(groupEvent.payload.date, targetShift.date);

  const invitedEventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.payload,
             applications.legacy_id AS application_legacy_id
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE application_events.event_type = 'application_invited'
         AND applications.legacy_id = $1
         AND (application_events.payload ->> 'inviteGroupId')::bigint = $2
    `,
    [CONFIRMED_APP_LEGACY_ID, result.inviteGroupLegacyId]
  );
  assert.equal(invitedEventResult.rowCount, 1);
  const invitedEvent = invitedEventResult.rows[0];
  assert.equal(invitedEvent.payload.action, 'send_invites');
  assert.equal(invitedEvent.payload.previousStatus, 'confirmed');
  assert.equal(invitedEvent.payload.nextStatus, 'invited');
  assert.equal(invitedEvent.payload.venueId, VENUE_ID);
  assert.equal(invitedEvent.payload.shiftId, SHIFT_LEGACY_ID);

  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'send_invites',
        baseVersion: afterState.version,
        shiftId: SHIFT_LEGACY_ID,
        venueId: VENUE_ID,
        link: LINK,
        memberIds: [CONFIRMED_APP_LEGACY_ID]
      },
      now: new Date('2026-07-29T16:05:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /not eligible/.test(err.message)
  );

  await assert.rejects(
    () => sendInvitesInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'send_invites',
        baseVersion: afterState.version,
        shiftId: SHIFT_LEGACY_ID,
        venueId: VENUE_ID,
        link: 'https://example.com/not-telegram',
        memberIds: [CONFIRMED_APP_LEGACY_ID]
      },
      now: new Date('2026-07-29T16:10:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /ссылку на рабочую группу/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterState.version);
  const finalInvitedApp = finalState.applications.find(
    app => Number(app.id) === CONFIRMED_APP_LEGACY_ID
  );
  assert.equal(finalInvitedApp.status, 'invited');
  assert.equal(Number(finalInvitedApp.inviteGroupId), result.inviteGroupLegacyId);

  console.log('PostgreSQL send_invites write smoke test passed.');
} finally {
  await pool.end();
}
