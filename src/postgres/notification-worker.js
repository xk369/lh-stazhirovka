import { TELEGRAM_DELIVERY_MODES } from '../telegram-delivery.js';
import { runInPostgresTransaction } from './transaction.js';

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 60_000;

function normalizeLimit(value) {
  const limit = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('notification worker limit must be an integer between 1 and 100.');
  }
  return limit;
}

function normalizeMaxAttempts(value) {
  const attempts = Number(value ?? DEFAULT_MAX_ATTEMPTS);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error('notification worker maxAttempts must be an integer between 1 and 20.');
  }
  return attempts;
}

function normalizeRetryDelayMs(value) {
  const delay = Number(value ?? DEFAULT_RETRY_DELAY_MS);
  if (!Number.isFinite(delay) || delay < 1_000 || delay > 86_400_000) {
    throw new Error('notification worker retryDelayMs must be between 1000 and 86400000.');
  }
  return delay;
}

function sanitizeDeliveryError(error) {
  return String(error?.message || error || 'telegram_delivery_failed')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function nextRetryDate(now, retryDelayMs) {
  return new Date(now.getTime() + retryDelayMs);
}

export async function claimPendingNotifications({ pool, limit = DEFAULT_LIMIT, now = new Date() }) {
  const normalizedLimit = normalizeLimit(limit);
  const nowIso = now.toISOString();

  return runInPostgresTransaction(pool, async client => {
    const result = await client.query(
      `
        WITH next_notifications AS (
          SELECT id
            FROM notifications
           WHERE status = 'pending'
             AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
           ORDER BY next_attempt_at NULLS FIRST, created_at, id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        UPDATE notifications
           SET status = 'sending',
               attempt_count = attempt_count + 1,
               claimed_at = $1,
               updated_at = $1
         WHERE id IN (SELECT id FROM next_notifications)
        RETURNING id,
                  application_id,
                  mentor_report_id,
                  type,
                  chat_id,
                  chat_target,
                  text,
                  parse_mode,
                  status,
                  telegram_message_id,
                  error,
                  idempotency_key,
                  attempt_count,
                  next_attempt_at,
                  claimed_at,
                  created_at,
                  updated_at
      `,
      [nowIso, normalizedLimit]
    );
    return result.rows;
  });
}

async function markNotificationSent({ pool, notificationId, telegramMessageId, now }) {
  const nowIso = now.toISOString();
  await pool.query(
    `
      UPDATE notifications
         SET status = 'sent',
             telegram_message_id = $2,
             error = NULL,
             next_attempt_at = NULL,
             sent_at = $3,
             updated_at = $3
       WHERE id = $1
    `,
    [notificationId, telegramMessageId ? String(telegramMessageId) : null, nowIso]
  );
}

async function markNotificationSkipped({ pool, notificationId, reason, now }) {
  const nowIso = now.toISOString();
  await pool.query(
    `
      UPDATE notifications
         SET status = 'skipped',
             error = $2,
             next_attempt_at = NULL,
             sent_at = NULL,
             updated_at = $3
       WHERE id = $1
    `,
    [notificationId, reason, nowIso]
  );
}

async function markNotificationRetry({ pool, notificationId, error, nextAttemptAt, now }) {
  const nowIso = now.toISOString();
  await pool.query(
    `
      UPDATE notifications
         SET status = 'pending',
             error = $2,
             next_attempt_at = $3,
             claimed_at = NULL,
             updated_at = $4
       WHERE id = $1
    `,
    [notificationId, error, nextAttemptAt.toISOString(), nowIso]
  );
}

async function markNotificationFailed({ pool, notificationId, error, now }) {
  const nowIso = now.toISOString();
  await pool.query(
    `
      UPDATE notifications
         SET status = 'failed',
             error = $2,
             next_attempt_at = NULL,
             updated_at = $3
       WHERE id = $1
    `,
    [notificationId, error, nowIso]
  );
}

export async function processPendingNotifications({
  pool,
  telegramDelivery,
  botToken,
  limit = DEFAULT_LIMIT,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  now = new Date(),
  logger = console
}) {
  if (!pool) throw new TypeError('notification worker requires a pg pool.');
  if (!telegramDelivery || typeof telegramDelivery.sendMessage !== 'function') {
    throw new TypeError('notification worker requires telegramDelivery.sendMessage().');
  }
  const normalizedMaxAttempts = normalizeMaxAttempts(maxAttempts);
  const normalizedRetryDelayMs = normalizeRetryDelayMs(retryDelayMs);
  const claimed = await claimPendingNotifications({ pool, limit, now });
  const summary = {
    claimed: claimed.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    retry: 0
  };

  for (const row of claimed) {
    const notificationId = row.id;
    const chatId = String(row.chat_id || '').trim();
    const text = String(row.text || '').trim();
    const attemptCount = Number(row.attempt_count) || 0;

    if (!chatId) {
      await markNotificationSkipped({
        pool,
        notificationId,
        reason: 'telegram_chat_missing',
        now
      });
      summary.skipped += 1;
      continue;
    }

    if (!text) {
      await markNotificationSkipped({
        pool,
        notificationId,
        reason: 'notification_text_missing',
        now
      });
      summary.skipped += 1;
      continue;
    }

    try {
      const deliveryResult = await telegramDelivery.sendMessage(
        {
          botToken,
          chatId,
          text,
          parseMode: row.parse_mode || ''
        },
        {
          context: 'postgres_notification_worker',
          chatTarget: row.chat_target || 'unspecified',
          notificationType: row.type || 'unspecified',
          notificationId
        }
      );

      if (deliveryResult?.dryRun || deliveryResult?.deliveryMode === TELEGRAM_DELIVERY_MODES.DRY_RUN) {
        await markNotificationSkipped({
          pool,
          notificationId,
          reason: 'telegram_delivery_dry_run',
          now
        });
        summary.skipped += 1;
        continue;
      }

      await markNotificationSent({
        pool,
        notificationId,
        telegramMessageId: deliveryResult?.message_id,
        now
      });
      summary.sent += 1;
    } catch (error) {
      const sanitizedError = sanitizeDeliveryError(error);
      if (attemptCount < normalizedMaxAttempts) {
        await markNotificationRetry({
          pool,
          notificationId,
          error: sanitizedError,
          nextAttemptAt: nextRetryDate(now, normalizedRetryDelayMs),
          now
        });
        summary.retry += 1;
      } else {
        await markNotificationFailed({
          pool,
          notificationId,
          error: sanitizedError,
          now
        });
        summary.failed += 1;
      }
      logger.warn?.(JSON.stringify({
        event: 'postgres_notification_worker_delivery_error',
        notificationId,
        attemptCount,
        retry: attemptCount < normalizedMaxAttempts,
        error: sanitizedError
      }));
    }
  }

  return summary;
}
