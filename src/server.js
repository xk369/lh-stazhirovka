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
  telegramPollingEnabled: process.env.TELEGRAM_POLLING === 'yes',
  recruiterTelegramIds: parseTelegramIdSet(process.env.RECRUITER_TELEGRAM_IDS || '')
};

const dbPath = path.join(config.dataDir, 'db.json');
let telegramOffset = 0;

const BOOKING_STATUSES = new Set([
  'pending',
  'queue',
  'confirmed',
  'invited',
  'feedback',
  'passed',
  'failed',
  'noshow'
]);
const TRAINEE_WRITE_STATUSES = new Set(['pending', 'queue']);
const MENTOR_REPORT_TRAINEE_STATUSES = new Set(['invited', 'feedback']);
const FINAL_BOOKING_STATUSES = new Set(['passed', 'failed', 'noshow']);
const MENTOR_COMMENT_DELIVERY_STATUSES = new Set(['sent', 'skipped', 'failed']);
const TRAINING_VALUES = new Set(['passed', 'not_passed']);
const ATTEMPT_VALUES = new Set(['first', 'repeat']);

class BookingValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BookingValidationError';
  }
}

class BookingAuthorizationError extends Error {
  constructor(message, status = 403, code = 'BOOKING_FORBIDDEN') {
    super(message);
    this.name = 'BookingAuthorizationError';
    this.status = status;
    this.code = code;
  }
}

class BookingConflictError extends Error {
  constructor(message = 'Данные записи обновились. Обновите экран и повторите действие.') {
    super(message);
    this.name = 'BookingConflictError';
    this.code = 'BOOKING_VERSION_CONFLICT';
  }
}

let bookingMutationQueue = Promise.resolve();

function parseTelegramIdSet(value) {
  return new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
  );
}

function assertConfig() {
  const missing = [];
  if (!config.botToken) missing.push('BOT_TOKEN');
  if (!config.traineeChatId) missing.push('TRAINEE_CHAT_ID');
  if (!config.mentorChatId) missing.push('MENTOR_CHAT_ID');
  if (!config.recruiterTelegramIds.size) missing.push('RECRUITER_TELEGRAM_IDS');
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

function bookingRoleForTelegramUser(user) {
  return config.recruiterTelegramIds.has(String(user.id)) ? 'recruiter' : 'trainee';
}

function initDataFromRequest(request) {
  return (
    request.body?.initData ||
    request.get('x-telegram-init-data') ||
    request.query?.initData ||
    ''
  );
}

function bookingActorFromRequest(request) {
  const telegram = validateRequestInitData(initDataFromRequest(request));
  const userId = String(telegram.user.id);
  return {
    telegram,
    userId,
    role: bookingRoleForTelegramUser(telegram.user)
  };
}

function requireRecruiterActor(request) {
  const actor = bookingActorFromRequest(request);
  if (actor.role !== 'recruiter') {
    throw new BookingAuthorizationError('Недостаточно прав для кабинета рекрута.');
  }
  return actor;
}

function handleBookingAuthError(response, error) {
  if (error instanceof TelegramAuthError) {
    response.status(401).json({ ok: false, error: error.message, code: error.code });
    return true;
  }
  if (error instanceof BookingAuthorizationError) {
    response.status(error.status).json({ ok: false, error: error.message, code: error.code });
    return true;
  }
  return false;
}

function nextDate(daysFromNow) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function seedBookingState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
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

function normalizeStateVersion(value) {
  const version = Number(value);
  return Number.isSafeInteger(version) && version > 0 ? version : 1;
}

function normalizeUpdatedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return new Date(0).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function withStateMetadata(state, source = state) {
  return {
    version: normalizeStateVersion(source?.version),
    updatedAt: normalizeUpdatedAt(source?.updatedAt),
    shifts: Array.isArray(state?.shifts) ? state.shifts : [],
    applications: Array.isArray(state?.applications) ? state.applications : [],
    inviteGroups: Array.isArray(state?.inviteGroups) ? state.inviteGroups : []
  };
}

function touchBookingState(state, now = new Date()) {
  return {
    ...state,
    version: normalizeStateVersion(state?.version) + 1,
    updatedAt: now.toISOString()
  };
}

function normalizeLegacyStatus(status) {
  const map = {
    new: 'pending',
    waiting: 'invited',
    report: 'feedback'
  };
  return map[status] || status || 'pending';
}

function normalizeRequiredText(value, field, maxLength) {
  const text = String(value || '').trim();
  if (!text) throw new BookingValidationError(`${field} is required.`);
  if (text.length > maxLength) throw new BookingValidationError(`${field} is too long.`);
  return text;
}

function normalizeOptionalText(value, field, maxLength) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw new BookingValidationError(`${field} is too long.`);
  return text;
}

