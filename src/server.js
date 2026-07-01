import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import {
  TelegramAuthError,
  sendTelegramMessage,
  sendTelegramPhoto,
  validateTelegramInitData
} from './telegram.js';
import { normalizeReportText, normalizeRole, resolveChatId } from './report.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const config = {
  port: Number(process.env.PORT || 3000),
  host: String(process.env.HOST || '0.0.0.0').trim(),
  botToken: String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  traineeChatId: String(process.env.TRAINEE_CHAT_ID || '').trim(),
  mentorChatId: String(process.env.MENTOR_CHAT_ID || '').trim(),
  initDataTtlSeconds: Number(process.env.INIT_DATA_TTL_SECONDS || 86_400),
  dataDir: String(process.env.DATA_DIR || path.resolve(__dirname, '../data')),
  telegramBotUsername: String(process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim(),
  telegramPollingEnabled: process.env.TELEGRAM_POLLING === 'yes'
};

const dbPath = path.join(config.dataDir, 'db.json');
let telegramOffset = 0;

function assertConfig() {
  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.traineeChatId) missing.push('TRAINEE_CHAT_ID');
  if (!config.mentorChatId) missing.push('MENTOR_CHAT_ID');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (!Number.isInteger(config.port) || config.port <= 0) {
    throw new Error('PORT must be a positive integer.');
  }
  if (!Number.isInteger(config.initDataTtlSeconds) || config.initDataTtlSeconds <= 0) {
    throw new Error('INIT_DATA_TTL_SECONDS must be a positive integer.');
  }
  if (!config.host) {
    throw new Error('HOST must not be empty.');
  }
}

function validateRequestInitData(initData) {
  return validateTelegramInitData({
    initData,
    botToken: config.botToken,
    maxAgeSeconds: config.initDataTtlSeconds
  });
}

function serializeTelegramUser(user) {
  return {
    id: user.id,
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    username: user.username || '',
    languageCode: user.language_code || '',
    isPremium: Boolean(user.is_premium),
    allowsWriteToPm: Boolean(user.allows_write_to_pm)
  };
}

function nextDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function seedBookingState() {
  return {
    shifts: [
      { id: 1, date: nextDate(2), seats: 3, status: 'open' },
      { id: 2, date: nextDate(4), seats: 4, status: 'open' },
      { id: 3, date: nextDate(6), seats: 2, status: 'open' }
    ],
    applications: [
      {
        id: 101,
        shiftId: 2,
        name: 'Петрова Алина',
        training: 'passed',
        attempt: 'first',
        experience: 'yes',
        limits: 'Могу после 14:00, центр подходит.',
        status: 'new',
        recruiterComment: '',
        candidateReport: false,
        mentorReport: false,
        createdAt: nextDate(-1)
      },
      {
        id: 102,
        shiftId: 1,
        name: 'Смирнов Никита',
        training: 'not_passed',
        attempt: 'repeat',
        experience: 'yes',
        limits: 'Без ограничений.',
        status: 'confirmed',
        recruiterComment: 'Подтвержден.',
        candidateReport: true,
        mentorReport: false,
        createdAt: nextDate(-1)
      },
      {
        id: 103,
        shiftId: null,
        name: 'Козлова Мария',
        training: 'passed',
        attempt: 'first',
        experience: 'no',
        limits: 'Ограничений нет, готова на ближайшую дату.',
        status: 'queue',
        recruiterComment: '',
        candidateReport: false,
        mentorReport: false,
        createdAt: nextDate(-1)
      }
    ],
    inviteGroups: []
  };
}

async function ensureDb() {
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    await fs.access(dbPath);
  } catch {
    await writeBookingState(seedBookingState());
  }
}

function normalizeBookingState(state) {
  return {
    shifts: Array.isArray(state?.shifts) ? state.shifts : [],
    applications: Array.isArray(state?.applications) ? state.applications : [],
    inviteGroups: Array.isArray(state?.inviteGroups) ? state.inviteGroups : []
  };
}

async function readBookingState() {
  await ensureDb();
  try {
    const raw = await fs.readFile(dbPath, 'utf8');
    return normalizeBookingState(JSON.parse(raw));
  } catch (error) {
    const backupPath = path.join(config.dataDir, `db.corrupt-${Date.now()}.json`);
    try {
      await fs.rename(dbPath, backupPath);
      console.error(`Booking state file was corrupted. Moved it to ${backupPath}`);
    } catch (renameError) {
      console.error('Booking state file was corrupted and could not be moved', renameError);
    }
    console.error('Booking state read failed:', error);
    return writeBookingState(seedBookingState());
  }
}

