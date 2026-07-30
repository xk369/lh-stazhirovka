import 'dotenv/config';
import { createPostgresPool } from '../src/postgres/connection.js';
import {
  createTelegramDelivery,
  telegramDeliveryMode
} from '../src/telegram-delivery.js';
import { processPendingNotifications } from '../src/postgres/notification-worker.js';

const pool = createPostgresPool();
const deliveryMode = telegramDeliveryMode();
const telegramDelivery = createTelegramDelivery({ mode: deliveryMode });

function numericEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return Number(value);
}

try {
  const result = await processPendingNotifications({
    pool,
    telegramDelivery,
    botToken: String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    limit: numericEnv('NOTIFICATION_WORKER_LIMIT', 20),
    maxAttempts: numericEnv('NOTIFICATION_WORKER_MAX_ATTEMPTS', 3),
    retryDelayMs: numericEnv('NOTIFICATION_WORKER_RETRY_DELAY_MS', 60_000)
  });
  console.log(JSON.stringify({
    ok: true,
    deliveryMode,
    ...result
  }, null, 2));
} finally {
  await pool.end();
}