function normalizeId(value, field, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BookingValidationError(`${field} must be a positive integer.`);
  }
  return id;
}

function normalizeTelegramId(value, field) {
  const text = normalizeOptionalText(value, field, 32);
  if (text && !/^\d{3,32}$/.test(text)) {
    throw new BookingValidationError(`${field} is invalid.`);
  }
  return text;
}

function normalizeUsername(value) {
  const text = normalizeOptionalText(value, 'telegramUsername', 32).replace(/^@/, '');
  if (text && !/^[A-Za-z0-9_]{3,32}$/.test(text)) {
    throw new BookingValidationError('telegramUsername is invalid.');
  }
  return text;
}

function normalizeDateValue(value, field) {
  const text = normalizeRequiredText(value, field, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new BookingValidationError(`${field} must be YYYY-MM-DD.`);
  }
  const date = new Date(`${text}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
    throw new BookingValidationError(`${field} is invalid.`);
  }
  return text;
}

function normalizeUrl(value, field, { required = false } = {}) {
  const text = required
    ? normalizeRequiredText(value, field, 500)
    : normalizeOptionalText(value, field, 500);
  if (!text) return '';
  let parsed = null;
  try {
    parsed = new URL(text);
  } catch {
    throw new BookingValidationError(`${field} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BookingValidationError(`${field} must use http or https.`);
  }
  return text;
}

function normalizeShiftForWrite(shift) {
  return {
    id: normalizeId(shift?.id, 'shift.id'),
    date: normalizeDateValue(shift?.date, 'shift.date'),
    seats: Math.min(Math.max(normalizeId(shift?.seats || 1, 'shift.seats'), 1), 30),
    open: typeof shift?.open === 'boolean' ? shift.open : !['closed', 'done', 'canceled', 'full'].includes(shift?.status)
  };
}

function normalizeApplicationForWrite(app, shiftsById, { role = 'recruiter' } = {}) {
  const status = normalizeLegacyStatus(app?.status);
  if (!BOOKING_STATUSES.has(status)) {
    throw new BookingValidationError('application.status is invalid.');
  }
  if (role === 'trainee' && !TRAINEE_WRITE_STATUSES.has(status)) {
    throw new BookingValidationError('trainee cannot set this application status.');
  }

  const shiftId = normalizeId(app?.shiftId, 'application.shiftId', { nullable: true });
  if (shiftId !== null && !shiftsById.has(shiftId)) {
    throw new BookingValidationError('application.shiftId references an unknown shift.');
  }
  if (role === 'trainee' && shiftId !== null && !shiftsById.get(shiftId)?.open) {
    throw new BookingValidationError('trainee cannot book a closed shift.');
  }

  const training = String(app?.training || 'passed').trim();
  const attempt = String(app?.attempt || 'first').trim();
  if (!TRAINING_VALUES.has(training)) throw new BookingValidationError('application.training is invalid.');
  if (!ATTEMPT_VALUES.has(attempt)) throw new BookingValidationError('application.attempt is invalid.');

  const clean = {
    id: normalizeId(app?.id, 'application.id'),
    shiftId,
    name: normalizeRequiredText(app?.name, 'application.name', 120),
    training,
    attempt,
    limits: normalizeOptionalText(app?.limits, 'application.limits', 600),
    status,
    comment: normalizeOptionalText(app?.comment ?? app?.recruiterComment, 'application.comment', 1200),
    inviteGroupId: normalizeId(app?.inviteGroupId, 'application.inviteGroupId', { nullable: true }),
    venueId: app?.venueId === null || app?.venueId === undefined
      ? null
      : normalizeOptionalText(app.venueId, 'application.venueId', 80),
    groupLink: normalizeUrl(app?.groupLink, 'application.groupLink'),
    telegramCode: normalizeOptionalText(app?.telegramCode, 'application.telegramCode', 100),
    telegramChatId: normalizeTelegramId(app?.telegramChatId, 'application.telegramChatId'),
    telegramUserId: normalizeTelegramId(app?.telegramUserId, 'application.telegramUserId'),
    telegramUsername: normalizeUsername(app?.telegramUsername),
    candidateReport: Boolean(app?.candidateReport),
    mentorReport: Boolean(app?.mentorReport),
    mentorReportAt: normalizeOptionalText(app?.mentorReportAt, 'application.mentorReportAt', 40),
    mentorReporterTelegramUserId: normalizeTelegramId(
      app?.mentorReporterTelegramUserId,
      'application.mentorReporterTelegramUserId'
    ),
    mentorDecision: normalizeOptionalText(app?.mentorDecision, 'application.mentorDecision', 120),
    mentorCommentForTrainee: normalizeOptionalText(app?.mentorCommentForTrainee, 'application.mentorCommentForTrainee', 1200),
    mentorCommentSentAt: normalizeOptionalText(app?.mentorCommentSentAt, 'application.mentorCommentSentAt', 40),
    mentorCommentDeliveryStatus: normalizeOptionalText(
      app?.mentorCommentDeliveryStatus,
      'application.mentorCommentDeliveryStatus',
      40
    ),
    mentorCommentDeliveryError: normalizeOptionalText(
      app?.mentorCommentDeliveryError,
      'application.mentorCommentDeliveryError',
      240
    )
  };

  if (
    clean.mentorCommentDeliveryStatus &&
    !MENTOR_COMMENT_DELIVERY_STATUSES.has(clean.mentorCommentDeliveryStatus)
  ) {
    throw new BookingValidationError('application.mentorCommentDeliveryStatus is invalid.');
  }

  const experience = normalizeOptionalText(app?.experience, 'application.experience', 40);
  if (experience) clean.experience = experience;
  const createdAt = normalizeOptionalText(app?.createdAt, 'application.createdAt', 40);
  if (createdAt) clean.createdAt = createdAt;
  return clean;
}

