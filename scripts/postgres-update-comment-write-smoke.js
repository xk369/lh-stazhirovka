import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { updateCommentInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

const SHIFT_LEGACY_ID = 910020;
const APPLICATION_LEGACY_ID = 910021;

async function seedCommentTarget(seedIso) {
  const shiftId = randomUUID();
  const applicationId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, '2026-10-02'::date, 4, true, false, NULL, $3, $3)
      `,
      [shiftId, SHIFT_LEGACY_ID, seedIso]
    );
    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          recruiter_comment, venue_id, group_link,
          candidate_report, mentor_report_received,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, NULL,
          '930021', '930021', 'update_comment_smoke',
          'Update Comment Smoke', '+7 999 000-10-02', 'passed', '2026-09-21',
          'first', '', 'confirmed',
          'old smoke comment', NULL, '',
          false, false,
          $4, $4
        )
      `,
      [applicationId, APPLICATION_LEGACY_ID, shiftId, seedIso]
    );
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
  const seedIso = '2026-07-29T17:35:00.000Z';
  await seedCommentTarget(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const targetApp = seededState.applications.find(
    app => Number(app.id) === APPLICATION_LEGACY_ID
  );
  assert.ok(targetApp);
  assert.equal(targetApp.comment, 'old smoke comment');

  const updateNow = new Date('2026-07-29T17:40:00.000Z');
  const result = await updateCommentInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_comment',
      baseVersion: seededState.version,
      applicationId: APPLICATION_LEGACY_ID,
      comment: '  Новый smoke-комментарий рекрута  '
    },
    now: updateNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, APPLICATION_LEGACY_ID);
  assert.equal(result.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(result.previousComment, 'old smoke comment');
  assert.equal(result.nextComment, 'Новый smoke-комментарий рекрута');
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);
  assert.equal(result.updatedAt, updateNow.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  const updatedApp = afterState.applications.find(
    app => Number(app.id) === APPLICATION_LEGACY_ID
  );
  assert.equal(updatedApp.comment, 'Новый smoke-комментарий рекрута');

  const eventResult = await pool.query(
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
       WHERE application_events.event_type = 'application_comment_updated'
         AND applications.legacy_id = $1
    `,
    [APPLICATION_LEGACY_ID]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'recruiter');
  assert.equal(event.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(event.application_legacy_id), APPLICATION_LEGACY_ID);
  assert.equal(Number(event.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(event.payload.action, 'update_comment');
  assert.equal(event.payload.previousLength, 'old smoke comment'.length);
  assert.equal(event.payload.nextLength, 'Новый smoke-комментарий рекрута'.length);
  assert.equal(event.payload.previousVersion, seededState.version);
  assert.equal(event.payload.nextVersion, result.version);

  const noopResult = await updateCommentInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_comment',
      baseVersion: afterState.version,
      applicationId: APPLICATION_LEGACY_ID,
      comment: 'Новый smoke-комментарий рекрута'
    },
    now: new Date('2026-07-29T17:45:00.000Z')
  });
  assert.equal(noopResult.changed, false);
  assert.equal(noopResult.version, afterState.version);

  console.log('PostgreSQL update_comment write smoke test passed.');
} finally {
  await pool.end();
}