async function writeBookingState(state) {
  const cleanState = normalizeBookingState(state);
  await fs.mkdir(config.dataDir, { recursive: true });
  const tempPath = `${dbPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(cleanState, null, 2), 'utf8');
  await fs.rename(tempPath, dbPath);
  return cleanState;
}

function injectBookingState(html, state) {
  const payload = JSON.stringify(state).replace(/</g, '\\u003c');
  const botPayload = JSON.stringify(config.telegramBotUsername).replace(/</g, '\\u003c');
  return html.replace(
    '</head>',
    `<script>window.__SERVER_STATE__=${payload};window.__TELEGRAM_BOT_USERNAME__=${botPayload};</script>\n</head>`
  );
}

function absoluteAssetUrl(request, source) {
  if (!source) return '';
  if (/^https?:\/\//i.test(source)) return source;
  const protocol = String(request.get('x-forwarded-proto') || request.protocol || 'https')
    .split(',')[0]
    .trim();
  const host = request.get('x-forwarded-host') || request.get('host');
  if (!host) return '';
  const cleanPath = source.startsWith('/') ? source : `/${source}`;
  return new URL(cleanPath, `${protocol}://${host}`).toString();
}

async function registerTelegramChat(code, chatId) {
  if (!code || !chatId) return false;
  const state = await readBookingState();
  let registered = false;
  state.applications = state.applications.map(application => {
    if (application.telegramCode !== code) return application;
    registered = true;
    return { ...application, telegramChatId: String(chatId) };
  });
  if (registered) await writeBookingState(state);
  return registered;
}

async function telegramApi(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.description || 'telegram_error');
  }
  return data;
}

async function pollTelegram() {
  try {
    const data = await telegramApi('getUpdates', {
      offset: telegramOffset,
      timeout: 0,
      allowed_updates: ['message']
    });

    for (const update of data.result || []) {
      telegramOffset = Math.max(telegramOffset, update.update_id + 1);
      const text = update.message?.text || '';
      const chatId = update.message?.chat?.id;
      const match = text.match(/^\/start\s+([A-Za-z0-9_-]+)/);
      if (!match || !chatId) continue;

      const registered = await registerTelegramChat(match[1], chatId);
      await sendTelegramMessage({
        botToken: config.botToken,
        chatId,
        text: registered
          ? 'Telegram подключен. Теперь сюда будут приходить уведомления по стажировке.'
          : 'Не нашел вашу заявку. Сначала заполните данные и выберите дату в форме записи.'
      });
    }
  } catch (error) {
    console.error('Telegram polling failed:', error);
  }
}

assertConfig();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://telegram.org'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    }
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_request, response) => {
  response.type('text').send('ok\n');
});

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, service: 'loft-hall-internship-unified' });
});

app.get('/api/state', async (_request, response, next) => {
  try {
    response.json(await readBookingState());
  } catch (error) {
    next(error);
  }
});

app.post('/api/state', async (request, response, next) => {
  try {
    response.json(await writeBookingState(request.body));
  } catch (error) {
    next(error);
  }
});