function normalizeInviteGroupForWrite(group, shiftsById, applicationsById) {
  const shiftId = normalizeId(group?.shiftId, 'inviteGroup.shiftId');
  if (!shiftsById.has(shiftId)) {
    throw new BookingValidationError('inviteGroup.shiftId references an unknown shift.');
  }
  const memberIds = Array.isArray(group?.memberIds)
    ? group.memberIds.map(id => normalizeId(id, 'inviteGroup.memberIds'))
    : [];
  memberIds.forEach(id => {
    if (!applicationsById.has(id)) {
      throw new BookingValidationError('inviteGroup.memberIds references an unknown application.');
    }
  });

  return {
    id: normalizeId(group?.id, 'inviteGroup.id'),
    shiftId,
    venueId: normalizeRequiredText(group?.venueId, 'inviteGroup.venueId', 80),
    link: normalizeUrl(group?.link, 'inviteGroup.link', { required: true }),
    memberIds: [...new Set(memberIds)],
    sentAt: normalizeOptionalText(group?.sentAt, 'inviteGroup.sentAt', 40) || new Date().toISOString()
  };
}

function validateBookingStateForWrite(state) {
  const shifts = Array.isArray(state?.shifts) ? state.shifts.map(normalizeShiftForWrite) : [];
  const shiftsById = new Map();
  shifts.forEach(shift => {
    if (shiftsById.has(shift.id)) throw new BookingValidationError('shift.id must be unique.');
    shiftsById.set(shift.id, shift);
  });

  const applications = Array.isArray(state?.applications)
    ? state.applications.map(app => normalizeApplicationForWrite(app, shiftsById))
    : [];
  const applicationsById = new Map();
  applications.forEach(application => {
    if (applicationsById.has(application.id)) throw new BookingValidationError('application.id must be unique.');
    applicationsById.set(application.id, application);
  });

  const inviteGroups = Array.isArray(state?.inviteGroups)
    ? state.inviteGroups.map(group => normalizeInviteGroupForWrite(group, shiftsById, applicationsById))
    : [];
  const inviteGroupsById = new Set();
  inviteGroups.forEach(group => {
    if (inviteGroupsById.has(group.id)) throw new BookingValidationError('inviteGroup.id must be unique.');
    inviteGroupsById.add(group.id);
  });

  return withStateMetadata({ shifts, applications, inviteGroups }, state);
}

function applicationBelongsToActor(application, actor) {
  return (
    String(application.telegramUserId || '') === actor.userId ||
    String(application.telegramChatId || '') === actor.userId
  );
}

function attachActorToApplication(application, actor) {
  return {
    ...application,
    telegramChatId: actor.userId,
    telegramUserId: actor.userId,
    telegramUsername: actor.telegram.user.username || ''
  };
}

function publicBookingState(state) {
  return {
    version: normalizeStateVersion(state?.version),
    updatedAt: normalizeUpdatedAt(state?.updatedAt),
    shifts: state.shifts.map(shift => ({ ...shift })),
    applications: [],
    inviteGroups: []
  };
}

