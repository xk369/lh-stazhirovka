import crypto from 'node:crypto';
import {
  sendTelegramMessage,
  sendTelegramPhoto
} from './telegram.js';

export const TELEGRAM_DELIVERY_MODES = Object.freeze({
  LIVE: 'live',
  DRY_RUN: 'dry_run'
});

export function telegramDeliveryMode(env = process.env) {
  const mode = String(env.TELEGRAM_DELIVERY_MODE || TELEGRAM_DELIVERY_MODES.LIVE)
    .trim()
    .toLowerCase();
  if (!Object.values(TELEGRAM_DELIVERY_MODES).includes(mode)) {
    throw new Error('TELEGRAM_DELIVERY_MODE must be "live" or "dry_run".');
  }
  return mode;
}

function contentFingerprint(value) {
  const text = String(value || '');
  return {
    length: text.length,
    sha256: crypto.createHash('sha256').update(text).digest('hex')
  };
}

function dryRunResult(kind, payload, context, logger) {
  const content = contentFingerprint(kind === 'photo' ? payload.caption : payload.text);
  const event = {
    event: 'telegram_delivery_dry_run',
    kind,
    context: String(context?.context || 'unspecified'),
    chatTarget: String(context?.chatTarget || 'unspecified'),
    contentLength: content.length,
    contentSha256: content.sha256,
    hasPhoto: kind === 'photo' && Boolean(payload.photo),
    timestamp: new Date().toISOString()
  };
  logger.info(JSON.stringify(event));
  return {
    message_id: null,
    dryRun: true,
    deliveryMode: TELEGRAM_DELIVERY_MODES.DRY_RUN
  };
}

export function createTelegramDelivery({
  mode = TELEGRAM_DELIVERY_MODES.LIVE,
  logger = console,
  messageSender = sendTelegramMessage,
  photoSender = sendTelegramPhoto
} = {}) {
  const normalizedMode = telegramDeliveryMode({ TELEGRAM_DELIVERY_MODE: mode });

  return {
    mode: normalizedMode,

    async sendMessage(payload, context = {}) {
      if (normalizedMode === TELEGRAM_DELIVERY_MODES.DRY_RUN) {
        return dryRunResult('message', payload, context, logger);
      }
      return messageSender(payload);
    },

    async sendPhoto(payload, context = {}) {
      if (normalizedMode === TELEGRAM_DELIVERY_MODES.DRY_RUN) {
        return dryRunResult('photo', payload, context, logger);
      }
      return photoSender(payload);
    }
  };
}