app.post('/api/notify', async (request, response, next) => {
  try {
    const { applicationId, text, photo, photoCaption } = request.body || {};
    const state = await readBookingState();
    const application = state.applications.find(item => String(item.id) === String(applicationId));

    if (!application?.telegramChatId) {
      response.json({ ok: false, skipped: 'telegram_chat_missing' });
      return;
    }

    const photoUrl = absoluteAssetUrl(request, photo);
    if (photoUrl) {
      await sendTelegramPhoto({
        botToken: config.botToken,
        chatId: application.telegramChatId,
        photo: photoUrl,
        caption: photoCaption || '',
        parseMode: 'HTML'
      });
    }
    if (text) {
      await sendTelegramMessage({
        botToken: config.botToken,
        chatId: application.telegramChatId,
        text,
        parseMode: 'HTML',
        disableWebPagePreview: true
      });
    }

    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/telegram/link', async (request, response, next) => {
  try {
    const { applicationId, initData } = request.body || {};
    if (!initData) {
      response.status(400).json({ ok: false, error: 'telegram_init_data_missing' });
      return;
    }

    let telegram = null;
    try {
      telegram = validateRequestInitData(initData);
    } catch (error) {
      if (error instanceof TelegramAuthError) {
        response.status(400).json({
          ok: false,
          error: 'telegram_auth_failed',
          code: error.code
        });
        return;
      }
      throw error;
    }

    const state = await readBookingState();
    let linkedApplication = null;
    state.applications = state.applications.map(application => {
      if (String(application.id) !== String(applicationId)) return application;
      linkedApplication = {
        ...application,
        telegramChatId: String(telegram.user.id),
        telegramUserId: String(telegram.user.id),
        telegramUsername: telegram.user.username || ''
      };
      return linkedApplication;
    });

    if (!linkedApplication) {
      response.status(404).json({ ok: false, error: 'application_not_found' });
      return;
    }

    await writeBookingState(state);
    response.json({ ok: true, application: linkedApplication });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/telegram', (request, response) => {
  try {
    const telegram = validateRequestInitData(request.body?.initData);
    response.json({
      ok: true,
      user: serializeTelegramUser(telegram.user)
    });
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      response.status(401).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    console.error('Telegram auth error:', error);
    response.status(500).json({ ok: false, error: 'Ошибка проверки запуска приложения.' });
  }
});

app.post('/api/debug/telegram-user', (request, response) => {
  try {
    const telegram = validateRequestInitData(request.body?.initData);
    response.json({
      ok: true,
      authDate: telegram.authDate,
      queryId: telegram.queryId,
      user: serializeTelegramUser(telegram.user),
      rawUser: telegram.user
    });
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      response.status(401).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    console.error('Telegram debug auth error:', error);
    response.status(500).json({ ok: false, error: 'Ошибка проверки запуска приложения.' });
  }
});

app.post('/api/report', async (request, response) => {
  try {
    const telegram = validateRequestInitData(request.body?.initData);
    const role = normalizeRole(request.body?.role);
    const reportText = normalizeReportText(request.body?.reportText);
    const chatId = resolveChatId(role, config);

    const message = await sendTelegramMessage({
      botToken: config.botToken,
      chatId,
      text: reportText
    });

    console.info(
      JSON.stringify({
        event: 'internship_report_sent',
        telegramUserId: telegram.user.id,
        role,
        chatTarget: role === 'mentor' ? 'MENTOR_CHAT_ID' : 'TRAINEE_CHAT_ID',
        telegramMessageId: message.message_id,
        timestamp: new Date().toISOString()
      })
    );

    response.json({ ok: true, messageId: message.message_id });
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      response.status(401).json({ ok: false, error: error.message, code: error.code });
      return;
    }

    const knownClientError = [
      'Неизвестная роль отчёта.',
      'Текст отчёта пуст.',
      'Отчёт превышает допустимый размер Telegram.'
    ].includes(error?.message);

    if (knownClientError) {
      response.status(400).json({ ok: false, error: error.message });
      return;
    }

    console.error('Report delivery error:', error);
    response.status(502).json({
      ok: false,
      error: 'Не удалось отправить отчёт в Telegram. Повторите попытку.'
    });
  }
});

app.get(['/booking', '/booking/', '/booking.html'], async (_request, response, next) => {
  try {
    const [html, state] = await Promise.all([
      fs.readFile(path.join(publicDir, 'booking.html'), 'utf8'),
      readBookingState()
    ]);
    response.setHeader('Cache-Control', 'no-store');
    response.type('html').send(injectBookingState(html, state));
  } catch (error) {
    next(error);
  }
});

app.get(['/puzzlebot-vars-test', '/puzzlebot-vars-test/'], (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(publicDir, 'puzzlebot-vars-test.html'));
});

app.use(
  express.static(publicDir, {
    index: 'index.html',
    setHeaders(response, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('booking.html')) {
        response.setHeader('Cache-Control', 'no-store');
      }
    }
  })
);

app.get(/.*/, (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _request, response, _next) => {
  console.error('Unhandled server error:', error);
  response.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера.' });
});

await ensureDb();

const server = app.listen(config.port, config.host, error => {
  if (error) {
    console.error('Failed to start HTTP server:', error);
    process.exit(1);
  }
  if (config.telegramPollingEnabled) {
    pollTelegram();
    setInterval(pollTelegram, 5000);
  }
  console.log(`LOFT HALL unified internship Mini App is listening on ${config.host}:${config.port}`);
});

server.on('error', error => {
  console.error('HTTP server error:', error);
});