function bookingStateForActor(state, actor) {
  if (actor.role === 'recruiter') return state;
  return {
    version: normalizeStateVersion(state?.version),
    updatedAt: normalizeUpdatedAt(state?.updatedAt),
    shifts: state.shifts.map(shift => ({ ...shift })),
    applications: state.applications
      .filter(application => applicationBelongsToActor(application, actor))
      .map(application => ({ ...application })),
    inviteGroups: []
  };
}

function splitFullName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { lastName: parts.shift() || '', firstName: parts.join(' ') };
}

function telegramUsernameDisplay(value) {
  const username = String(value || '').trim().replace(/^@/, '');
  return username ? `@${username}` : '';
}

function applicationHasInviteGroup(application) {
  return Boolean(application?.inviteGroupId || application?.groupLink);
}

function applicationCanReceiveMentorReport(application) {
  return (
    applicationHasInviteGroup(application) &&
    MENTOR_REPORT_TRAINEE_STATUSES.has(normalizeLegacyStatus(application?.status))
  );
}

function mentorTraineeStatusLabel(application) {
  if (application?.mentorReport) return 'Фидбек наставника отправлен';
  if (normalizeLegacyStatus(application?.status) === 'feedback') return 'Ждет фидбек';
  return 'Приглашен в группу';
}

function mentorTraineeFromApplication(state, application) {
  const shift = state.shifts.find(item => String(item.id) === String(application.shiftId));
  const group = state.inviteGroups.find(item => String(item.id) === String(application.inviteGroupId));
  const name = splitFullName(application.name);
  const telegramUsername = telegramUsernameDisplay(application.telegramUsername);
  return {
    id: application.id,
    applicationId: application.id,
    name: application.name,
    firstName: name.firstName,
    lastName: name.lastName,
    telegramUsername,
    telegramChatAvailable: Boolean(application.telegramChatId),
    status: normalizeLegacyStatus(application.status),
    statusLabel: mentorTraineeStatusLabel(application),
    date: shift?.date || '',
    shiftId: application.shiftId,
    venueId: application.venueId || group?.venueId || '',
    groupLink: application.groupLink || group?.link || '',
    inviteGroupId: application.inviteGroupId,
    invitedAt: group?.sentAt || '',
    mentorReport: Boolean(application.mentorReport),
    mentorReportAt: application.mentorReportAt || '',
    mentorCommentDeliveryStatus: application.mentorCommentDeliveryStatus || ''
  };
}

function mentorTraineesFromState(state) {
  const cleanState = normalizeBookingState(state);
  return cleanState.applications
    .filter(applicationCanReceiveMentorReport)
    .map(application => mentorTraineeFromApplication(cleanState, application))
    .sort((left, right) => {
      const leftDate = left.date || '9999-12-31';
      const rightDate = right.date || '9999-12-31';
      if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
      return String(left.name).localeCompare(String(right.name), 'ru');
    });
}

function requireMentorReportApplication(state, applicationId) {
  const cleanState = normalizeBookingState(state);
  const { application } = requireApplication(cleanState, applicationId);
  if (!applicationCanReceiveMentorReport(application)) {
    throw new BookingValidationError('application is not available for mentor report.');
  }
  return application;
}

function escapeTelegramHtml(value) {
  return String(value || '').replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char]));
}

function composeMentorCommentMessage(application, comment) {
  const lines = [
    '<b>Комментарий наставника для проработки</b>',
    application?.name ? `<b>Стажёр:</b> ${escapeTelegramHtml(application.name)}` : '',
    '',
    escapeTelegramHtml(comment),
    '',
    'Пожалуйста, проработайте эти пункты перед следующей сменой.'
  ];
  return lines.filter((line, index) => line || lines[index - 1]).join('\n').trim();
}

async function sendMentorCommentToTrainee(application, comment, now = new Date()) {
  const text = normalizeOptionalText(comment, 'mentorCommentForTrainee', 1200);
  if (!text) {
    return { ok: false, status: 'skipped', skipped: 'empty_comment' };
  }
  if (!application?.telegramChatId) {
    return { ok: false, status: 'skipped', skipped: 'telegram_chat_missing' };
  }

  try {
    const message = await sendTelegramMessage({
      botToken: config.botToken,
      chatId: application.telegramChatId,
      text: composeMentorCommentMessage(application, text),
      parseMode: 'HTML',
      disableWebPagePreview: true
    });
    return {
      ok: true,
      status: 'sent',
      messageId: message.message_id,
      sentAt: now.toISOString()
    };
  } catch (error) {
    console.error('Mentor comment delivery error:', error);
    return {
      ok: false,
      status: 'failed',
      error: String(error?.message || 'telegram_delivery_failed').slice(0, 240)
    };
  }
}

