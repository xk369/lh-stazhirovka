import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TELEGRAM_DELIVERY_MODES
} from '../src/telegram-delivery.js';
import {
  claimPendingNotifications,
  processPendingNotifications
} from '../src/postgres/notification-worker.js';

function fakeNotificationPool(initialRows = []) {
  const calls = [];
  const rows = initialRows.map(row => ({
    id: row.id,
    application_id: row.application_id ?? null,
    mentor_report_id: row.mentor_report_id ?? null,
    type: row.type || 'send_invites',
    chat_id: row.chat_id ?? '100500',
    chat_target: row.chat_target || 'trainee',
    text: row.text ?? 'Тестовое сообщение',
    parse_mode: row.parse_mode ?? 'HTML',
    status: row.status || 'pending',
    telegram_message_id: row.telegram_message_id ?? null,
    error: row.error ?? null,
    idempotency_key: row.idempotency_key || `key-${row.id}`,
    attempt_count: row.attempt_count ?? 0,
    next_attempt_at: row.next_attempt_at ?? null,
    claimed_at: row.claimed_at ?? null,
    sent_at: row.sent_at ?? null,
    created_at: row.created_at || '2026-07-30T10:00:00.000Z',
    updated_at: row.updated_at || '2026-07-30T10:00:00.000Z'
  }));

  function updateRow(id, fields) {
    const row = rows.find(item => item.id === id);
    if (!row) return { rowCount: 0, rows: [] };
    Object.assign(row, fields);
    return { rowCount: 1, rows: [] };
  }

  const client = {
    async query(sql, params = []) {
      calls.push({ source: 'client', sql, params });
      if (/^BEGIN$/i.test(sql) || /^COMMIT$/i.test(sql) || /^ROLLBACK$/i.test(sql)) {
        return { rowCount: 0, rows: [] };
      }
      if (/WITH next_notifications AS/i.test(sql)) {
        const nowIso = params[0];
        const limit = Number(params[1]);
        const createdAfter = params[2] || null;
        const claimed = rows
          .filter(row => row.status === 'pending')
          .filter(row => !row.next_attempt_at || String(row.next_attempt_at) <= nowIso)
          .filter(row => !createdAfter || String(row.created_at) >= String(createdAfter))
          .sort((left, right) => (
            String(left.next_attempt_at || '').localeCompare(String(right.next_attempt_at || ''))
            || String(left.created_at).localeCompare(String(right.created_at))
            || String(left.id).localeCompare(String(right.id))
          ))
          .slice(0, limit);
        for (const row of claimed) {
          row.status = 'sending';
          row.attempt_count += 1;
          row.claimed_at = nowIso;
          row.updated_at = nowIso;
        }
        return { rowCount: claimed.length, rows: claimed.map(row => ({ ...row })) };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ source: 'client', sql: 'RELEASE', params: [] });
    }
  };

  return {
    calls,
    rows,
    async connect() {
      calls.push({ source: 'pool', sql: 'CONNECT', params: [] });
      return client;
    },
    async query(sql, params = []) {
      calls.push({ source: 'pool', sql, params });
      if (/SET status = 'sent'/i.test(sql)) {
        return updateRow(params[0], {
          status: 'sent',
          telegram_message_id: params[1],
          error: null,
          next_attempt_at: null,
          sent_at: params[2],
          updated_at: params[2]
        });
      }
      if (/SET status = 'skipped'/i.test(sql)) {
        return updateRow(params[0], {
          status: 'skipped',
          error: params[1],
          next_attempt_at: null,
          sent_at: null,
          updated_at: params[2]
        });
      }
      if (/SET status = 'pending'/i.test(sql)) {
        return updateRow(params[0], {
          status: 'pending',
          error: params[1],
          next_attempt_at: params[2],
          claimed_at: null,
          updated_at: params[3]
        });
      }
      if (/SET status = 'failed'/i.test(sql)) {
        return updateRow(params[0], {
          status: 'failed',
          error: params[1],
          next_attempt_at: null,
          updated_at: params[2]
        });
      }
      return { rowCount: 0, rows: [] };
    }
  };
}

test('claimPendingNotifications claims only due pending rows and marks them sending', async () => {
  const pool = fakeNotificationPool([
    { id: 'n1', next_attempt_at: null },
    { id: 'n2', next_attempt_at: '2026-07-30T09:59:00.000Z' },
    { id: 'n3', next_attempt_at: '2026-07-30T10:10:00.000Z' },
    { id: 'n4', status: 'failed' }
  ]);

  const claimed = await claimPendingNotifications({
    pool,
    limit: 2,
    now: new Date('2026-07-30T10:00:00.000Z')
  });

  assert.deepEqual(claimed.map(row => row.id), ['n1', 'n2']);
  assert.deepEqual(pool.rows.map(row => row.status), ['sending', 'sending', 'pending', 'failed']);
  assert.equal(pool.rows[0].attempt_count, 1);
  assert.equal(pool.rows[1].claimed_at, '2026-07-30T10:00:00.000Z');
});

