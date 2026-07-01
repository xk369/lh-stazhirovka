import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { TelegramAuthError, validateTelegramInitData } from '../src/telegram.js';
import { normalizeReportText, normalizeRole, resolveChatId } from '../src/report.js';

const BOT_TOKEN = '123456789:TEST_TOKEN_FOR_UNIT_TESTS_ONLY';

function createInitData({ authDate = 1_800_000_000, userId = 12345 } = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: 'AAEAAAE',
    user: JSON.stringify({ id: userId, first_name: 'Test', username: 'tester' })
  });

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

test('accepts valid Telegram initData', () => {
  const result = validateTelegramInitData({
    initData: createInitData(),
    botToken: BOT_TOKEN,
    nowSeconds: 1_800_000_100,
    maxAgeSeconds: 3600
  });
  assert.equal(result.user.id, 12345);
  assert.equal(result.user.username, 'tester');
});

test('rejects missing Telegram initData', () => {
  assert.throws(
    () =>
      validateTelegramInitData({
        initData: '',
        botToken: BOT_TOKEN,
        nowSeconds: 1_800_000_100,
        maxAgeSeconds: 3600
      }),
    error => error instanceof TelegramAuthError && error.code === 'INIT_DATA_MISSING'
  );
});

test('rejects tampered Telegram initData', () => {
  const tampered = createInitData().replace('tester', 'attacker');
  assert.throws(
    () =>
      validateTelegramInitData({
        initData: tampered,
        botToken: BOT_TOKEN,
        nowSeconds: 1_800_000_100,
        maxAgeSeconds: 3600
      }),
    TelegramAuthError
  );
});

test('rejects Telegram initData from the future', () => {
  assert.throws(
    () =>
      validateTelegramInitData({
        initData: createInitData({ authDate: 1_800_001_000 }),
        botToken: BOT_TOKEN,
        nowSeconds: 1_800_000_100,
        maxAgeSeconds: 3600
      }),
    error => error instanceof TelegramAuthError && error.code === 'AUTH_DATE_IN_FUTURE'
  );
});

test('rejects expired Telegram initData', () => {
  assert.throws(
    () =>
      validateTelegramInitData({
        initData: createInitData({ authDate: 1_700_000_000 }),
        botToken: BOT_TOKEN,
        nowSeconds: 1_800_000_100,
        maxAgeSeconds: 3600
      }),
    error => error instanceof TelegramAuthError && error.code === 'INIT_DATA_EXPIRED'
  );
});

test('routes roles only to server-side chat ids', () => {
  const config = { traineeChatId: '-1001', mentorChatId: '-1002' };
  assert.equal(resolveChatId(normalizeRole('trainee'), config), '-1001');
  assert.equal(resolveChatId(normalizeRole('mentor'), config), '-1002');
  assert.equal(resolveChatId(normalizeRole('mentor'), { traineeChatId: '-1001', mentorChatId: '-1001' }), '-1001');
  assert.throws(() => normalizeRole('admin'));
});

test('enforces Telegram-safe report length', () => {
  assert.equal(normalizeReportText(' report '), 'report');
  assert.throws(() => normalizeReportText(''));
  assert.throws(() => normalizeReportText('x'.repeat(3901)));
});