function applyMentorReportResultToBookingState(state, reportResult, now = new Date()) {
  const next = mutableStateCopy(normalizeBookingState(state));
  const { index, application } = requireApplication(next, reportResult.applicationId);

  if (!applicationHasInviteGroup(application)) {
    throw new BookingValidationError('application is not linked to an invite group.');
  }

  const delivery = reportResult.traineeMessage || {};
  const deliveryStatus = String(delivery.status || '').trim();
  const status = FINAL_BOOKING_STATUSES.has(normalizeLegacyStatus(application.status))
    ? normalizeLegacyStatus(application.status)
    : 'feedback';

  next.applications[index] = {
    ...application,
    status,
    mentorReport: true,
    mentorReportAt: now.toISOString(),
    mentorReporterTelegramUserId: normalizeTelegramId(
      reportResult.reporterTelegramUserId,
      'mentorReporterTelegramUserId'
    ),
    mentorDecision: normalizeOptionalText(reportResult.mentorDecision, 'mentorDecision', 120),
    mentorCommentForTrainee: normalizeOptionalText(
      reportResult.mentorCommentForTrainee,
      'mentorCommentForTrainee',
      1200
    ),
    mentorCommentDeliveryStatus: MENTOR_COMMENT_DELIVERY_STATUSES.has(deliveryStatus)
      ? deliveryStatus
      : '',
    mentorCommentSentAt: delivery.sentAt || '',
    mentorCommentDeliveryError: delivery.error || delivery.skipped || ''
  };

  return validateBookingStateForWrite(touchBookingState(next, now));
}

function withBookingMutation(task) {
  const run = bookingMutationQueue.catch(() => {}).then(task);
  bookingMutationQueue = run.catch(() => {});
  return run;
}

function requireFreshVersion(state, baseVersion) {
  const clientVersion = Number(baseVersion);
  if (!Number.isSafeInteger(clientVersion) || clientVersion <= 0) {
    throw new BookingValidationError('baseVersion is required.');
  }
  if (clientVersion !== normalizeStateVersion(state.version)) {
    throw new BookingConflictError();
  }
}

function requireRecruiterRole(actor) {
  if (actor.role !== 'recruiter') {
    throw new BookingAuthorizationError('Недостаточно прав для кабинета рекрута.');
  }
}

function nextEntityId(items) {
  const maxId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
  return Math.max(Date.now(), maxId + 1);
}

function findApplicationIndex(state, applicationId) {
  return state.applications.findIndex(item => String(item.id) === String(applicationId));
}

function requireApplication(state, applicationId) {
  const index = findApplicationIndex(state, applicationId);
  if (index < 0) throw new BookingValidationError('application not found.');
  return { index, application: state.applications[index] };
}

function requireShift(state, shiftId) {
  const shift = state.shifts.find(item => String(item.id) === String(shiftId));
  if (!shift) throw new BookingValidationError('shift not found.');
  return shift;
}

function mutableStateCopy(state) {
  return {
    version: normalizeStateVersion(state.version),
    updatedAt: normalizeUpdatedAt(state.updatedAt),
    shifts: state.shifts.map(shift => ({ ...shift })),
    applications: state.applications.map(application => ({ ...application })),
    inviteGroups: state.inviteGroups.map(group => ({
      ...group,
      memberIds: Array.isArray(group.memberIds) ? [...group.memberIds] : []
    }))
  };
}

function applyUpsertTraineeApplication(state, command, actor) {
  const shiftsById = new Map(state.shifts.map(shift => [shift.id, shift]));
  const incoming = attachActorToApplication(
    normalizeApplicationForWrite(command.application, shiftsById, { role: 'trainee' }),
    actor
  );
  const next = mutableStateCopy(state);
  const index = findApplicationIndex(next, incoming.id);

  if (index < 0) {
    next.applications.push(incoming);
    return next;
  }

  const existing = next.applications[index];
  if (!applicationBelongsToActor(existing, actor)) {
    throw new BookingAuthorizationError('Нельзя изменить чужую заявку.');
  }
  if (!['pending', 'queue', 'failed', 'noshow'].includes(existing.status)) {
    throw new BookingValidationError('application cannot be changed in current status.');
  }

  next.applications[index] = {
    ...existing,
    ...incoming,
    status: incoming.status
  };
  return next;
}

