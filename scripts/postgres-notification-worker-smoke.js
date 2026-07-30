import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { processPendingNotifications } from '../src/postgres/notification-worker.js';
import {
  TELEGRAM_DELIVERY_MODES,
  createTelegramDelivery
} from '../src/telegram-delivery.js';

const pool = createPostgresPool();
const notificationId = randomUUID();
const nowIso = '2026-07-30T16:00:00.000Z';

try {
  await pool.query(
    `
      UPDATE notifications
         SET next_attempt_at = $1,
             updated_at = $1
       WHERE status = 'pending'
    `,
    ['2026-08-01T00:00:00.000Z']
  );

  await pool.query(
    `
      INSERT INTO notifications (
        id, application_id, mentor_report_id, type, chat_id, chat_target, text,
        parse_mode, status, error, idempotency_key, next_attempt_at,
        created_at, updated_at
      )
      VALUES (
        $1, NULL, NULL, 'trainee_report', '-1003951918570',
        'trainee_report_group', 'Notification worker smoke message',
        NULL, 'pending', NULL, $2, $3, $3, $3
      )
    `,
    [notificationId, `notification_worker_smoke:${notificationId}`, nowIso]
  );

  const result = await processPendingNotifications({
    pool,
    telegramDelivery: createTelegramDelivery({
      mode: TELEGRAM_DELIVERY_MODES.DRY_RUN,
      logger: { info() {} }
    }),
    botToken: 'dry-run-token',
    limit: 5,
    now: new Date('2026-07-30T16:01:00.000Z'),
    logger: { warn() {} }
  });

  assert.deepEqual(result, {
    claimed: 1,
    sent: 0,
    skipped: 1,
    failed: 0,
    retry: 0
  });

  const rowResult = await pool.query(
    `
      SELECT status, error, attempt_count, claimed_at, sent_at, telegram_message_id
        FROM notifications
       WHERE id = $1
    `,
    [notificationId]
  );
  assert.equal(rowResult.rowCount, 1);
  assert.equal(rowResult.rows[0].status, 'skipped');
  assert.equal(rowResult.rows[0].error, 'telegram_delivery_dry_run');
  assert.equal(Number(rowResult.rows[0].attempt_count), 1);
  assert.ok(rowResult.rows[0].claimed_at);
  assert.equal(rowResult.rows[0].sent_at, null);
  assert.equal(rowResult.rows[0].telegram_message_id, null);

  const secondResult = await processPendingNotifications({
    pool,
    telegramDelivery: createTelegramDelivery({
      mode: TELEGRAM_DELIVERY_MODES.DRY_RUN,
      logger: { info() {} }
    }),
    botToken: 'dry-run-token',
    limit: 5,
    now: new Date('2026-07-30T16:02:00.000Z'),
    logger: { warn() {} }
  });
  assert.deepEqual(secondResult, {
    claimed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    retry: 0
  });

  console.log('PostgreSQL notification worker dry-run smoke passed.');
} finally {
  await pool.end();
}