test('claimPendingNotifications can ignore old backlog before a cutover timestamp', async () => {
  const pool = fakeNotificationPool([
    { id: 'old', created_at: '2026-07-30T09:59:59.000Z' },
    { id: 'new', created_at: '2026-07-30T10:00:00.000Z' }
  ]);

  const claimed = await claimPendingNotifications({
    pool,
    limit: 10,
    createdAfter: '2026-07-30T10:00:00.000Z',
    now: new Date('2026-07-30T10:01:00.000Z')
  });

  assert.deepEqual(claimed.map(row => row.id), ['new']);
  assert.equal(pool.rows[0].status, 'pending');
  assert.equal(pool.rows[1].status, 'sending');
});

test('processPendingNotifications marks live delivery as sent', async () => {
  const pool = fakeNotificationPool([{ id: 'n1' }]);
  const sentPayloads = [];
  const telegramDelivery = {
    async sendMessage(payload, context) {
      sentPayloads.push({ payload, context });
      return { message_id: 777 };
    }
  };

  const result = await processPendingNotifications({
    pool,
    telegramDelivery,
    botToken: 'bot-token',
    now: new Date('2026-07-30T10:00:00.000Z')
  });

  assert.deepEqual(result, { claimed: 1, sent: 1, skipped: 0, failed: 0, retry: 0 });
  assert.equal(pool.rows[0].status, 'sent');
  assert.equal(pool.rows[0].telegram_message_id, '777');
  assert.equal(pool.rows[0].sent_at, '2026-07-30T10:00:00.000Z');
  assert.equal(sentPayloads[0].payload.parseMode, 'HTML');
  assert.equal(sentPayloads[0].context.context, 'postgres_notification_worker');
});

test('processPendingNotifications marks dry-run delivery as skipped', async () => {
  const pool = fakeNotificationPool([{ id: 'n1' }]);
  const telegramDelivery = {
    async sendMessage() {
      return {
        message_id: null,
        dryRun: true,
        deliveryMode: TELEGRAM_DELIVERY_MODES.DRY_RUN
      };
    }
  };

  const result = await processPendingNotifications({
    pool,
    telegramDelivery,
    botToken: 'bot-token',
    now: new Date('2026-07-30T10:00:00.000Z')
  });

  assert.deepEqual(result, { claimed: 1, sent: 0, skipped: 1, failed: 0, retry: 0 });
  assert.equal(pool.rows[0].status, 'skipped');
  assert.equal(pool.rows[0].error, 'telegram_delivery_dry_run');
  assert.equal(pool.rows[0].telegram_message_id, null);
});

test('processPendingNotifications skips malformed rows without calling Telegram', async () => {
  const pool = fakeNotificationPool([
    { id: 'n1', chat_id: '' },
    { id: 'n2', text: '' }
  ]);
  let calls = 0;
  const telegramDelivery = {
    async sendMessage() {
      calls += 1;
      return { message_id: 1 };
    }
  };

  const result = await processPendingNotifications({
    pool,
    telegramDelivery,
    botToken: 'bot-token',
    limit: 2,
    now: new Date('2026-07-30T10:00:00.000Z')
  });

  assert.deepEqual(result, { claimed: 2, sent: 0, skipped: 2, failed: 0, retry: 0 });
  assert.equal(calls, 0);
  assert.equal(pool.rows[0].status, 'skipped');
  assert.equal(pool.rows[0].error, 'telegram_chat_missing');
  assert.equal(pool.rows[1].status, 'skipped');
  assert.equal(pool.rows[1].error, 'notification_text_missing');
});

test('processPendingNotifications retries transient errors and fails after max attempts', async () => {
  const pool = fakeNotificationPool([
    { id: 'n1', attempt_count: 0 },
    { id: 'n2', attempt_count: 2 }
  ]);
  const telegramDelivery = {
    async sendMessage() {
      throw new Error('Telegram 429 retry later with secret token ignored');
    }
  };

  const result = await processPendingNotifications({
    pool,
    telegramDelivery,
    botToken: 'bot-token',
    limit: 2,
    maxAttempts: 3,
    retryDelayMs: 60_000,
    now: new Date('2026-07-30T10:00:00.000Z'),
    logger: { warn() {} }
  });

  assert.deepEqual(result, { claimed: 2, sent: 0, skipped: 0, failed: 1, retry: 1 });
  assert.equal(pool.rows[0].status, 'pending');
  assert.equal(pool.rows[0].next_attempt_at, '2026-07-30T10:01:00.000Z');
  assert.equal(pool.rows[0].attempt_count, 1);
  assert.equal(pool.rows[1].status, 'failed');
  assert.equal(pool.rows[1].attempt_count, 3);
  assert.match(pool.rows[1].error, /Telegram 429 retry later/);
});