function applyCancelApplication(state, command, actor) {
  const { application } = requireApplication(state, command.applicationId);
  if (actor.role !== 'recruiter' && !applicationBelongsToActor(application, actor)) {
    throw new BookingAuthorizationError('Нельзя отменить чужую заявку.');
  }
  if (actor.role !== 'recruiter' && !['pending', 'queue', 'failed', 'noshow'].includes(application.status)) {
    throw new BookingValidationError('application cannot be canceled in current status.');
  }
  const next = mutableStateCopy(state);
  next.applications = next.applications.filter(item => String(item.id) !== String(command.applicationId));
  return next;
}

function applySetApplicationStatus(state, command, actor) {
  requireRecruiterRole(actor);
  const status = normalizeLegacyStatus(command.status);
  if (!BOOKING_STATUSES.has(status)) throw new BookingValidationError('application.status is invalid.');

  const next = mutableStateCopy(state);
  const { index, application } = requireApplication(next, command.applicationId);
  if (status === 'confirmed' && !application.shiftId) {
    throw new BookingValidationError('confirmed application must have shiftId.');
  }
  next.applications[index] = { ...application, status };
  return next;
}

function applyReturnToQueue(state, command, actor) {
  requireRecruiterRole(actor);
  const next = mutableStateCopy(state);
  const { index, application } = requireApplication(next, command.applicationId);
  next.applications[index] = {
    ...application,
    shiftId: null,
    status: 'queue'
  };
  return next;
}

function applyAssignShift(state, command, actor) {
  requireRecruiterRole(actor);
  const shiftId = normalizeId(command.shiftId, 'shiftId');
  requireShift(state, shiftId);
  const next = mutableStateCopy(state);
  const { index, application } = requireApplication(next, command.applicationId);
  next.applications[index] = {
    ...application,
    shiftId,
    status: 'pending'
  };
  return next;
}

function applyToggleShift(state, command, actor) {
  requireRecruiterRole(actor);
  const next = mutableStateCopy(state);
  const shift = next.shifts.find(item => String(item.id) === String(command.shiftId));
  if (!shift) throw new BookingValidationError('shift not found.');
  shift.open = typeof command.open === 'boolean' ? command.open : !shift.open;
  return next;
}

function applyCreateShift(state, command, actor) {
  requireRecruiterRole(actor);
  const next = mutableStateCopy(state);
  const shift = normalizeShiftForWrite({
    id: nextEntityId(next.shifts),
    date: command.date,
    seats: command.seats,
    open: true
  });
  next.shifts.push(shift);
  return next;
}

function applyUpdateComment(state, command, actor) {
  requireRecruiterRole(actor);
  const next = mutableStateCopy(state);
  const { index, application } = requireApplication(next, command.applicationId);
  next.applications[index] = {
    ...application,
    comment: normalizeOptionalText(command.comment, 'application.comment', 1200)
  };
  return next;
}

function applySendInvites(state, command, actor) {
  requireRecruiterRole(actor);
  const next = mutableStateCopy(state);
  const shiftId = normalizeId(command.shiftId, 'inviteGroup.shiftId');
  requireShift(next, shiftId);
  const memberIds = Array.isArray(command.memberIds)
    ? [...new Set(command.memberIds.map(id => normalizeId(id, 'inviteGroup.memberIds')))]
    : [];
  if (!memberIds.length) throw new BookingValidationError('inviteGroup.memberIds is required.');
  const venueId = normalizeRequiredText(command.venueId, 'inviteGroup.venueId', 80);
  const link = normalizeUrl(command.link, 'inviteGroup.link', { required: true });
  const id = nextEntityId(next.inviteGroups);
  const sentAt = new Date().toISOString();

  for (const memberId of memberIds) {
    const { index, application } = requireApplication(next, memberId);
    if (String(application.shiftId) !== String(shiftId)) {
      throw new BookingValidationError('inviteGroup member has another shift.');
    }
    if (!['confirmed', 'invited'].includes(application.status)) {
      throw new BookingValidationError('inviteGroup member is not eligible.');
    }
    next.applications[index] = {
      ...application,
      status: 'invited',
      inviteGroupId: id,
      venueId,
      groupLink: link
    };
  }

  const applicationsById = new Map(next.applications.map(application => [application.id, application]));
  const shiftsById = new Map(next.shifts.map(shift => [shift.id, shift]));
  const group = normalizeInviteGroupForWrite(
    { id, shiftId, venueId, link, memberIds, sentAt },
    shiftsById,
    applicationsById
  );
  next.inviteGroups.push(group);
  return next;
}

function applyClearState(state, _command, actor) {
  requireRecruiterRole(actor);
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    shifts: [],
    applications: [],
    inviteGroups: []
  };
}

function applyResetDemoState(state, _command, actor) {
  requireRecruiterRole(actor);
  return {
    ...seedBookingState(),
    version: state.version,
    updatedAt: state.updatedAt
  };
}

