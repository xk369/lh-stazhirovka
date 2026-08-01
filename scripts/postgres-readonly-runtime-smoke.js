import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PG_READONLY_TEST_PORT || 35440);
const botToken = '123456789:test_token_long_enough';
const baseUrl = `http://127.0.0.1:${port}`;

function telegramInitData(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `readonly-${user.id}`,
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
      throw new Error(`Read-only server exited early:\n${output()}`);
    }
    try {
      const result = await jsonRequest('/api/health');
      if (result.response.ok) return result.body;
    } catch {
      // The server may still be binding its local test port.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Read-only server did not become healthy:\n${output()}`);
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
    TELEGRAM_POLLING: 'yes',
    BOOKING_STORAGE_MODE: 'postgres_readonly',
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

try {
  const health = await waitForHealth(child, () => serverOutput);
  assert.equal(health.telegramDeliveryMode, 'dry_run');
  assert.equal(health.bookingStorageMode, 'postgres_readonly');
  assert.equal(health.bookingStorageWritable, false);

  const traineeInitData = telegramInitData({
    id: 900,
    first_name: 'Passed',
    last_name: 'Trainee',
    username: 'passed_trainee'
  });
  const recruiterInitData = telegramInitData({
    id: 1,
    first_name: 'Migration',
    last_name: 'Recruiter'
  });

  const stateResult = await jsonRequest('/api/state', {
    headers: { 'x-telegram-init-data': traineeInitData }
  });
  assert.equal(stateResult.response.status, 200);
  assert.equal(stateResult.body.state.version, 7);
  assert.equal(stateResult.body.state.applications.length, 1);
  assert.equal(stateResult.body.state.applications[0].id, 200);

  const notifyResult = await jsonRequest('/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: recruiterInitData,
      applicationId: 200,
      text: 'Этот текст не должен уйти в Telegram'
    })
  });
  assert.equal(notifyResult.response.status, 200);
  assert.equal(notifyResult.body.skipped, 'telegram_delivery_dry_run');

  const reportResult = await jsonRequest('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: traineeInitData,
      role: 'trainee',
      reportText: 'Тестовый отчет staging без отправки'
    })
  });
  assert.equal(reportResult.response.status, 200);
  assert.equal(reportResult.body.telegramDeliveryMode, 'dry_run');
  assert.equal(reportResult.body.messageId, null);

  const writeResult = await jsonRequest('/api/telegram/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: traineeInitData,
      applicationId: 200
    })
  });
  assert.equal(writeResult.response.status, 503);
  assert.equal(writeResult.body.code, 'BOOKING_STORAGE_READ_ONLY');

  assert.match(serverOutput, /telegram_delivery_dry_run/);
  assert.doesNotMatch(serverOutput, /Тестовый отчет staging без отправки/);
  assert.doesNotMatch(serverOutput, /123456789:test_token_long_enough/);
  console.log('PostgreSQL read-only runtime smoke test passed.');
} finally {
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
