import crypto from 'node:crypto';

export class TelegramAuthError extends Error {
  constructor(message, code = 'INVALID_TELEGRAM_DATA') {
    super(message);
    this.name = 'TelegramAuthError';
    this.code = code;
  }
}

/**
 * Validates Telegram.WebApp.initData using the bot token.
 * The implementation follows Telegram's HMAC-SHA-256 validation algorithm.
 */
export function validateTelegramInitData({
  initData,
  botToken,
  maxAgeSeconds = 86_400,
  nowSeconds = Math.floor(Date.now() / 1000)
}) {
  if (typeof initData !== 'string' || initData.length === 0) {
    throw new TelegramAuthError('Приложение должно быть открыто через Telegram.', 'INIT_DATA_MISSING');
  }
  if (typeof botToken !== 'string' || botToken.length < 20) {
    throw new Error('BOT_TOKEN is not configured correctly.');
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    throw new TelegramAuthError('Некорректная подпись Telegram.', 'HASH_MISSING');
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  const receivedBuffer = Buffer.from(receivedHash, 'hex');
  const calculatedBuffer = Buffer.from(calculatedHash, 'hex');

  if (
    receivedBuffer.length !== calculatedBuffer.length ||
    !crypto.timingSafeEqual(receivedBuffer, calculatedBuffer)
  ) {
    throw new TelegramAuthError('Не удалось подтвердить запуск через Telegram.', 'HASH_MISMATCH');
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) {
    throw new TelegramAuthError('В данных Telegram отсутствует время запуска.', 'AUTH_DATE_MISSING');
  }

  if (authDate > nowSeconds + 300) {
    throw new TelegramAuthError('Некорректное время запуска Telegram.', 'AUTH_DATE_IN_FUTURE');
  }

  if (maxAgeSeconds > 0 && nowSeconds - authDate > maxAgeSeconds) {
    throw new TelegramAuthError(
      'Сессия Telegram устарела. Закройте приложение и откройте его заново из бота.',
      'INIT_DATA_EXPIRED'
    );
  }

  let user = null;
  const rawUser = params.get('user');
  if (rawUser) {
    try {
      user = JSON.parse(rawUser);
    } catch {
      throw new TelegramAuthError('Не удалось прочитать данные пользователя Telegram.', 'USER_INVALID');
    }
  }

  if (!user || !Number.isSafeInteger(Number(user.id))) {
    throw new TelegramAuthError('Telegram не передал данные пользователя.', 'USER_MISSING');
  }

  return {
    user: { ...user, id: Number(user.id) },
    authDate,
    queryId: params.get('query_id') || null
  };
}

export async function sendTelegramMessage({
  botToken,
  chatId,
  text,
  parseMode = '',
  disableWebPagePreview = false
}) {
  const body = {
    chat_id: chatId,
    text
  };

  if (parseMode) body.parse_mode = parseMode;
  if (disableWebPagePreview) body.disable_web_page_preview = true;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return readTelegramResult(response);
}

export async function sendTelegramPhoto({
  botToken,
  chatId,
  photo,
  caption = '',
  parseMode = ''
}) {
  const body = {
    chat_id: chatId,
    photo,
    caption: String(caption || '').slice(0, 1024)
  };

  if (parseMode) body.parse_mode = parseMode;

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return readTelegramResult(response);
}

async function readTelegramResult(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The response body is only used to provide a useful server-side error.
  }

  if (!response.ok || !payload?.ok) {
    const description = payload?.description || `Telegram API returned HTTP ${response.status}`;
    throw new Error(description);
  }

  return payload.result;
}