function applyBookingCommand(currentState, command, actor, now = new Date()) {
  const state = normalizeBookingState(currentState);
  requireFreshVersion(state, command?.baseVersion);
  const action = String(command?.action || '').trim();
  let nextState = null;

  switch (action) {
    case 'upsert_trainee_application':
      nextState = applyUpsertTraineeApplication(state, command, actor);
      break;
    case 'cancel_application':
      nextState = applyCancelApplication(state, command, actor);
      break;
    case 'set_application_status':
      nextState = applySetApplicationStatus(state, command, actor);
      break;
    case 'return_to_queue':
      nextState = applyReturnToQueue(state, command, actor);
      break;
    case 'assign_shift':
      nextState = applyAssignShift(state, command, actor);
      break;
    case 'toggle_shift':
      nextState = applyToggleShift(state, command, actor);
      break;
    case 'create_shift':
      nextState = applyCreateShift(state, command, actor);
      break;
    case 'update_comment':
      nextState = applyUpdateComment(state, command, actor);
      break;
    case 'send_invites':
      nextState = applySendInvites(state, command, actor);
      break;
    case 'clear_state':
      nextState = applyClearState(state, command, actor);
      break;
    case 'reset_demo_state':
      nextState = applyResetDemoState(state, command, actor);
      break;
    default:
      throw new BookingValidationError('Unknown booking action.');
  }

  return validateBookingStateForWrite(touchBookingState(nextState, now));
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
  return withStateMetadata({
    shifts: Array.isArray(state?.shifts) ? state.shifts : [],
    applications: Array.isArray(state?.applications) ? state.applications : [],
    inviteGroups: Array.isArray(state?.inviteGroups) ? state.inviteGroups : []
  }, state);
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
  const cleanState = validateBookingStateForWrite(state);
  await fs.mkdir(config.dataDir, { recursive: true });
  const tempPath = `${dbPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(cleanState, null, 2), 'utf8');
  await fs.rename(tempPath, dbPath);
  return cleanState;
}

function injectBookingState(html, state) {
  const payload = JSON.stringify(publicBookingState(state)).replace(/</g, '\\u003c');
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
  return withBookingMutation(async () => {
    const state = await readBookingState();
    let registered = false;
    state.applications = state.applications.map(application => {
      if (application.telegramCode !== code) return application;
      registered = true;
      return {
        ...application,
        telegramChatId: String(chatId),
        telegramUserId: application.telegramUserId || String(chatId)
      };
    });
    if (registered) await writeBookingState(touchBookingState(state));
    return registered;
  });
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

app.get('/api/state', async (request, response, next) => {
  try {
    const actor = bookingActorFromRequest(request);
    const state = await readBookingState();
    response.json({ ok: true, role: actor.role, state: bookingStateForActor(state, actor) });
  } catch (error) {
    if (handleBookingAuthError(response, error)) return;
    next(error);
  }
});

app.post('/api/state', async (request, response, next) => {
  let actor = null;
  try {
    actor = bookingActorFromRequest(request);
    const cleanState = await withBookingMutation(async () => {
      const currentState = await readBookingState();
      const nextState = applyBookingCommand(currentState, request.body || {}, actor);
      return writeBookingState(nextState);
    });
    if (actor.role === 'recruiter' && request.body?.action === 'clear_state') {
      console.info(
        JSON.stringify({
          event: 'booking_state_cleared',
          telegramUserId: actor.telegram.user.id,
          username: actor.telegram.user.username || '',
          timestamp: new Date().toISOString()
        })
      );
    }
    response.json({ ok: true, role: actor.role, state: bookingStateForActor(cleanState, actor) });
  } catch (error) {
    if (handleBookingAuthError(response, error)) return;
    if (error instanceof BookingConflictError && actor) {
      const state = await readBookingState();
      response.status(409).json({
        ok: false,
        error: error.message,
        code: error.code,
        role: actor.role,
        state: bookingStateForActor(state, actor)
      });
      return;
    }
    if (error instanceof BookingValidationError) {
      response.status(400).json({ ok: false, error: error.message, code: 'BOOKING_VALIDATION_FAILED' });
      return;
    }
    next(error);
  }
});

app.post('/api/notify', async (request, response, next) => {
  try {
    requireRecruiterActor(request);
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
    if (handleBookingAuthError(response, error)) return;
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

    let linkedApplication = null;
    let forbidden = false;
    const actor = {
      telegram,
      userId: String(telegram.user.id),
      role: bookingRoleForTelegramUser(telegram.user)
    };
    const cleanState = await withBookingMutation(async () => {
      const state = await readBookingState();
      state.applications = state.applications.map(application => {
        if (String(application.id) !== String(applicationId)) return application;
        const existingOwner = String(application.telegramUserId || application.telegramChatId || '');
        if (existingOwner && existingOwner !== String(telegram.user.id)) {
          forbidden = true;
          return application;
        }
        linkedApplication = {
          ...application,
          telegramChatId: String(telegram.user.id),
          telegramUserId: String(telegram.user.id),
          telegramUsername: telegram.user.username || ''
        };
        return linkedApplication;
      });

      if (forbidden || !linkedApplication) return state;
      return writeBookingState(touchBookingState(state));
    });

    if (forbidden) {
      response.status(403).json({ ok: false, error: 'application_owner_mismatch' });
      return;
    }
    if (!linkedApplication) {
      response.status(404).json({ ok: false, error: 'application_not_found' });
      return;
    }

    response.json({
      ok: true,
      role: actor.role,
      application: linkedApplication,
      state: bookingStateForActor(cleanState, actor)
    });
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

app.get('/api/report/trainees', async (request, response) => {
  try {
    validateRequestInitData(initDataFromRequest(request));
    const state = await readBookingState();
    response.json({
      ok: true,
      trainees: mentorTraineesFromState(state),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      response.status(401).json({ ok: false, error: error.message, code: error.code });
      return;
    }
    console.error('Mentor trainee list error:', error);
    response.status(500).json({ ok: false, error: 'Не удалось загрузить список стажёров.' });
  }
});

app.post('/api/report', async (request, response) => {
  try {
    const telegram = validateRequestInitData(request.body?.initData);
    const role = normalizeRole(request.body?.role);
    const reportText = normalizeReportText(request.body?.reportText);
    const chatId = resolveChatId(role, config);
    const applicationId = request.body?.applicationId;
    const mentorDecision = normalizeOptionalText(request.body?.mentorDecision, 'mentorDecision', 120);
    const mentorCommentForTrainee = normalizeOptionalText(
      request.body?.mentorCommentForTrainee,
      'mentorCommentForTrainee',
      1200
    );
    let mentorApplication = null;

    if (role === 'mentor') {
      const state = await readBookingState();
      mentorApplication = requireMentorReportApplication(state, applicationId);
    }

    const message = await sendTelegramMessage({
      botToken: config.botToken,
      chatId,
      text: reportText
    });
    let traineeMessage = null;

    if (role === 'mentor' && mentorApplication) {
      const deliveryTime = new Date();
      traineeMessage = await sendMentorCommentToTrainee(
        mentorApplication,
        mentorCommentForTrainee,
        deliveryTime
      );

      await withBookingMutation(async () => {
        const state = await readBookingState();
        const nextState = applyMentorReportResultToBookingState(
          state,
          {
            applicationId,
            reporterTelegramUserId: telegram.user.id,
            mentorDecision,
            mentorCommentForTrainee,
            traineeMessage
          },
          deliveryTime
        );
        return writeBookingState(nextState);
      });
    }

    console.info(
      JSON.stringify({
        event: 'internship_report_sent',
        telegramUserId: telegram.user.id,
        role,
        applicationId: role === 'mentor' ? applicationId : undefined,
        chatTarget: role === 'mentor' ? 'MENTOR_CHAT_ID' : 'TRAINEE_CHAT_ID',
        telegramMessageId: message.message_id,
        traineeMessageStatus: traineeMessage?.status,
        timestamp: new Date().toISOString()
      })
    );

    response.json({ ok: true, messageId: message.message_id, traineeMessage });
  } catch (error) {
    if (error instanceof TelegramAuthError) {
      response.status(401).json({ ok: false, error: error.message, code: error.code });
      return;
    }

    if (error instanceof BookingValidationError) {
      response.status(400).json({ ok: false, error: error.message, code: 'BOOKING_VALIDATION_FAILED' });
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
  if (error instanceof BookingConflictError) {
    response.status(409).json({ ok: false, error: error.message, code: error.code });
    return;
  }
  if (error instanceof BookingValidationError) {
    response.status(400).json({ ok: false, error: error.message, code: 'BOOKING_VALIDATION_FAILED' });
    return;
  }
  console.error('Unhandled server error:', error);
  response.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера.' });
});

export {
  BookingConflictError,
  BookingValidationError,
  applyMentorReportResultToBookingState,
  applyBookingCommand,
  bookingStateForActor,
  mentorTraineesFromState,
  normalizeBookingState
};

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isMainModule) {
  assertConfig();
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
}
