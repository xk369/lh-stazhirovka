import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPostgresPool } from '../src/postgres/connection.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PG_WRITABLE_TEST_PORT || 35441);
const botToken = '123456789:test_token_long_enough';
const baseUrl = `http://127.0.0.1:${port}`;
const traineeReportText = 'Тестовый отчёт стажёра через writable Postgres runtime.';

function telegramInitData(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `writable-${user.id}`,
    user: JSON.stringify(user)
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  return { response, body };
}

async function waitForHealth(child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Writable server exited early:\n${output()}`);
    }
    try {
      const result = await jsonRequest('/api/health');
      if (result.response.ok) return result.body;
    } catch {
      // The server may still be binding its local test port.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Writable server did not become healthy:\n${output()}`);
}

const child = spawn(process.execPath, ['src/server.js'], {
  cwd: projectDir,
  env: {
    ...process.env,
    BOT_TOKEN: botToken,
    TRAINEE_CHAT_ID: '-1000000000001',
    MENTOR_CHAT_ID: '-1000000000002',
    RECRUITER_TELEGRAM_IDS: '1',
    TELEGRAM_BOT_USERNAME: 'TEST_BOT',
    TELEGRAM_DELIVERY_MODE: 'dry_run',
    TELEGRAM_POLLING: 'no',
    BOOKING_STORAGE_MODE: 'postgres',
    HOST: '127.0.0.1',
    PORT: String(port)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let serverOutput = '';
child.stdout.on('data', chunk => {
  serverOutput += chunk;
});
child.stderr.on('data', chunk => {
  serverOutput += chunk;
});

const pool = createPostgresPool();

try {
  const health = await waitForHealth(child, () => serverOutput);
  assert.equal(health.telegramDeliveryMode, 'dry_run');
  assert.equal(health.bookingStorageMode, 'postgres');
  assert.equal(health.bookingStorageWritable, true);

  const recruiterInitData = telegramInitData({
    id: 1,
    first_name: 'Migration',
    last_name: 'Recruiter'
  });
  const traineeInitData = telegramInitData({
    id: 901,
    first_name: 'Writable',
    last_name: 'Trainee',
    username: 'writable_trainee'
  });

  const stateBefore = await jsonRequest('/api/state', {
    headers: { 'x-telegram-init-data': recruiterInitData }
  });
  assert.equal(stateBefore.response.status, 200);

  const createShiftResult = await jsonRequest('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: recruiterInitData,
      action: 'create_shift',
      baseVersion: stateBefore.body.state.version,
      date: '2026-08-20',
      seats: 4
    })
  });
  assert.equal(createShiftResult.response.status, 200);
  assert.equal(createShiftResult.body.ok, true);
  assert.equal(createShiftResult.body.result.date, '2026-08-20');
  assert.equal(createShiftResult.body.state.version, stateBefore.body.state.version + 1);
  assert.ok(createShiftResult.body.state.shifts.some(shift => shift.date === '2026-08-20'));

  const reportResult = await jsonRequest('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: traineeInitData,
      role: 'trainee',
      reportText: traineeReportText
    })
  });
  assert.equal(reportResult.response.status, 200);
  assert.equal(reportResult.body.telegramDeliveryMode, 'dry_run');
  assert.equal(reportResult.body.queued, true);
  assert.equal(reportResult.body.messageId, null);
  assert.equal(reportResult.body.result.notifications.pending, 1);

  const notificationRows = await pool.query(
    `
      SELECT type, chat_id, chat_target, text, status, next_attempt_at
        FROM notifications
       WHERE type = 'trainee_report'
         AND chat_target = 'trainee_report_group'
         AND text = $1
    `,
    [traineeReportText]
  );
  assert.equal(notificationRows.rowCount, 1);
  assert.equal(notificationRows.rows[0].chat_id, '-1000000000001');
  assert.equal(notificationRows.rows[0].status, 'pending');
  assert.ok(notificationRows.rows[0].next_attempt_at);

  assert.doesNotMatch(serverOutput, new RegExp(traineeReportText));
  assert.doesNotMatch(serverOutput, /123456789:test_token_long_enough/);
  console.log('PostgreSQL writable runtime smoke test passed.');
} finally {
  await pool.end();
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
