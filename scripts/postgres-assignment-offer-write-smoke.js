import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  expireAssignmentOffersInPostgres,
  recordAssignmentOfferMessageInPostgres,
  requestAssignmentConfirmationInPostgres,
  respondAssignmentOfferInPostgres,
  updateQueueCommentInPostgres,
  withdrawConfirmedAssignmentInPostgres
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
const traineeA = {
  role: 'trainee',
  userId: '930041',
  telegram: {
    user: {
      id: '930041',
      username: 'offer_smoke_a'
    }
  }
};
const traineeB = {
  role: 'trainee',
  userId: '930042',
  telegram: {
    user: {
      id: '930042',
      username: 'offer_smoke_b'
    }
  }
};
const traineeC = {
  role: 'trainee',
  userId: '930043',
  telegram: {
    user: {
      id: '930043',
      username: 'offer_smoke_c'
    }
  }
};

const SHIFT_LEGACY_ID = 910041;
const APP_A_LEGACY_ID = 910041;
const APP_B_LEGACY_ID = 910042;
const APP_C_LEGACY_ID = 910043;

async function currentState() {
  return readBookingStateFromPostgres(pool);
}

async function seedQueueState(seedIso) {
  const client = await pool.connect();
  const shiftId = randomUUID();
  const applications = [
    [randomUUID(), APP_A_LEGACY_ID, 'Assignment Offer Smoke A', '930041', 'offer_smoke_a'],
    [randomUUID(), APP_B_LEGACY_ID, 'Assignment Offer Smoke B', '930042', 'offer_smoke_b'],
    [randomUUID(), APP_C_LEGACY_ID, 'Assignment Offer Smoke C', '930043', 'offer_smoke_c']
  ];
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, '2026-10-05'::date, 2, true, false, NULL, $3, $3)
      `,
      [shiftId, SHIFT_LEGACY_ID, seedIso]
    );
    for (const [applicationId, legacyId, name, telegramUserId, username] of applications) {
      await client.query(
        `
          INSERT INTO applications (
            id, legacy_id, shift_id, invite_group_id,
            trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username, telegram_code,
            name, phone, training, training_date, attempt, limits, status,
            recruiter_comment, recruiter_queue_comment,
            venue_id, group_link, candidate_report, experience,
            mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
            mentor_decision, mentor_report_venue_id, mentor_report_venue,
            mentor_report_loft, mentor_report_hall, mentor_comment_for_trainee,
            mentor_comment_sent_at, mentor_comment_delivery_status, mentor_comment_delivery_error,
            created_at, updated_at
          )
          VALUES (
            $1, $2, NULL, NULL,
            $4, $4, $5, '',
            $3, '+7 999 000-41-00', 'passed', '2026-09-20'::date, 'first', '', 'queue',
            '', '',
            NULL, '', false, NULL,
            false, NULL, NULL,
            '', '', '',
            '', '', '',
            NULL, NULL, '',
            $6, $6
          )
        `,
        [applicationId, legacyId, name, telegramUserId, username, seedIso]
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

async function getOfferByApplication(applicationLegacyId) {
  const result = await pool.query(
    `
      SELECT application_assignment_offers.*
        FROM application_assignment_offers
        JOIN applications ON applications.id = application_assignment_offers.application_id
       WHERE applications.legacy_id = $1
       ORDER BY application_assignment_offers.created_at DESC
       LIMIT 1
    `,
    [applicationLegacyId]
  );
  return result.rows[0] || null;
}

async function requestOffer(applicationId, now) {
  const state = await currentState();
  return requestAssignmentConfirmationInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'request_assignment_confirmation',
      baseVersion: state.version,
      applicationId,
      shiftId: SHIFT_LEGACY_ID
    },
    now
  });
}

try {
  const beforeState = await currentState();
  await seedQueueState('2026-07-29T19:00:00.000Z');

  let state = await currentState();
  assert.equal(state.version, beforeState.version + 1);
  assert.ok(state.shifts.some(shift => Number(shift.id) === SHIFT_LEGACY_ID));
  assert.ok(state.applications.some(app => Number(app.id) === APP_A_LEGACY_ID && app.status === 'queue'));

  const commentResult = await updateQueueCommentInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_queue_comment',
      baseVersion: state.version,
      applicationId: APP_A_LEGACY_ID,
      comment: 'Созвониться перед датой'
    },
    now: new Date('2026-07-29T19:05:00.000Z')
  });
  assert.equal(commentResult.changed, true);
  assert.equal(commentResult.nextComment, 'Созвониться перед датой');

  const appAOffer = await requestOffer(APP_A_LEGACY_ID, new Date('2026-07-29T19:10:00.000Z'));
  assert.equal(appAOffer.nextStatus, 'queue');
  assert.equal(appAOffer.assignmentOffer.shiftId, SHIFT_LEGACY_ID);
  assert.equal(appAOffer.assignmentOffer.expiresAt, '2026-07-29T20:10:00.000Z');

  state = await currentState();
  const offeredAppA = state.applications.find(app => Number(app.id) === APP_A_LEGACY_ID);
  assert.equal(offeredAppA.status, 'queue');
  assert.equal(offeredAppA.shiftId, null);
  assert.equal(offeredAppA.assignmentOffer.token, appAOffer.assignmentOffer.token);

  const messageResult = await recordAssignmentOfferMessageInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'record_assignment_offer_message',
      applicationId: APP_A_LEGACY_ID,
      token: appAOffer.assignmentOffer.token,
      messageChatId: '930041',
      messageId: 41001
    },
    now: new Date('2026-07-29T19:11:00.000Z')
  });
  assert.equal(messageResult.changed, true);
  assert.equal(messageResult.messageId, 41001);

  const acceptResult = await respondAssignmentOfferInPostgres({
    pool,
    actor: traineeA,
    command: {
      action: 'respond_assignment_offer',
      applicationId: APP_A_LEGACY_ID,
      token: appAOffer.assignmentOffer.token,
      decision: 'accept'
    },
    now: new Date('2026-07-29T19:12:00.000Z')
  });
  assert.equal(acceptResult.status, 'accepted');
  assert.equal(acceptResult.nextStatus, 'confirmed');

  state = await currentState();
  const acceptedAppA = state.applications.find(app => Number(app.id) === APP_A_LEGACY_ID);
  assert.equal(acceptedAppA.status, 'confirmed');
  assert.equal(Number(acceptedAppA.shiftId), SHIFT_LEGACY_ID);
  assert.equal(acceptedAppA.recruiterQueueComment, '');
  assert.equal(acceptedAppA.assignmentOffer, null);
  assert.equal((await getOfferByApplication(APP_A_LEGACY_ID)).status, 'accepted');

  const appBOffer = await requestOffer(APP_B_LEGACY_ID, new Date('2026-07-29T19:20:00.000Z'));
  const declineResult = await respondAssignmentOfferInPostgres({
    pool,
    actor: traineeB,
    command: {
      action: 'respond_assignment_offer',
      applicationId: APP_B_LEGACY_ID,
      token: appBOffer.assignmentOffer.token,
      decision: 'decline'
    },
    now: new Date('2026-07-29T19:21:00.000Z')
  });
  assert.equal(declineResult.status, 'declined');
  assert.equal(declineResult.nextStatus, 'queue');
  assert.equal((await getOfferByApplication(APP_B_LEGACY_ID)).status, 'declined');

  await requestOffer(APP_C_LEGACY_ID, new Date('2026-07-29T19:22:00.000Z'));
  const expireResult = await expireAssignmentOffersInPostgres({
    pool,
    actor: { role: 'system' },
    now: new Date('2026-07-29T20:23:00.000Z')
  });
  assert.equal(expireResult.changed, true);
  assert.equal(expireResult.expired.length, 1);
  assert.equal(expireResult.expired[0].application.id, APP_C_LEGACY_ID);

  state = await currentState();
  const expiredAppC = state.applications.find(app => Number(app.id) === APP_C_LEGACY_ID);
  assert.equal(expiredAppC.status, 'queue_expired');
  assert.equal(expiredAppC.assignmentOffer, null);
  assert.equal((await getOfferByApplication(APP_C_LEGACY_ID)).status, 'expired');

  const withdrawResult = await withdrawConfirmedAssignmentInPostgres({
    pool,
    actor: traineeA,
    command: {
      action: 'withdraw_confirmed_assignment',
      baseVersion: state.version,
      applicationId: APP_A_LEGACY_ID
    },
    now: new Date('2026-07-29T20:24:00.000Z')
  });
  assert.equal(withdrawResult.previousStatus, 'confirmed');
  assert.equal(withdrawResult.nextStatus, 'queue');
  assert.equal(withdrawResult.assignmentWithdrawalTarget.application.id, APP_A_LEGACY_ID);

  state = await currentState();
  const withdrawnAppA = state.applications.find(app => Number(app.id) === APP_A_LEGACY_ID);
  assert.equal(withdrawnAppA.status, 'queue');
  assert.equal(withdrawnAppA.shiftId, null);

  const eventResult = await pool.query(
    `
      SELECT event_type
        FROM application_events
       WHERE event_type IN (
         'application_queue_comment_updated',
         'assignment_offer_requested',
         'assignment_offer_message_recorded',
         'assignment_offer_accepted',
         'assignment_offer_declined',
         'assignment_offer_expired',
         'assignment_withdrawn_by_trainee'
       )
    `
  );
  assert.ok(eventResult.rowCount >= 7);

  console.log('PostgreSQL assignment offer write smoke passed.');
} finally {
  await pool.end();
}
