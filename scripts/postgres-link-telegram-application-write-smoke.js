import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import { linkTelegramApplicationInPostgres } from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const now = new Date('2026-07-29T12:38:00.000Z');
const trainee = {
  role: 'trainee',
  userId: 'postgres-link-trainee',
  telegram: {
    user: {
      id: '990000777',
      username: 'postgres_link_trainee'
    }
  }
};

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const idResult = await pool.query(
    'SELECT COALESCE(MAX(legacy_id), 0) + 100000 AS next_legacy_id FROM applications'
  );
  const applicationLegacyId = Number(idResult.rows[0].next_legacy_id);
  const applicationUuid = crypto.randomUUID();

  await pool.query(
    `
      INSERT INTO applications (
        id, legacy_id, name, phone, training, training_date, attempt, limits,
        status, telegram_code, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, 'passed', $5, 'first', $6, 'queue', $7, $8, $8)
    `,
    [
      applicationUuid,
      applicationLegacyId,
      `Postgres Link ${applicationLegacyId}`,
      '+7 999 000-07-77',
      '2026-07-20',
      'link smoke',
      'postgres_link_trainee',
      now.toISOString()
    ]
  );

  const result = await linkTelegramApplicationInPostgres({
    pool,
    actor: trainee,
    command: {
      action: 'link_telegram_application',
      applicationId: applicationLegacyId
    },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousVersion, beforeState.version);
  assert.equal(result.version, beforeState.version + 1);
  assert.equal(result.telegramUserId, '990000777');
  assert.equal(result.telegramChatId, '990000777');
  assert.equal(result.telegramUsername, 'postgres_link_trainee');

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, beforeState.version + 1);
  const linkedApplication = afterState.applications.find(item => item.id === applicationLegacyId);
  assert.ok(linkedApplication);
  assert.equal(linkedApplication.telegramUserId, '990000777');
  assert.equal(linkedApplication.telegramChatId, '990000777');
  assert.equal(linkedApplication.telegramUsername, 'postgres_link_trainee');

  const eventResult = await pool.query(
    `
      SELECT event_type, actor_type, actor_telegram_user_id, payload
        FROM application_events
       WHERE application_id = $1
         AND event_type = 'telegram_application_linked'
    `,
    [applicationUuid]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'trainee');
  assert.equal(event.actor_telegram_user_id, '990000777');
  assert.equal(event.payload.action, 'link_telegram_application');
  assert.equal(event.payload.legacyApplicationId, applicationLegacyId);

  console.log('PostgreSQL link_telegram_application write smoke test passed.');
} finally {
  await pool.end();
}
