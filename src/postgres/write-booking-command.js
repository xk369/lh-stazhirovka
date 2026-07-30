import { createHash, randomUUID } from 'node:crypto';
import {
  BOOKING_STATUSES,
  BOOKING_STEP_BACK_STATUSES,
  BOOKING_STATUS_LABELS,
  SEAT_HOLDING_STATUSES,
  SHIFT_CANCELLATION_APPLICATION_STATUSES,
  canRecruiterSetApplicationStatus
} from '../booking-state-machine.js';
import { runInPostgresTransaction } from './transaction.js';
import { insertApplicationEvents } from './write-application-events.js';

export class PostgresCommandValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PostgresCommandValidationError';
    this.code = 'POSTGRES_COMMAND_VALIDATION_FAILED';
    this.status = 400;
  }
}

export class PostgresCommandAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PostgresCommandAuthorizationError';
    this.code = 'POSTGRES_COMMAND_FORBIDDEN';
    this.status = 403;
  }
}

export class PostgresCommandConflictError extends Error {
  constructor(message = 'Данные записи обновились. Обновите экран и повторите действие.') {
    super(message);
    this.name = 'PostgresCommandConflictError';
    this.code = 'POSTGRES_COMMAND_VERSION_CONFLICT';
    this.status = 409;
  }
}

const SEAT_HOLDING_STATUS_VALUES = Object.freeze([...SEAT_HOLDING_STATUSES]);
const RETURN_TO_QUEUE_STATUSES = new Set(['queue', 'pending', 'confirmed', 'invited']);

function requireRecruiter(actor) {
  if (!actor || actor.role !== 'recruiter') {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для кабинета рекрута.');
  }
}

function actorTelegramUserId(actor) {
  return String(actor?.telegram?.user?.id || actor?.userId || '').trim() || null;
}

function normalizeBaseVersion(command) {
  const baseVersion = Number(command?.baseVersion);
  if (!Number.isSafeInteger(baseVersion) || baseVersion <= 0) {
    throw new PostgresCommandValidationError('baseVersion is required.');
  }
  return baseVersion;
}

function normalizeSeats(value) {
  const seats = Number(value);
  if (!Number.isInteger(seats) || seats < 1 || seats > 30) {
    throw new PostgresCommandValidationError('shift.seats must be an integer between 1 and 30.');
  }
  return seats;
}

function normalizeOptionalText(value, field, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length > maxLength) {
    throw new PostgresCommandValidationError(`${field} must be at most ${maxLength} characters.`);
  }
  return text;
}

function normalizeIsoDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PostgresCommandValidationError('shift.date must be YYYY-MM-DD.');
  }
  return date;
}

function normalizeShiftLegacyId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PostgresCommandValidationError('shiftId must be a positive integer.');
  }
  return id;
}

function normalizeApplicationLegacyId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PostgresCommandValidationError('applicationId must be a positive integer.');
  }
  return id;
}

const RECRUITER_BACK_TO_PENDING_SOURCES = new Set(['confirmed', 'invited', 'feedback']);
const SET_STATUS_TRANSITION_EVENTS = Object.freeze({
  'pending→confirmed': 'recruiter_confirmed',
  'invited→feedback': 'attendance_marked_feedback',
  'invited→noshow': 'attendance_marked_noshow'
});
const VENUE_LABELS = Object.freeze({
  loft1: 'LOFT #1',
  loft2: 'LOFT #2',
  loft3: 'LOFT #3',
  loft4: 'LOFT #4',
  loft5_contrabanda: 'LOFT #5 CONTRABANDA',
  loft5_small: 'LOFT #5 SMALL',
  loft8: 'LOFT #8',
  loft10: 'LOFT #10 (TAU)',
  birch: 'THE BIRCH',
  metelitsa: 'МЕТЕЛИЦА'
});

function statusLabel(status) {
  return BOOKING_STATUS_LABELS[status] || status;
}

function applicationRowHasInviteGroup(row) {
  return Boolean(row.invite_group_id) || Boolean(String(row.group_link || '').trim());
}

function applicationRowCompletesShift(row) {
  const status = String(row.status || '');
  if (status === 'noshow') return true;
  if (status === 'passed' || status === 'failed') return Boolean(row.mentor_report_received);
  return false;
}

function todayDateValueInMoscow(now) {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function nextLegacyId(now, maxLegacyId) {
  const base = Number(maxLegacyId) || 0;
  return Math.max(now.getTime(), base + 1);
}

async function lockBookingStateMeta(client) {
  const metaResult = await client.query(
    'SELECT version, updated_at FROM booking_state_meta WHERE singleton = true FOR UPDATE'
  );
  if (metaResult.rowCount !== 1) {
    throw new PostgresCommandValidationError('booking_state_meta must contain exactly one row.');
  }
  return {
    version: Number(metaResult.rows[0].version),
    updatedAt: metaResult.rows[0].updated_at
  };
}

function normalizeCreateShiftInput(command) {
  return {
    date: normalizeIsoDate(command?.date),
    seats: normalizeSeats(command?.seats),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeAssignShiftInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeVenueId(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw new PostgresCommandValidationError('inviteGroup.venueId is required.');
  }
  if (text.length > 80) {
    throw new PostgresCommandValidationError('inviteGroup.venueId must be at most 80 characters.');
  }
  return text;
}

function isTelegramGroupHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return /(^|\.)t\.me$/i.test(host) || /(^|\.)telegram\.me$/i.test(host);
}

function normalizeInviteGroupLink(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw new PostgresCommandValidationError('inviteGroup.link is required.');
  }
  if (text.length > 500) {
    throw new PostgresCommandValidationError('inviteGroup.link must be at most 500 characters.');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new PostgresCommandValidationError(
      'Проверьте ссылку на рабочую группу. Нужна Telegram-ссылка, например https://t.me/+...'
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !isTelegramGroupHost(parsed.hostname)) {
    throw new PostgresCommandValidationError(
      'Проверьте ссылку на рабочую группу. Нужна Telegram-ссылка, например https://t.me/+...'
    );
  }
  return text;
}

function normalizeMemberIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PostgresCommandValidationError('inviteGroup.memberIds is required.');
  }
  const seen = new Set();
  const legacyIds = [];
  for (const rawId of value) {
    const legacyId = Number(rawId);
    if (!Number.isSafeInteger(legacyId) || legacyId <= 0) {
      throw new PostgresCommandValidationError(
        'inviteGroup.memberIds must contain positive integers.'
      );
    }
    if (seen.has(legacyId)) continue;
    seen.add(legacyId);
    legacyIds.push(legacyId);
  }
  legacyIds.sort((left, right) => left - right);
  return legacyIds;
}

