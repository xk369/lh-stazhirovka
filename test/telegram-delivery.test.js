import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  TELEGRAM_DELIVERY_MODES,
  createTelegramDelivery,
  telegramDeliveryMode
} from '../src/telegram-delivery.js';

test('Telegram delivery mode defaults to live and rejects unknown values', () => {
  assert.equal(telegramDeliveryMode({}), TELEGRAM_DELIVERY_MODES.LIVE);
  assert.equal(
    telegramDeliveryMode({ TELEGRAM_DELIVERY_MODE: ' DRY_RUN ' }),
    TELEGRAM_DELIVERY_MODES.DRY_RUN
  );
  assert.throws(
    () => telegramDeliveryMode({ TELEGRAM_DELIVERY_MODE: 'disabled' }),
    /must be "live" or "dry_run"/
  );
});

test('Telegram dry-run never calls live message or photo senders', async () => {
  const logs = [];
  let liveCalls = 0;
  const delivery = createTelegramDelivery({
    mode: TELEGRAM_DELIVERY_MODES.DRY_RUN,
    logger: { info: value => logs.push(value) },
    messageSender: async () => {
      liveCalls += 1;
    },
    photoSender: async () => {
      liveCalls += 1;
    }
  });
  const secretPayload = {
    botToken: 'secret-bot-token',
    chatId: '-1001234567890',
    text: 'Персональный отчет Виктории'
  };

  const message = await delivery.sendMessage(secretPayload, {
    context: 'mentor_report',
    chatTarget: 'mentor_report_group'
  });
  const photo = await delivery.sendPhoto({
    ...secretPayload,
    text: undefined,
    photo: 'https://example.test/private-photo.jpg',
    caption: 'Секретная подпись'
  }, {
    context: 'recruiter_notification_photo',
    chatTarget: 'trainee'
  });

  assert.equal(liveCalls, 0);
  assert.equal(message.dryRun, true);
  assert.equal(photo.dryRun, true);
  assert.equal(logs.length, 2);

  const combinedLogs = logs.join('\n');
  assert.doesNotMatch(combinedLogs, /secret-bot-token/);
  assert.doesNotMatch(combinedLogs, /-1001234567890/);
  assert.doesNotMatch(combinedLogs, /Персональный отчет Виктории/);
  assert.doesNotMatch(combinedLogs, /Секретная подпись/);

  const messageLog = JSON.parse(logs[0]);
  assert.equal(messageLog.event, 'telegram_delivery_dry_run');
  assert.equal(messageLog.kind, 'message');
  assert.equal(messageLog.context, 'mentor_report');
  assert.equal(messageLog.chatTarget, 'mentor_report_group');
  assert.equal(messageLog.contentLength, secretPayload.text.length);
  assert.match(messageLog.contentSha256, /^[a-f0-9]{64}$/);
});

test('Telegram live delivery delegates to the real sender interface', async () => {
  const calls = [];
  const delivery = createTelegramDelivery({
    mode: TELEGRAM_DELIVERY_MODES.LIVE,
    messageSender: async payload => {
      calls.push(payload);
      return { message_id: 42 };
    }
  });
  const payload = { botToken: 'token', chatId: '123', text: 'hello' };

  const result = await delivery.sendMessage(payload);

  assert.deepEqual(calls, [payload]);
  assert.deepEqual(result, { message_id: 42 });
});

test('server routes every outbound send through the Telegram delivery gateway', async () => {
  const source = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\bsendTelegramMessage\b/);
  assert.doesNotMatch(source, /\bsendTelegramPhoto\b/);
  assert.match(source, /telegramDelivery\.sendMessage/);
  assert.match(source, /telegramDelivery\.sendPhoto/);
  assert.match(source, /telegramDeliveryMode:\s*config\.telegramDeliveryMode/);
});
