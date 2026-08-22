import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
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

const intervalMs = numericEnv('NOTIFICATION_WORKER_INTERVAL_MS', 15_000);
const limit = numericEnv('NOTIFICATION_WORKER_LIMIT', 20);
const maxAttempts = numericEnv('NOTIFICATION_WORKER_MAX_ATTEMPTS', 3);
const retryDelayMs = numericEnv('NOTIFICATION_WORKER_RETRY_DELAY_MS', 60_000);
const createdAfter = process.env.NOTIFICATION_WORKER_CREATED_AFTER || null;
const botToken = String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
let stopping = false;

function requestStop(signal) {
  stopping = true;
  console.info(JSON.stringify({
    event: 'postgres_notification_worker_stop_requested',
    signal,
    timestamp: new Date().toISOString()
  }));
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

try {
  console.info(JSON.stringify({
    event: 'postgres_notification_worker_started',
    deliveryMode,
    intervalMs,
    limit,
    maxAttempts,
    retryDelayMs,
    createdAfter,
    timestamp: new Date().toISOString()
  }));

  while (!stopping) {
    try {
      const result = await processPendingNotifications({
        pool,
        telegramDelivery,
        botToken,
        limit,
        maxAttempts,
        retryDelayMs,
        createdAfter
      });
      console.info(JSON.stringify({
        event: 'postgres_notification_worker_tick',
        deliveryMode,
        createdAfter,
        ...result,
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'postgres_notification_worker_tick_error',
        error: String(error?.message || error || 'notification_worker_failed')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500),
        timestamp: new Date().toISOString()
      }));
    }

    if (!stopping) {
      await sleep(intervalMs);
    }
  }
} finally {
  await pool.end();
  console.info(JSON.stringify({
    event: 'postgres_notification_worker_stopped',
    timestamp: new Date().toISOString()
  }));
}