function normalizeSendInvitesInput(command) {
  return {
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    venueId: normalizeVenueId(command?.venueId),
    link: normalizeInviteGroupLink(command?.link),
    memberLegacyIds: normalizeMemberIds(command?.memberIds),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeCancelInternshipInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeReturnToQueueInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeCancelShiftInput(command) {
  return {
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeStepBackApplicationInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeMarkExperiencedInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeUpdateShiftCapacityInput(command) {
  return {
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    seats: normalizeSeats(command?.seats),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeUpdateCommentInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    comment: normalizeOptionalText(command?.comment, 'application.comment', 1200),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeSetApplicationStatusInput(command) {
  const nextStatus = String(command?.status || '').trim();
  if (!BOOKING_STATUSES.has(nextStatus)) {
    throw new PostgresCommandValidationError('application.status is invalid.');
  }
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    nextStatus,
    baseVersion: normalizeBaseVersion(command)
  };
}

function shiftDateAsString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function shiftUpdatedAtAsString(value) {
  if (!value) return '';
  if (typeof value === 'string') return new Date(value).toISOString();
  return value.toISOString();
}

function escapeTelegramHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function displayVenueLabel(venueId) {
  return VENUE_LABELS[venueId] || String(venueId || '').trim() || 'площадка LOFT HALL';
}

function displayShiftDate(value) {
  const date = shiftDateAsString(value);
  if (!date) return 'выбранную дату';
  return new Date(`${date}T12:00:00`).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
}

function composeSendInviteNotificationText({ venueId, link, shiftDate }) {
  const venueLabel = displayVenueLabel(venueId);
  return [
    '<b>🎉 Ваша заявка на стажировку одобрена!</b>',
    '',
    `Вы записаны на стажировку на <b>${escapeTelegramHtml(displayShiftDate(shiftDate))}</b>.`,
    `Площадка: <b>${escapeTelegramHtml(venueLabel)}</b>.`,
    '',
    'Пожалуйста, перейдите по ссылке ниже и напишите в рабочую группу, что выходите на стажировку.',
    '',
    `<b>${escapeTelegramHtml(link)}</b>`,
    '',
    '<b>До смены необходимо:</b>',
    '',
    '• изучить техническое задание мероприятия;',
    '• ознакомиться с меню;',
    '• повторить этапы обслуживания и изучить историю площадки в боте LOFT HELPER.',
    '',
    'Вся информация о мероприятии появится в рабочей группе не позднее чем за день до смены.',
    '',
    'Во время стажировки за вами будет закреплён опытный наставник, который поможет освоиться и ответит на все вопросы.',
    '',
    '❗️Не забудьте о внешнем виде — вы представляете компанию LOFT HALL.',
    '',
    'Если по какой-либо причине вы не сможете выйти на стажировку, пожалуйста, сообщите об этом заранее, чтобы мы смогли предложить место другому кандидату.',
    '',
    '<b>Условия стажировки:</b>',
    '• время выхода сообщает менеджер;',
    '• продолжительность — <b>6 часов</b>;',
    '• оплата — <b>1000 ₽</b>.',
    '',
    'Желаем успешной стажировки! 🚀',
    '',
    '#стажировка'
  ].join('\n');
}

function composeShiftCancellationNotificationText({ shiftDate }) {
  return [
    '⚠️ <b>Стажировка отменена</b>',
    '',
    `К сожалению, стажировка на <b>${escapeTelegramHtml(displayShiftDate(shiftDate))}</b> не состоится.`,
    '',
    'Ваша заявка возвращена в <b>предварительную запись</b>. Откройте мини-приложение и выберите другую доступную дату.',
    '',
    'Если подходящей даты пока нет, заявка останется в предварительной записи — рекрут сможет назначить новую дату позже.'
  ].join('\n');
}

function composeShiftCapacityChangedNotificationText({ shiftDate }) {
  return [
    'ℹ️ <b>Изменения по стажировке</b>',
    '',
    `В параметры стажировки на <b>${escapeTelegramHtml(displayShiftDate(shiftDate))}</b> были внесены изменения.`,
    '',
    'Ваша запись на эту дату сохраняется. Дополнительных действий не требуется.'
  ].join('\n');
}

function composeBookingStageChangedNotificationText({ currentStatus, previousStatus }) {
  const currentLabel = BOOKING_STATUS_LABELS[currentStatus] || currentStatus;
  const previousLabel = BOOKING_STATUS_LABELS[previousStatus] || previousStatus;
  const nextStepText = currentStatus === 'feedback'
    ? 'Сейчас ожидается новый отчёт наставника по вашей стажировке.'
    : 'Вы снова на этапе приглашения. Следите за сообщениями рекрута и информацией в рабочей группе.';
  return [
    '↩️ <b>Этап стажировки изменён</b>',
    '',
    `Рекрут вернул вашу заявку с этапа «${escapeTelegramHtml(previousLabel)}» на один шаг назад.`,
    '',
    `<b>Текущий статус:</b> ${escapeTelegramHtml(currentLabel)}.`,
    nextStepText,
    '',
    'Актуальный этап всегда можно посмотреть в мини-приложении.'
  ].join('\n');
}

function stableNotificationKey(parts) {
  const digest = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 32);
  return `${parts.action}:${parts.applicationLegacyId}:${digest}`;
}

function sendInviteNotificationRow({
  app,
  memberLegacyIds,
  shiftLegacyId,
  shiftDate,
  groupLegacyId,
  venueId,
  link,
  nowIso
}) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'send_invites',
    applicationLegacyId: Number(app.legacy_id),
    shiftLegacyId,
    inviteGroupLegacyId: groupLegacyId,
    venueId,
    link,
    memberLegacyIds
  });
  const text = composeSendInviteNotificationText({ venueId, link, shiftDate });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    type: 'send_invites',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text,
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function cancelInternshipNotificationRow({
  app,
  previousShiftLegacyId,
  previousShiftDate,
  previousInviteGroupLegacyId,
  nowIso
}) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'cancel_internship',
    applicationLegacyId: Number(app.legacy_id),
    previousShiftLegacyId,
    previousInviteGroupLegacyId: previousInviteGroupLegacyId || null
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    type: 'cancel_internship',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text: composeShiftCancellationNotificationText({ shiftDate: previousShiftDate }),
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function cancelShiftNotificationRow({ app, shiftLegacyId, shiftDate, nowIso }) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'cancel_shift',
    applicationLegacyId: Number(app.legacy_id),
    shiftLegacyId
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    type: 'cancel_shift',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text: composeShiftCancellationNotificationText({ shiftDate }),
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function shiftCapacityChangedNotificationRow({
  app,
  shiftLegacyId,
  shiftDate,
  previousSeats,
  nextSeats,
  nowIso
}) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'update_shift_capacity',
    applicationLegacyId: Number(app.legacy_id),
    shiftLegacyId,
    previousSeats,
    nextSeats
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    type: 'shift_capacity_changed',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text: composeShiftCapacityChangedNotificationText({ shiftDate }),
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function stepBackNotificationRow({ app, previousStatus, nextStatus, nowIso }) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'step_back_application',
    applicationLegacyId: Number(app.legacy_id),
    previousStatus,
    nextStatus
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    type: 'booking_stage_changed',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text: composeBookingStageChangedNotificationText({
      currentStatus: nextStatus,
      previousStatus
    }),
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

async function insertNotifications(client, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0 };
  let inserted = 0;
  for (const row of rows) {
    const result = await client.query(
      `
        INSERT INTO notifications (
          id, application_id, type, chat_id, chat_target, text, parse_mode,
          status, error, idempotency_key, next_attempt_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        row.id,
        row.applicationId,
        row.type,
        row.chatId,
        row.chatTarget,
        row.text,
        row.parseMode,
        row.status,
        row.error,
        row.idempotencyKey,
        row.nextAttemptAt,
        row.createdAt,
        row.updatedAt
      ]
    );
    inserted += result.rowCount || 0;
  }
  return { inserted };
}

export async function createShiftInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { date, seats, baseVersion } = normalizeCreateShiftInput(command);
  if (date < todayDateValueInMoscow(now)) {
    throw new PostgresCommandValidationError('Нельзя создать дату стажировки в прошлом.');
  }

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const duplicate = await client.query(
      'SELECT 1 FROM shifts WHERE date = $1::date',
      [date]
    );
    if (duplicate.rowCount > 0) {
      throw new PostgresCommandValidationError('Такая дата стажировки уже создана.');
    }

    const maxLegacyResult = await client.query(
      'SELECT COALESCE(MAX(legacy_id), 0) AS max_legacy_id FROM shifts'
    );
    const legacyId = nextLegacyId(now, maxLegacyResult.rows[0]?.max_legacy_id);
    const shiftId = randomUUID();
    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, $3::date, $4, true, false, NULL, $5, $5)
      `,
      [shiftId, legacyId, date, seats, nowIso]
    );

    await insertApplicationEvents(client, [{
      eventType: 'shift_created',
      applicationId: null,
      shiftId: legacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'create_shift',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        date,
        seats
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      legacyId,
      shiftId,
      date,
      seats,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso
    };
  });
}

export async function stepBackApplicationInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, baseVersion } = normalizeStepBackApplicationInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.name
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousStatus = String(app.status || '');
    const nextStatus = BOOKING_STEP_BACK_STATUSES[previousStatus];
    if (!nextStatus) {
      throw new PostgresCommandValidationError(
        'Кандидата нельзя вернуть на предыдущий этап из текущего статуса.'
      );
    }

    const shouldResetMentorReport = previousStatus === 'passed' || previousStatus === 'failed';
    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    if (shouldResetMentorReport) {
      await client.query(
        `UPDATE mentor_reports
            SET voided_at = $1
          WHERE application_id = $2
            AND voided_at IS NULL`,
        [nowIso, app.id]
      );
      await client.query(
        `UPDATE applications
            SET status = $1,
                mentor_report_received = false,
                mentor_report_at = NULL,
                mentor_reporter_telegram_user_id = NULL,
                mentor_decision = '',
                mentor_report_venue_id = '',
                mentor_report_venue = '',
                mentor_report_loft = '',
                mentor_report_hall = '',
                mentor_comment_for_trainee = '',
                mentor_comment_sent_at = NULL,
                mentor_comment_delivery_status = NULL,
                mentor_comment_delivery_error = '',
                experience = NULL,
                updated_at = $2,
                row_version = row_version + 1
          WHERE id = $3`,
        [nextStatus, nowIso, app.id]
      );
    } else {
      await client.query(
        `UPDATE applications
            SET status = $1,
                updated_at = $2,
                row_version = row_version + 1
          WHERE id = $3`,
        [nextStatus, nowIso, app.id]
      );
    }

    const shiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;
    await insertApplicationEvents(client, [{
      eventType: 'application_step_back',
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'step_back_application',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousStatus,
        nextStatus,
        previousShiftId: shiftLegacyId,
        nextShiftId: shiftLegacyId,
        mentorReportVoided: shouldResetMentorReport
      },
      createdAt: nowIso
    }]);

    const notificationRows = [stepBackNotificationRow({
      app,
      previousStatus,
      nextStatus,
      nowIso
    })];
    const notificationResult = await insertNotifications(client, notificationRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      nextStatus,
      shiftLegacyId,
      mentorReportVoided: shouldResetMentorReport,
      notifications: {
        total: notificationRows.length,
        pending: notificationRows.filter(row => row.status === 'pending').length,
        skipped: notificationRows.filter(row => row.status === 'skipped').length,
        inserted: notificationResult.inserted
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function markExperiencedInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, baseVersion } = normalizeMarkExperiencedInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              applications.experience
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    if (String(app.status || '') !== 'passed') {
      throw new PostgresCommandValidationError(
        'Опытным стажёром можно отметить только того, кто прошёл стажировку.'
      );
    }

    const previousExperience = app.experience || null;
    if (previousExperience === 'experienced') {
      return {
        applicationLegacyId,
        applicationId: app.id,
        previousExperience,
        nextExperience: 'experienced',
        shiftLegacyId: app.shift_legacy_id ? Number(app.shift_legacy_id) : null,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const shiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;

    await client.query(
      `UPDATE applications
          SET experience = 'experienced',
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, app.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'experienced_marked',
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'mark_experienced',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousExperience,
        nextExperience: 'experienced'
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousExperience,
      nextExperience: 'experienced',
      shiftLegacyId,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function cancelShiftInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { shiftLegacyId, baseVersion } = normalizeCancelShiftInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const shiftResult = await client.query(
      `SELECT id, legacy_id, date::text AS date, open, canceled, canceled_at
         FROM shifts
        WHERE legacy_id = $1
        FOR UPDATE`,
      [shiftLegacyId]
    );
    if (shiftResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('shift not found.');
    }
    const shift = shiftResult.rows[0];
    const shiftDateText = shiftDateAsString(shift.date);

    const affectedResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              applications.invite_group_id,
              invite_groups.legacy_id AS invite_group_legacy_id,
              applications.venue_id,
              applications.group_link,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.name
         FROM applications
         LEFT JOIN invite_groups ON invite_groups.id = applications.invite_group_id
        WHERE applications.shift_id = $1
          AND applications.status = ANY($2::text[])
        ORDER BY applications.legacy_id
        FOR UPDATE OF applications`,
      [shift.id, [...SHIFT_CANCELLATION_APPLICATION_STATUSES]]
    );
    const affectedRows = affectedResult.rows;
    const affectedUuids = affectedRows.map(row => row.id);
    const affectedLegacyIds = affectedRows
      .map(row => Number(row.legacy_id))
      .filter(value => Number.isSafeInteger(value) && value > 0);
    const affectedLegacyIdSet = new Set(affectedLegacyIds);

    const inviteGroupUuids = [
      ...new Set(
        affectedRows
          .map(row => row.invite_group_id)
          .filter(Boolean)
          .map(String)
      )
    ];
    const inviteGroupRows = [];
    if (inviteGroupUuids.length > 0) {
      const groupResult = await client.query(
        `SELECT id, legacy_id, shift_id, venue_id, link
           FROM invite_groups
          WHERE id = ANY($1::uuid[])
          ORDER BY legacy_id
          FOR UPDATE`,
        [inviteGroupUuids]
      );
      inviteGroupRows.push(...groupResult.rows);
    }

    const membersByGroupUuid = new Map();
    if (inviteGroupRows.length > 0) {
      const membersResult = await client.query(
        `SELECT invite_group_members.invite_group_id,
                applications.id AS application_id,
                applications.legacy_id
           FROM invite_group_members
           JOIN applications ON applications.id = invite_group_members.application_id
          WHERE invite_group_members.invite_group_id = ANY($1::uuid[])
          ORDER BY invite_group_members.invite_group_id, applications.legacy_id`,
        [inviteGroupRows.map(row => row.id)]
      );
      for (const row of membersResult.rows) {
        const groupUuid = String(row.invite_group_id);
        if (!membersByGroupUuid.has(groupUuid)) membersByGroupUuid.set(groupUuid, []);
        membersByGroupUuid.get(groupUuid).push({
          applicationId: row.application_id,
          legacyId: Number(row.legacy_id)
        });
      }
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    await client.query(
      `UPDATE shifts
          SET open = false,
              canceled = true,
              canceled_at = $1,
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, shift.id]
    );

    if (affectedUuids.length > 0) {
      await client.query(
        `UPDATE applications
            SET shift_id = NULL,
                invite_group_id = NULL,
                status = 'queue',
                venue_id = NULL,
                group_link = '',
                candidate_report = false,
                mentor_report_received = false,
                mentor_report_at = NULL,
                mentor_reporter_telegram_user_id = NULL,
                mentor_decision = '',
                mentor_report_venue_id = '',
                mentor_report_venue = '',
                mentor_report_loft = '',
                mentor_report_hall = '',
                mentor_comment_for_trainee = '',
                mentor_comment_sent_at = NULL,
                mentor_comment_delivery_status = NULL,
                mentor_comment_delivery_error = '',
                updated_at = $1,
                row_version = row_version + 1
          WHERE id = ANY($2::uuid[])`,
        [nowIso, affectedUuids]
      );

      await client.query(
        'DELETE FROM invite_group_members WHERE application_id = ANY($1::uuid[])',
        [affectedUuids]
      );
    }

    const inviteGroupChanges = [];
    for (const group of inviteGroupRows) {
      const previousMembers = membersByGroupUuid.get(String(group.id)) || [];
      const previousMemberLegacyIds = previousMembers
        .map(member => member.legacyId)
        .filter(value => Number.isSafeInteger(value) && value > 0);
      const removedMemberLegacyIds = previousMemberLegacyIds
        .filter(legacyId => affectedLegacyIdSet.has(legacyId));
      if (removedMemberLegacyIds.length === 0) continue;
      const remainingMemberLegacyIds = previousMemberLegacyIds
        .filter(legacyId => !affectedLegacyIdSet.has(legacyId));

      if (remainingMemberLegacyIds.length === 0) {
        await client.query(
          'DELETE FROM invite_groups WHERE id = $1',
          [group.id]
        );
      } else {
        await client.query(
          `UPDATE invite_groups
              SET updated_at = $1,
                  row_version = row_version + 1
            WHERE id = $2`,
          [nowIso, group.id]
        );
      }

      inviteGroupChanges.push({
        inviteGroupId: Number(group.legacy_id),
        inviteGroupUuid: group.id,
        venueId: group.venue_id || '',
        removedMemberLegacyIds,
        remainingMemberLegacyIds,
        removed: remainingMemberLegacyIds.length === 0
      });
    }

    const events = [{
      eventType: 'shift_cancelled',
      applicationId: null,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'cancel_shift',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        date: shiftDateText,
        affectedApplicationIds: affectedLegacyIds
      },
      createdAt: nowIso
    }];
    for (const change of inviteGroupChanges) {
      events.push({
        eventType: change.removed ? 'invite_group_removed' : 'invite_group_updated',
        applicationId: null,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'cancel_shift',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          inviteGroupId: change.inviteGroupId,
          venueId: change.venueId,
          removedMemberIds: change.removedMemberLegacyIds,
          memberIds: change.remainingMemberLegacyIds
        },
        createdAt: nowIso
      });
    }
    for (const app of affectedRows) {
      events.push({
        eventType: 'internship_cancelled',
        applicationId: Number(app.legacy_id),
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'cancel_shift',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          previousStatus: String(app.status || ''),
          nextStatus: 'queue',
          previousShiftId: shiftLegacyId,
          nextShiftId: null,
          previousInviteGroupId: app.invite_group_legacy_id
            ? Number(app.invite_group_legacy_id)
            : null,
          previousVenueId: app.venue_id || null,
          previousGroupLink: app.group_link || ''
        },
        createdAt: nowIso
      });
    }
    await insertApplicationEvents(client, events);

    const notificationRows = affectedRows.map(app => cancelShiftNotificationRow({
      app,
      shiftLegacyId,
      shiftDate: shiftDateText,
      nowIso
    }));
    const notificationResult = await insertNotifications(client, notificationRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      shiftLegacyId,
      shiftId: shift.id,
      shiftDate: shiftDateText,
      affectedApplicationLegacyIds: affectedLegacyIds,
      inviteGroupChanges,
      notifications: {
        total: notificationRows.length,
        pending: notificationRows.filter(row => row.status === 'pending').length,
        skipped: notificationRows.filter(row => row.status === 'skipped').length,
        inserted: notificationResult.inserted
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function updateShiftCapacityInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { shiftLegacyId, seats, baseVersion } = normalizeUpdateShiftCapacityInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const shiftResult = await client.query(
      `SELECT id, legacy_id, seats, date::text AS date
         FROM shifts
        WHERE legacy_id = $1
        FOR UPDATE`,
      [shiftLegacyId]
    );
    if (shiftResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('shift not found.');
    }
    const shift = shiftResult.rows[0];
    const currentSeats = Number(shift.seats);
    const date = shiftDateAsString(shift.date);

    if (seats === currentSeats) {
      return {
        legacyId: shiftLegacyId,
        shiftId: shift.id,
        date,
        seats: currentSeats,
        previousSeats: currentSeats,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const usageResult = await client.query(
      `SELECT COUNT(*)::int AS used
         FROM applications
        WHERE shift_id = $1
          AND status = ANY($2::text[])`,
      [shift.id, SEAT_HOLDING_STATUS_VALUES]
    );
    const usedSeats = Number(usageResult.rows[0]?.used || 0);
    if (seats < usedSeats) {
      throw new PostgresCommandValidationError(
        `Нельзя уменьшить количество мест до ${seats}: на эту дату уже записано ${usedSeats} стажёров.`
      );
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    await client.query(
      `UPDATE shifts
          SET seats = $1,
              updated_at = $2,
              row_version = row_version + 1
        WHERE id = $3`,
      [seats, nowIso, shift.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'shift_capacity_changed',
      applicationId: null,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'update_shift_capacity',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousSeats: currentSeats,
        nextSeats: seats,
        date
      },
      createdAt: nowIso
    }]);

    const affectedResult = await client.query(
      `SELECT id,
              legacy_id,
              status,
              trainee_telegram_user_id,
              trainee_telegram_chat_id,
              telegram_username,
              name
         FROM applications
        WHERE shift_id = $1
          AND status = ANY($2::text[])
        ORDER BY legacy_id`,
      [shift.id, [...SHIFT_CANCELLATION_APPLICATION_STATUSES]]
    );
    const notificationRows = affectedResult.rows.map(app => shiftCapacityChangedNotificationRow({
      app,
      shiftLegacyId,
      shiftDate: date,
      previousSeats: currentSeats,
      nextSeats: seats,
      nowIso
    }));
    const notificationResult = await insertNotifications(client, notificationRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      legacyId: shiftLegacyId,
      shiftId: shift.id,
      date,
      seats,
      previousSeats: currentSeats,
      notifications: {
        total: notificationRows.length,
        pending: notificationRows.filter(row => row.status === 'pending').length,
        skipped: notificationRows.filter(row => row.status === 'skipped').length,
        inserted: notificationResult.inserted
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function updateCommentInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, comment, baseVersion } = normalizeUpdateCommentInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              applications.recruiter_comment
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousComment = String(app.recruiter_comment || '');
    if (previousComment === comment) {
      return {
        applicationLegacyId,
        applicationId: app.id,
        shiftLegacyId: app.shift_legacy_id ? Number(app.shift_legacy_id) : null,
        previousComment,
        nextComment: comment,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const shiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;

    await client.query(
      `UPDATE applications
          SET recruiter_comment = $1,
              updated_at = $2,
              row_version = row_version + 1
        WHERE id = $3`,
      [comment, nowIso, app.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'application_comment_updated',
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'update_comment',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousLength: previousComment.length,
        nextLength: comment.length
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      shiftLegacyId,
      previousComment,
      nextComment: comment,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function setApplicationStatusInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, nextStatus, baseVersion } = normalizeSetApplicationStatusInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT id, legacy_id, status, shift_id, invite_group_id, group_link, experience
         FROM applications
        WHERE legacy_id = $1
        FOR UPDATE`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousStatus = String(app.status);

    if (!canRecruiterSetApplicationStatus(previousStatus, nextStatus)) {
      throw new PostgresCommandValidationError(
        `Переход заявки из статуса «${statusLabel(previousStatus)}» `
        + `в «${statusLabel(nextStatus)}» недоступен.`
      );
    }
    if (nextStatus === 'pending' && RECRUITER_BACK_TO_PENDING_SOURCES.has(previousStatus)) {
      throw new PostgresCommandValidationError(
        'Возврат заявки в «Заявка отправлена» требует отдельной команды и в Postgres write path пока не поддерживается.'
      );
    }
    if (nextStatus === 'confirmed' && !app.shift_id) {
      throw new PostgresCommandValidationError('confirmed application must have shiftId.');
    }
    if (
      (nextStatus === 'invited' || nextStatus === 'feedback' || nextStatus === 'noshow')
      && !applicationRowHasInviteGroup(app)
    ) {
      throw new PostgresCommandValidationError(
        'Сначала отправьте кандидату приглашение в рабочую группу.'
      );
    }

    const eventType = SET_STATUS_TRANSITION_EVENTS[`${previousStatus}→${nextStatus}`];
    if (!eventType) {
      throw new PostgresCommandValidationError(
        `Переход ${previousStatus} → ${nextStatus} не реализован в Postgres write path.`
      );
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const nextExperience = nextStatus === 'passed' ? app.experience : null;

    await client.query(
      `UPDATE applications
          SET status = $1,
              experience = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE id = $4`,
      [nextStatus, nextExperience, nowIso, app.id]
    );

    let shiftLegacyId = null;
    let shiftAutoClosed = false;
    let shiftDateText = '';
    if (app.shift_id) {
      const shiftResult = await client.query(
        `SELECT id, legacy_id, open, canceled, date::text AS date
           FROM shifts
          WHERE id = $1
          FOR UPDATE`,
        [app.shift_id]
      );
      if (shiftResult.rowCount === 1) {
        const shiftRow = shiftResult.rows[0];
        shiftLegacyId = Number(shiftRow.legacy_id);
        shiftDateText = shiftDateAsString(shiftRow.date);
        if (!shiftRow.canceled && shiftRow.open) {
          const cohort = await client.query(
            `SELECT status, mentor_report_received
               FROM applications
              WHERE shift_id = $1`,
            [app.shift_id]
          );
          const rows = cohort.rows;
          const allFinal = rows.length > 0 && rows.every(applicationRowCompletesShift);
          if (allFinal) {
            await client.query(
              `UPDATE shifts
                  SET open = false,
                      updated_at = $1,
                      row_version = row_version + 1
                WHERE id = $2`,
              [nowIso, app.shift_id]
            );
            shiftAutoClosed = true;
          }
        }
      }
    }

    const events = [{
      eventType,
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'set_application_status',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousStatus,
        nextStatus,
        shiftId: shiftLegacyId
      },
      createdAt: nowIso
    }];
    if (shiftAutoClosed) {
      events.push({
        eventType: 'shift_auto_closed',
        applicationId: null,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'set_application_status',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          date: shiftDateText
        },
        createdAt: nowIso
      });
    }
    await insertApplicationEvents(client, events);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      nextStatus,
      eventType,
      shiftLegacyId,
      shiftAutoClosed,
      shiftDate: shiftDateText,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function assignShiftInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, shiftLegacyId, baseVersion } = normalizeAssignShiftInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT id, legacy_id, status, shift_id
         FROM applications
        WHERE legacy_id = $1
        FOR UPDATE`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousStatus = String(app.status);

    if (previousStatus !== 'queue' || app.shift_id !== null) {
      throw new PostgresCommandValidationError(
        'assign_shift поддерживает только заявки из предварительной записи (status=queue, без даты).'
      );
    }

    const shiftResult = await client.query(
      `SELECT id, legacy_id, seats, open, canceled, date::text AS date
         FROM shifts
        WHERE legacy_id = $1
        FOR UPDATE`,
      [shiftLegacyId]
    );
    if (shiftResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('shift not found.');
    }
    const shift = shiftResult.rows[0];
    if (shift.canceled) {
      throw new PostgresCommandValidationError('Нельзя назначить на отменённую дату.');
    }
    if (!shift.open) {
      throw new PostgresCommandValidationError('Нельзя назначить на закрытую дату.');
    }

    const usageResult = await client.query(
      `SELECT COUNT(*)::int AS used
         FROM applications
        WHERE shift_id = $1
          AND status = ANY($2::text[])`,
      [shift.id, SEAT_HOLDING_STATUS_VALUES]
    );
    const usedSeats = Number(usageResult.rows[0]?.used || 0);
    const seats = Number(shift.seats) || 0;
    if (usedSeats >= seats) {
      throw new PostgresCommandValidationError('На выбранную дату больше нет свободных мест.');
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const nextStatus = 'pending';
    const shiftDateText = shift.date;

    await client.query(
      `UPDATE applications
          SET shift_id = $1,
              status = $2,
              updated_at = $3,
              row_version = row_version + 1
        WHERE id = $4`,
      [shift.id, nextStatus, nowIso, app.id]
    );

    await insertApplicationEvents(client, [
      {
        eventType: 'application_status_changed',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'assign_shift',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          previousStatus,
          nextStatus,
          previousShiftId: null,
          nextShiftId: shiftLegacyId
        },
        createdAt: nowIso
      },
      {
        eventType: 'application_assigned_to_shift',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'assign_shift',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          previousShiftId: null,
          nextShiftId: shiftLegacyId,
          date: shiftDateText
        },
        createdAt: nowIso
      }
    ]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      nextStatus,
      previousShiftId: null,
      shiftLegacyId,
      shiftId: shift.id,
      shiftDate: shiftDateText,
      shiftSeats: seats,
      usedSeatsAfter: usedSeats + 1,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function sendInvitesInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const {
    shiftLegacyId,
    venueId,
    link,
    memberLegacyIds,
    baseVersion
  } = normalizeSendInvitesInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const shiftResult = await client.query(
      `SELECT id, legacy_id, seats, open, canceled, date::text AS date
         FROM shifts
        WHERE legacy_id = $1
        FOR UPDATE`,
      [shiftLegacyId]
    );
    if (shiftResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('shift not found.');
    }
    const shift = shiftResult.rows[0];
    if (shift.canceled) {
      throw new PostgresCommandValidationError('Нельзя отправить приглашение на отменённую дату.');
    }

    const appResult = await client.query(
      `SELECT id, legacy_id, status, shift_id, venue_id, group_link,
              trainee_telegram_user_id, trainee_telegram_chat_id,
              telegram_username, name
         FROM applications
        WHERE legacy_id = ANY($1::bigint[])
        ORDER BY legacy_id
        FOR UPDATE`,
      [memberLegacyIds]
    );
    const rowsByLegacyId = new Map(
      appResult.rows.map(row => [String(row.legacy_id), row])
    );
    const missing = memberLegacyIds.filter(id => !rowsByLegacyId.has(String(id)));
    if (missing.length) {
      throw new PostgresCommandValidationError(
        `application not found: ${missing.join(', ')}.`
      );
    }
    for (const legacyId of memberLegacyIds) {
      const row = rowsByLegacyId.get(String(legacyId));
      if (String(row.shift_id) !== String(shift.id)) {
        throw new PostgresCommandValidationError(
          `application ${legacyId} is not on the selected shift.`
        );
      }
      if (String(row.status) !== 'confirmed') {
        throw new PostgresCommandValidationError(
          `application ${legacyId} is not eligible: expected status 'confirmed', got '${row.status}'.`
        );
      }
    }

    const memberUuids = memberLegacyIds.map(id => rowsByLegacyId.get(String(id)).id);
    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const shiftDateText = shift.date;

    const maxLegacyResult = await client.query(
      'SELECT COALESCE(MAX(legacy_id), 0) AS max_legacy_id FROM invite_groups'
    );
    const groupLegacyId = nextLegacyId(now, maxLegacyResult.rows[0]?.max_legacy_id);
    const groupUuid = randomUUID();

    await client.query(
      `
        INSERT INTO invite_groups (
          id, legacy_id, shift_id, venue_id, link, sent_at,
          created_by_telegram_user_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $6)
      `,
      [
        groupUuid,
        groupLegacyId,
        shift.id,
        venueId,
        link,
        nowIso,
        actorTelegramUserId(actor)
      ]
    );

    for (const appUuid of memberUuids) {
      await client.query(
        `INSERT INTO invite_group_members (invite_group_id, application_id, created_at)
         VALUES ($1, $2, $3)`,
        [groupUuid, appUuid, nowIso]
      );
    }

    await client.query(
      `UPDATE applications
          SET status = 'invited',
              invite_group_id = $1,
              venue_id = $2,
              group_link = $3,
              updated_at = $4,
              row_version = row_version + 1
        WHERE id = ANY($5::uuid[])`,
      [groupUuid, venueId, link, nowIso, memberUuids]
    );

    const causePayload = {
      action: 'send_invites',
      baseVersion,
      previousVersion: meta.version,
      nextVersion
    };
    const events = [
      {
        eventType: 'invite_group_sent',
        applicationId: null,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          ...causePayload,
          inviteGroupId: groupLegacyId,
          venueId,
          memberIds: [...memberLegacyIds],
          date: shiftDateText
        },
        createdAt: nowIso
      },
      ...memberLegacyIds.map(legacyId => ({
        eventType: 'application_invited',
        applicationId: legacyId,
        shiftId: shiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          ...causePayload,
          previousStatus: 'confirmed',
          nextStatus: 'invited',
          inviteGroupId: groupLegacyId,
          venueId,
          shiftId: shiftLegacyId
        },
        createdAt: nowIso
      }))
    ];
    await insertApplicationEvents(client, events);

    const notificationRows = memberLegacyIds.map(legacyId => sendInviteNotificationRow({
      app: rowsByLegacyId.get(String(legacyId)),
      memberLegacyIds,
      shiftLegacyId,
      shiftDate: shiftDateText,
      groupLegacyId,
      venueId,
      link,
      nowIso
    }));
    const notificationResult = await insertNotifications(client, notificationRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      inviteGroupLegacyId: groupLegacyId,
      inviteGroupId: groupUuid,
      shiftLegacyId,
      shiftId: shift.id,
      shiftDate: shiftDateText,
      venueId,
      link,
      memberLegacyIds: [...memberLegacyIds],
      memberIds: memberUuids,
      previousStatus: 'confirmed',
      nextStatus: 'invited',
      notifications: {
        total: notificationRows.length,
        pending: notificationRows.filter(row => row.status === 'pending').length,
        skipped: notificationRows.filter(row => row.status === 'skipped').length,
        inserted: notificationResult.inserted
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function cancelInternshipInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, baseVersion } = normalizeCancelInternshipInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              shifts.date::text AS shift_date,
              applications.invite_group_id,
              invite_groups.legacy_id AS invite_group_legacy_id,
              applications.venue_id,
              applications.group_link,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.name
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
         LEFT JOIN invite_groups ON invite_groups.id = applications.invite_group_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousStatus = String(app.status || '');
    if (!SHIFT_CANCELLATION_APPLICATION_STATUSES.has(previousStatus)) {
      throw new PostgresCommandValidationError(
        'Стажировку можно отменить только до выхода стажёра.'
      );
    }

    let inviteGroup = null;
    let previousMemberLegacyIds = [];
    let remainingMemberLegacyIds = [];
    if (app.invite_group_id) {
      const groupResult = await client.query(
        `SELECT id, legacy_id, shift_id, venue_id, link
           FROM invite_groups
          WHERE id = $1
          FOR UPDATE`,
        [app.invite_group_id]
      );
      inviteGroup = groupResult.rows[0] || null;
      if (inviteGroup) {
        const membersResult = await client.query(
          `SELECT applications.legacy_id
             FROM invite_group_members
             JOIN applications ON applications.id = invite_group_members.application_id
            WHERE invite_group_members.invite_group_id = $1
            ORDER BY applications.legacy_id`,
          [inviteGroup.id]
        );
        previousMemberLegacyIds = membersResult.rows
          .map(row => Number(row.legacy_id))
          .filter(value => Number.isSafeInteger(value) && value > 0);
        remainingMemberLegacyIds = previousMemberLegacyIds
          .filter(legacyId => legacyId !== applicationLegacyId);
      }
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const previousShiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;
    const previousInviteGroupLegacyId = app.invite_group_legacy_id
      ? Number(app.invite_group_legacy_id)
      : null;

    await client.query(
      `UPDATE applications
          SET shift_id = NULL,
              invite_group_id = NULL,
              status = 'queue',
              venue_id = NULL,
              group_link = '',
              candidate_report = false,
              mentor_report_received = false,
              mentor_report_at = NULL,
              mentor_reporter_telegram_user_id = NULL,
              mentor_decision = '',
              mentor_report_venue_id = '',
              mentor_report_venue = '',
              mentor_report_loft = '',
              mentor_report_hall = '',
              mentor_comment_for_trainee = '',
              mentor_comment_sent_at = NULL,
              mentor_comment_delivery_status = NULL,
              mentor_comment_delivery_error = '',
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, app.id]
    );

    let inviteGroupChanged = false;
    let inviteGroupRemoved = false;
    if (inviteGroup && previousMemberLegacyIds.includes(applicationLegacyId)) {
      await client.query(
        `DELETE FROM invite_group_members
          WHERE invite_group_id = $1
            AND application_id = $2`,
        [inviteGroup.id, app.id]
      );
      inviteGroupChanged = true;
      if (remainingMemberLegacyIds.length === 0) {
        await client.query(
          'DELETE FROM invite_groups WHERE id = $1',
          [inviteGroup.id]
        );
        inviteGroupRemoved = true;
      } else {
        await client.query(
          `UPDATE invite_groups
              SET updated_at = $1,
                  row_version = row_version + 1
            WHERE id = $2`,
          [nowIso, inviteGroup.id]
        );
      }
    }

    const events = [];
    if (inviteGroupChanged) {
      events.push({
        eventType: inviteGroupRemoved ? 'invite_group_removed' : 'invite_group_updated',
        applicationId: null,
        shiftId: previousShiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'cancel_internship',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          inviteGroupId: previousInviteGroupLegacyId,
          venueId: app.venue_id || inviteGroup.venue_id || '',
          removedMemberIds: [applicationLegacyId],
          memberIds: remainingMemberLegacyIds
        },
        createdAt: nowIso
      });
    }
    events.push({
      eventType: 'internship_cancelled',
      applicationId: applicationLegacyId,
      shiftId: previousShiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'cancel_internship',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousStatus,
        nextStatus: 'queue',
        previousShiftId: previousShiftLegacyId,
        nextShiftId: null,
        previousInviteGroupId: previousInviteGroupLegacyId,
        previousVenueId: app.venue_id || null,
        previousGroupLink: app.group_link || ''
      },
      createdAt: nowIso
    });
    await insertApplicationEvents(client, events);

    const notificationRows = [cancelInternshipNotificationRow({
      app,
      previousShiftLegacyId,
      previousShiftDate: app.shift_date,
      previousInviteGroupLegacyId,
      nowIso
    })];
    const notificationResult = await insertNotifications(client, notificationRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      nextStatus: 'queue',
      previousShiftId: previousShiftLegacyId,
      previousInviteGroupId: previousInviteGroupLegacyId,
      inviteGroupChanged,
      inviteGroupRemoved,
      remainingMemberLegacyIds,
      notifications: {
        total: notificationRows.length,
        pending: notificationRows.filter(row => row.status === 'pending').length,
        skipped: notificationRows.filter(row => row.status === 'skipped').length,
        inserted: notificationResult.inserted
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function returnToQueueInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, baseVersion } = normalizeReturnToQueueInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              applications.invite_group_id,
              invite_groups.legacy_id AS invite_group_legacy_id,
              applications.venue_id,
              applications.group_link
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
         LEFT JOIN invite_groups ON invite_groups.id = applications.invite_group_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    const previousStatus = String(app.status || '');
    if (!RETURN_TO_QUEUE_STATUSES.has(previousStatus)) {
      throw new PostgresCommandValidationError(
        'В предварительную запись можно вернуть только заявку до выхода на стажировку.'
      );
    }

    let inviteGroup = null;
    let previousMemberLegacyIds = [];
    let remainingMemberLegacyIds = [];
    if (app.invite_group_id) {
      const groupResult = await client.query(
        `SELECT id, legacy_id, shift_id, venue_id, link
           FROM invite_groups
          WHERE id = $1
          FOR UPDATE`,
        [app.invite_group_id]
      );
      inviteGroup = groupResult.rows[0] || null;
      if (inviteGroup) {
        const membersResult = await client.query(
          `SELECT applications.legacy_id
             FROM invite_group_members
             JOIN applications ON applications.id = invite_group_members.application_id
            WHERE invite_group_members.invite_group_id = $1
            ORDER BY applications.legacy_id`,
          [inviteGroup.id]
        );
        previousMemberLegacyIds = membersResult.rows
          .map(row => Number(row.legacy_id))
          .filter(value => Number.isSafeInteger(value) && value > 0);
        remainingMemberLegacyIds = previousMemberLegacyIds
          .filter(legacyId => legacyId !== applicationLegacyId);
      }
    }

    const previousShiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;
    const previousInviteGroupLegacyId = app.invite_group_legacy_id
      ? Number(app.invite_group_legacy_id)
      : null;
    const alreadyQueueClean = previousStatus === 'queue'
      && !app.shift_id
      && !app.invite_group_id
      && !app.venue_id
      && !String(app.group_link || '').trim();
    if (alreadyQueueClean) {
      return {
        applicationLegacyId,
        applicationId: app.id,
        previousStatus,
        nextStatus: 'queue',
        previousShiftId: null,
        previousInviteGroupId: null,
        inviteGroupChanged: false,
        inviteGroupRemoved: false,
        remainingMemberLegacyIds: [],
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    await client.query(
      `UPDATE applications
          SET shift_id = NULL,
              invite_group_id = NULL,
              status = 'queue',
              venue_id = NULL,
              group_link = '',
              candidate_report = false,
              mentor_report_received = false,
              mentor_report_at = NULL,
              mentor_reporter_telegram_user_id = NULL,
              mentor_decision = '',
              mentor_report_venue_id = '',
              mentor_report_venue = '',
              mentor_report_loft = '',
              mentor_report_hall = '',
              mentor_comment_for_trainee = '',
              mentor_comment_sent_at = NULL,
              mentor_comment_delivery_status = NULL,
              mentor_comment_delivery_error = '',
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, app.id]
    );

    let inviteGroupChanged = false;
    let inviteGroupRemoved = false;
    if (inviteGroup && previousMemberLegacyIds.includes(applicationLegacyId)) {
      await client.query(
        `DELETE FROM invite_group_members
          WHERE invite_group_id = $1
            AND application_id = $2`,
        [inviteGroup.id, app.id]
      );
      inviteGroupChanged = true;
      if (remainingMemberLegacyIds.length === 0) {
        await client.query(
          'DELETE FROM invite_groups WHERE id = $1',
          [inviteGroup.id]
        );
        inviteGroupRemoved = true;
      } else {
        await client.query(
          `UPDATE invite_groups
              SET updated_at = $1,
                  row_version = row_version + 1
            WHERE id = $2`,
          [nowIso, inviteGroup.id]
        );
      }
    }

    const events = [];
    if (inviteGroupChanged) {
      events.push({
        eventType: inviteGroupRemoved ? 'invite_group_removed' : 'invite_group_updated',
        applicationId: null,
        shiftId: previousShiftLegacyId,
        actorType: 'recruiter',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'return_to_queue',
          baseVersion,
          previousVersion: meta.version,
          nextVersion,
          inviteGroupId: previousInviteGroupLegacyId,
          venueId: app.venue_id || inviteGroup.venue_id || '',
          removedMemberIds: [applicationLegacyId],
          memberIds: remainingMemberLegacyIds
        },
        createdAt: nowIso
      });
    }
    events.push({
      eventType: 'application_returned_to_queue',
      applicationId: applicationLegacyId,
      shiftId: previousShiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'return_to_queue',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousStatus,
        nextStatus: 'queue',
        previousShiftId: previousShiftLegacyId,
        nextShiftId: null,
        previousInviteGroupId: previousInviteGroupLegacyId,
        previousVenueId: app.venue_id || null,
        previousGroupLink: app.group_link || ''
      },
      createdAt: nowIso
    });
    await insertApplicationEvents(client, events);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      nextStatus: 'queue',
      previousShiftId: previousShiftLegacyId,
      previousInviteGroupId: previousInviteGroupLegacyId,
      inviteGroupChanged,
      inviteGroupRemoved,
      remainingMemberLegacyIds,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}
