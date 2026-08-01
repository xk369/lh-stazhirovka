import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { cancelApplicationInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const trainee = {
  role: 'trainee',
  userId: '930050',
  telegram: {
    user: {
      id: '930050',
      username: 'cancel_app_smoke'
    }
  }
};

const APPLICATION_LEGACY_ID = 910050;

async function seedQueueApplication(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
          $1, $2, NULL, NULL,
          $3, $3, $4,
          'Cancel Application Smoke', '+7 999 000-50-50', 'not_passed', NULL,
          'first', '', 'queue',
          NULL, '',
          false, false,
          $5, $5
        )
      `,
      [
        randomUUID(),
        APPLICATION_LEGACY_ID,
        trainee.userId,
        trainee.telegram.user.username,
        seedIso
      ]
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
  const seedIso = '2026-07-29T18:25:00.000Z';
  await seedQueueApplication(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  assert.ok(seededState.applications.some(app => Number(app.id) === APPLICATION_LEGACY_ID));

  const cancelNow = new Date('2026-07-29T18:30:00.000Z');
  const result = await cancelApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'cancel_application',
      baseVersion: seededState.version,
      applicationId: APPLICATION_LEGACY_ID
    },
    now: cancelNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, APPLICATION_LEGACY_ID);
  assert.equal(result.previousStatus, 'queue');
  assert.equal(result.previousShiftId, null);
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);
  assert.equal(result.updatedAt, cancelNow.toISOString());

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, result.version);
  assert.equal(
    afterState.applications.some(app => Number(app.id) === APPLICATION_LEGACY_ID),
    false
  );

  const eventResult = await pool.query(
    `
      SELECT event_type, actor_type, actor_telegram_user_id, payload, application_id
        FROM application_events
       WHERE event_type = 'application_cancelled'
         AND payload->>'legacyApplicationId' = $1
    `,
    [String(APPLICATION_LEGACY_ID)]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.application_id, null);
  assert.equal(event.actor_type, 'trainee');
  assert.equal(event.actor_telegram_user_id, trainee.userId);
  assert.equal(event.payload.action, 'cancel_application');
  assert.equal(event.payload.previousStatus, 'queue');
  assert.equal(event.payload.previousShiftId, null);

  console.log('PostgreSQL cancel_application write smoke test passed.');
} finally {
  await pool.end();
}
