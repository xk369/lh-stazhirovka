import { createHash, randomUUID } from 'node:crypto';
import {
  ACTIVE_TRAINEE_APPLICATION_STATUSES,
  BOOKING_STATUSES,
  BOOKING_STEP_BACK_STATUSES,
  BOOKING_STATUS_LABELS,
  MENTOR_REPORT_TRAINEE_STATUSES,
  SEAT_HOLDING_STATUSES,
  SHIFT_CANCELLATION_APPLICATION_STATUSES,
  TRAINEE_QUEUE_REJOIN_SOURCE_STATUSES,
  TRAINEE_REAPPLY_SOURCE_STATUSES,
  TRAINEE_WRITE_STATUSES,
  bookingStatusFromMentorDecision,
  canRecruiterSetApplicationStatus
} from '../booking-state-machine.js';
import { buildBookingImportPlan } from './import-booking-state.js';
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

export class PostgresCommandNotFoundError extends Error {
  constructor(message = 'Запись не найдена.') {
    super(message);
    this.name = 'PostgresCommandNotFoundError';
    this.code = 'POSTGRES_COMMAND_NOT_FOUND';
    this.status = 404;
  }
}

const SEAT_HOLDING_STATUS_VALUES = Object.freeze([...SEAT_HOLDING_STATUSES]);
const RETURN_TO_QUEUE_STATUSES = new Set(['queue', 'pending', 'confirmed', 'invited']);
const TRAINING_VALUES = new Set(['passed', 'not_passed']);
const ATTEMPT_VALUES = new Set(['first', 'repeat']);
const TRAINEE_MUTABLE_STATUSES = new Set(['pending', 'queue']);
const CANCEL_APPLICATION_STATUSES = new Set(['pending', 'queue']);
const MENTOR_COMMENT_DELIVERY_STATUSES = new Set(['sent', 'skipped', 'failed']);
const ASSIGNMENT_OFFER_TTL_MS = 60 * 60 * 1000;
const MENTOR_RESULT_STATUS_EVENTS = Object.freeze({
  passed: 'application_passed',
  failed: 'application_failed'
});
const TRAINEE_PROFILE_FIELDS = Object.freeze([
  'name',
  'phone',
  'training',
  'trainingDate',
  'attempt',
  'limits',
  'telegramCode',
  'telegramChatId',
  'telegramUserId',
  'telegramUsername'
]);

function requireRecruiter(actor) {
  if (!actor || actor.role !== 'recruiter') {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для кабинета рекрута.');
  }
}

function requireTrainee(actor) {
  if (!actor || actor.role !== 'trainee') {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для записи стажёра.');
  }
}

function requireTelegramApplicationLinkActor(actor) {
  if (!actor || !['trainee', 'recruiter'].includes(String(actor.role || ''))) {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для привязки Telegram.');
  }
}

function actorTelegramUserId(actor) {
  return String(actor?.telegram?.user?.id || actor?.userId || '').trim() || null;
}

function actorTelegramUsername(actor) {
  return String(actor?.telegram?.user?.username || '').trim();
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

function normalizeRequiredText(value, field, maxLength) {
  const text = normalizeOptionalText(value, field, maxLength);
  if (!text) throw new PostgresCommandValidationError(`${field} is required.`);
  return text;
}

function normalizeIsoDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PostgresCommandValidationError('shift.date must be YYYY-MM-DD.');
  }
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PostgresCommandValidationError('shift.date is invalid.');
  }
  return date;
}

function normalizeApplicationDate(value, field) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PostgresCommandValidationError(`${field} must be YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PostgresCommandValidationError(`${field} is invalid.`);
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

function normalizeTraineeApplicationLegacyId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PostgresCommandValidationError('application.id must be a positive integer.');
  }
  return id;
}

function normalizeNullableShiftLegacyId(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeShiftLegacyId(value);
}

function normalizePhone(value) {
  const text = normalizeRequiredText(value, 'application.phone', 40);
  const digits = text.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 20) {
    throw new PostgresCommandValidationError('Проверьте номер телефона: должно быть от 7 до 20 цифр.');
  }
  return text;
}

function normalizeTelegramUserId(value, field) {
  const text = normalizeOptionalText(value, field, 32);
  if (text && !/^\d{3,32}$/.test(text)) {
    throw new PostgresCommandValidationError(`${field} is invalid.`);
  }
  return text;
}

function normalizeUsername(value) {
  const text = normalizeOptionalText(value, 'telegramUsername', 32).replace(/^@/, '');
  if (text && !/^[A-Za-z0-9_]{3,32}$/.test(text)) {
    throw new PostgresCommandValidationError('telegramUsername is invalid.');
  }
  return text;
}

function normalizeTrainingDate(value, training) {
  const text = normalizeOptionalText(value, 'application.trainingDate', 10);
  if (training !== 'passed') return '';
  if (!text) throw new PostgresCommandValidationError('Укажите дату прохождения обучения.');
  return normalizeApplicationDate(text, 'application.trainingDate');
}

function normalizeTraineeApplicationInput(command, actor) {
  const app = command?.application || {};
  const status = String(app.status || '').trim();
  if (!TRAINEE_WRITE_STATUSES.has(status)) {
    throw new PostgresCommandValidationError('trainee cannot set this application status.');
  }

  const shiftLegacyId = normalizeNullableShiftLegacyId(app.shiftId);
  if (status === 'queue' && shiftLegacyId !== null) {
    throw new PostgresCommandValidationError('queue application must not have shiftId.');
  }
  if (status === 'pending' && shiftLegacyId === null) {
    throw new PostgresCommandValidationError('pending application must have shiftId.');
  }

  const training = String(app.training || 'passed').trim();
  if (!TRAINING_VALUES.has(training)) {
    throw new PostgresCommandValidationError('application.training is invalid.');
  }
  const attempt = String(app.attempt || 'first').trim();
  if (!ATTEMPT_VALUES.has(attempt)) {
    throw new PostgresCommandValidationError('application.attempt is invalid.');
  }

  const userId = actorTelegramUserId(actor);
  if (!userId) {
    throw new PostgresCommandAuthorizationError('Не удалось определить Telegram ID стажёра.');
  }

  return {
    applicationLegacyId: normalizeTraineeApplicationLegacyId(app.id),
    shiftLegacyId,
    name: normalizeRequiredText(app.name, 'application.name', 120),
    phone: normalizePhone(app.phone),
    training,
    trainingDate: normalizeTrainingDate(app.trainingDate, training),
    attempt,
    limits: normalizeOptionalText(app.limits, 'application.limits', 600),
    status,
    comment: normalizeOptionalText(app.comment ?? app.recruiterComment, 'application.comment', 1200),
    telegramCode: normalizeOptionalText(app.telegramCode, 'application.telegramCode', 100),
    telegramUserId: normalizeTelegramUserId(userId, 'application.telegramUserId'),
    telegramChatId: normalizeTelegramUserId(userId, 'application.telegramChatId'),
    telegramUsername: normalizeUsername(actorTelegramUsername(actor)),
    baseVersion: normalizeBaseVersion(command)
  };
}

function applicationRowBelongsToTrainee(row, actor) {
  const userId = actorTelegramUserId(actor);
  return Boolean(userId) && (
    String(row.trainee_telegram_user_id || '') === userId
    || String(row.trainee_telegram_chat_id || '') === userId
  );
}

function compactApplicationPayload(application) {
  return {
    status: application.status,
    shiftId: application.shiftLegacyId ?? null,
    inviteGroupId: null,
    venueId: '',
    telegramUserId: application.telegramUserId || '',
    telegramUsername: application.telegramUsername || ''
  };
}

function changedTraineeProfileFields(previous, next) {
  return TRAINEE_PROFILE_FIELDS.filter(field => {
    const before = previous?.[field] ?? '';
    const after = next?.[field] ?? '';
    return String(before) !== String(after);
  });
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
const VENUE_HALLS = Object.freeze({
  loft1: { loft: 'LOFT #1', halls: ['AVANTAGE', 'CHATEAU', 'ROYAL BLANC'] },
  loft2: { loft: 'LOFT #2', halls: ['ROCKFELLER&ROTHSHILD`S HALL', 'BACKYARD'] },
  loft3: { loft: 'LOFT #3', halls: ['MONTBLANC', 'GRACE', 'RATUSHA'] },
  loft4: { loft: 'LOFT #4', halls: ['ANDY&CYNDY', 'MONDRIAN', 'BANKSY', 'LONG&ITTEN'] },
  loft5_contrabanda: { loft: 'LOFT #5', halls: ['CONTRABANDA'], fixedHall: 'CONTRABANDA' },
  loft5_small: { loft: 'LOFT #5', halls: ['SMALL'], fixedHall: 'SMALL' },
  loft8: { loft: 'LOFT #8', halls: ['MAIN HALL', 'WELCOME HALL', 'ROSEWOOD HALL', 'MILINIS HALL'] },
  loft10: { loft: 'LOFT #10 (TAU)', halls: ['MAIN HALL'], fixedHall: 'MAIN HALL' },
  birch: { loft: 'THE BIRCH', halls: ['AMBERWOOD', 'BLACKWOOD', 'MANGO', 'MAHOGANY'] },
  metelitsa: { loft: 'МЕТЕЛИЦА', halls: [] }
});

function statusLabel(status) {
  return BOOKING_STATUS_LABELS[status] || status;
}

function requireMentor(actor) {
  if (!actor || actor.role !== 'mentor') {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для отчёта наставника.');
  }
  if (!actorTelegramUserId(actor)) {
    throw new PostgresCommandAuthorizationError('Не удалось определить Telegram ID наставника.');
  }
}

function actorTelegramName(actor) {
  return [
    String(actor?.telegram?.user?.first_name || '').trim(),
    String(actor?.telegram?.user?.last_name || '').trim()
  ].filter(Boolean).join(' ');
}

function comparablePersonName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeVenueReportHall(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMentorTraineeResult(value) {
  const result = value && typeof value === 'object' ? value : {};
  const topics = Array.isArray(result.topicsToRepeat) ? result.topicsToRepeat : [];
  const normalized = {
    date: normalizeOptionalText(result.date, 'mentorTraineeResult.date', 20),
    venue: normalizeOptionalText(result.venue, 'mentorTraineeResult.venue', 120),
    venueId: normalizeOptionalText(result.venueId, 'mentorTraineeResult.venueId', 80),
    venueLoft: normalizeOptionalText(result.venueLoft, 'mentorTraineeResult.venueLoft', 80),
    hall: normalizeOptionalText(normalizeVenueReportHall(result.hall), 'mentorTraineeResult.hall', 80),
    mastered: Math.max(Number.parseInt(result.mastered, 10) || 0, 0),
    total: Math.max(Number.parseInt(result.total, 10) || 0, 0),
    decision: normalizeOptionalText(result.decision, 'mentorTraineeResult.decision', 120),
    topicsToRepeat: topics.slice(0, 40).map((topic, index) => ({
      order: Math.max(Number.parseInt(topic?.order, 10) || index + 1, 1),
      title: normalizeRequiredText(topic?.title, 'mentorTraineeResult.topic.title', 220)
    }))
  };
  if (normalized.total > 0 && normalized.mastered > normalized.total) {
    throw new PostgresCommandValidationError('mentorTraineeResult.mastered cannot exceed total.');
  }
  return normalized;
}

function normalizeMentorReportInput(command) {
  const mentorTraineeResult = normalizeMentorTraineeResult(command?.mentorTraineeResult);
  const mentorDecision = normalizeRequiredText(
    command?.mentorDecision || mentorTraineeResult.decision,
    'mentorDecision',
    120
  );
  const nextStatus = bookingStatusFromMentorDecision(mentorDecision, '');
  if (!MENTOR_RESULT_STATUS_EVENTS[nextStatus]) {
    throw new PostgresCommandValidationError('mentorDecision is invalid.');
  }
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    mentorTraineeName: normalizeOptionalText(command?.mentorTraineeName, 'mentorTraineeName', 180),
    mentorDecision,
    mentorCommentForTrainee: normalizeOptionalText(
      command?.mentorCommentForTrainee,
      'mentorCommentForTrainee',
      1200
    ),
    reportText: normalizeRequiredText(command?.reportText, 'reportText', 3900),
    mentorTraineeResult: {
      ...mentorTraineeResult,
      decision: mentorTraineeResult.decision || mentorDecision
    },
    nextStatus
  };
}

function normalizeTraineeReportInput(command) {
  return {
    reportText: normalizeRequiredText(command?.reportText, 'reportText', 3900)
  };
}

function normalizeReportChatId(value, field) {
  return normalizeRequiredText(value, field, 120);
}

function ensureMentorReportTargetMatchesRow(row, submittedName) {
  const expectedName = comparablePersonName(row?.name);
  const receivedName = comparablePersonName(submittedName);
  if (expectedName && receivedName && expectedName !== receivedName) {
    throw new PostgresCommandValidationError(
      'Выбранный стажёр не совпадает с заявкой. Обновите список и выберите стажёра заново.'
    );
  }
}

function ensureMentorReportVenueMatchesRow(row, resultPayload) {
  const result = normalizeMentorTraineeResult(resultPayload);
  const expectedVenueId = normalizeOptionalText(row?.venue_id, 'application.venueId', 80);
  if (!expectedVenueId || !result.venueId) return;
  if (expectedVenueId !== result.venueId) {
    throw new PostgresCommandValidationError(
      'Площадка отчёта не совпадает с площадкой заявки стажёра. Обновите список и выберите стажёра заново.'
    );
  }

  const config = VENUE_HALLS[expectedVenueId];
  if (!config) return;
  if (config.halls.length > 1 && !result.hall) {
    throw new PostgresCommandValidationError('Выберите зал стажировки внутри площадки стажёра.');
  }
  if (result.hall && config.halls.length && !config.halls.includes(result.hall)) {
    throw new PostgresCommandValidationError('Зал отчёта не относится к площадке заявки стажёра.');
  }
}

function applicationRowHasInviteGroup(row) {
  return Boolean(row.invite_group_id) || Boolean(String(row.group_link || '').trim());
}

function applicationRowCanReceiveMentorReport(row) {
  return (
    !row?.mentor_report_received
    && applicationRowHasInviteGroup(row)
    && MENTOR_REPORT_TRAINEE_STATUSES.has(String(row?.status || ''))
  );
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

function dateValueFromNow(now, daysFromNow) {
  const date = new Date(now);
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

function seedPostgresDemoBookingState(now) {
  const nowIso = now.toISOString();
  return {
    version: 1,
    updatedAt: nowIso,
    shifts: [
      { id: 1, date: dateValueFromNow(now, 2), seats: 3, open: true, canceled: false },
      { id: 2, date: dateValueFromNow(now, 4), seats: 4, open: true, canceled: false },
      { id: 3, date: dateValueFromNow(now, 6), seats: 2, open: true, canceled: false }
    ],
    applications: [
      {
        id: 101,
        shiftId: 2,
        name: 'Петрова Алина',
        phone: '+7 999 111-22-33',
        training: 'passed',
        trainingDate: dateValueFromNow(now, -8),
        attempt: 'first',
        limits: 'Могу после 14:00, центр подходит.',
        status: 'pending',
        comment: '',
        candidateReport: false,
        mentorReport: false,
        createdAt: dateValueFromNow(now, -1)
      },
      {
        id: 102,
        shiftId: 1,
        name: 'Смирнов Никита',
        phone: '+7 999 222-33-44',
        training: 'not_passed',
        attempt: 'repeat',
        limits: 'Без ограничений.',
        status: 'confirmed',
        comment: 'Подтвержден.',
        candidateReport: true,
        mentorReport: false,
        createdAt: dateValueFromNow(now, -1)
      },
      {
        id: 103,
        shiftId: null,
        name: 'Козлова Мария',
        phone: '+7 999 333-44-55',
        training: 'passed',
        trainingDate: dateValueFromNow(now, -7),
        attempt: 'first',
        limits: 'Ограничений нет, готова на ближайшую дату.',
        status: 'queue',
        comment: '',
        candidateReport: false,
        mentorReport: false,
        createdAt: dateValueFromNow(now, -1)
      }
    ],
    inviteGroups: []
  };
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

async function countBookingStateRows(client) {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM shifts) AS shifts,
      (SELECT count(*)::int FROM applications) AS applications,
      (SELECT count(*)::int FROM application_assignment_offers) AS application_assignment_offers,
      (SELECT count(*)::int FROM invite_groups) AS invite_groups,
      (SELECT count(*)::int FROM invite_group_members) AS invite_group_members,
      (SELECT count(*)::int FROM mentor_reports WHERE voided_at IS NULL) AS active_mentor_reports,
      (SELECT count(*)::int FROM notifications) AS notifications
  `);
  const row = result.rows[0] || {};
  return {
    shifts: Number(row.shifts) || 0,
    applications: Number(row.applications) || 0,
    applicationAssignmentOffers: Number(row.application_assignment_offers) || 0,
    inviteGroups: Number(row.invite_groups) || 0,
    inviteGroupMembers: Number(row.invite_group_members) || 0,
    activeMentorReports: Number(row.active_mentor_reports) || 0,
    notifications: Number(row.notifications) || 0
  };
}

async function clearBookingStateRows(client) {
  const counts = await countBookingStateRows(client);
  await client.query('DELETE FROM notifications');
  await client.query('DELETE FROM mentor_report_topics');
  await client.query('DELETE FROM mentor_reports');
  await client.query('DELETE FROM application_assignment_offers');
  await client.query('DELETE FROM invite_group_members');
  await client.query('DELETE FROM invite_groups');
  await client.query('DELETE FROM applications');
  await client.query('DELETE FROM shifts');
  return counts;
}

async function insertPlannedDemoRows(client, plan) {
  for (const row of plan.shifts) {
    await client.query(`
      INSERT INTO shifts (
        id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      row.id,
      row.legacyId,
      row.date,
      row.seats,
      row.open,
      row.canceled,
      row.canceledAt,
      row.createdAt,
      row.updatedAt
    ]);
  }

  for (const row of plan.applications) {
    await client.query(`
      INSERT INTO applications (
        id, legacy_id, shift_id, invite_group_id,
        trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username, telegram_code,
        name, phone, training, training_date, attempt, limits, status,
        recruiter_comment, recruiter_queue_comment,
        venue_id, group_link, candidate_report, experience,
        mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
        mentor_decision, mentor_report_venue_id, mentor_report_venue, mentor_report_loft,
        mentor_report_hall, mentor_comment_for_trainee, mentor_comment_sent_at,
        mentor_comment_delivery_status, mentor_comment_delivery_error,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20, $21,
        $22, $23, $24,
        $25, $26, $27, $28,
        $29, $30, $31,
        $32, $33,
        $34, $35
      )
    `, [
      row.id,
      row.legacyId,
      row.shiftId,
      row.inviteGroupId,
      row.traineeTelegramUserId,
      row.traineeTelegramChatId,
      row.telegramUsername,
      row.telegramCode,
      row.name,
      row.phone,
      row.training,
      row.trainingDate,
      row.attempt,
      row.limits,
      row.status,
      row.recruiterComment,
      row.recruiterQueueComment,
      row.venueId,
      row.groupLink,
      row.candidateReport,
      row.experience,
      row.mentorReportReceived,
      row.mentorReportAt,
      row.mentorReporterTelegramUserId,
      row.mentorDecision,
      row.mentorReportVenueId,
      row.mentorReportVenue,
      row.mentorReportLoft,
      row.mentorReportHall,
      row.mentorCommentForTrainee,
      row.mentorCommentSentAt,
      row.mentorCommentDeliveryStatus,
      row.mentorCommentDeliveryError,
      row.createdAt,
      row.updatedAt
    ]);
  }

  for (const row of plan.assignmentOffers) {
    await client.query(`
      INSERT INTO application_assignment_offers (
        id, application_id, shift_id, token, status, requested_by_telegram_user_id,
        requested_at, expires_at, message_chat_id, message_id, responded_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12)
    `, [
      row.id,
      row.applicationId,
      row.shiftId,
      row.token,
      row.status,
      row.requestedByTelegramUserId,
      row.requestedAt,
      row.expiresAt,
      row.messageChatId,
      row.messageId,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

function normalizeCreateShiftInput(command) {
  return {
    date: normalizeIsoDate(command?.date),
    seats: normalizeSeats(command?.seats),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeToggleShiftInput(command) {
  return {
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    requestedOpen: typeof command?.open === 'boolean' ? command.open : null,
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

function normalizeCancelApplicationInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeLinkTelegramInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId)
  };
}

function normalizeStateAdminInput(command) {
  return {
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

function normalizeUpdateQueueCommentInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    comment: normalizeOptionalText(command?.comment, 'application.recruiterQueueComment', 600),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeRequestAssignmentConfirmationInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    baseVersion: normalizeBaseVersion(command)
  };
}

function normalizeAssignmentOfferToken(value) {
  return normalizeRequiredText(value, 'assignmentOffer.token', 80);
}

function normalizeTelegramMessageId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PostgresCommandValidationError('assignmentOffer.messageId must be a positive integer.');
  }
  return id;
}

function normalizeRecordAssignmentOfferMessageInput(command) {
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    token: normalizeAssignmentOfferToken(command?.token),
    messageChatId: normalizeTelegramUserId(command?.messageChatId, 'assignmentOffer.messageChatId'),
    messageId: normalizeTelegramMessageId(command?.messageId)
  };
}

function normalizeRespondAssignmentOfferInput(command) {
  const decision = normalizeRequiredText(command?.decision, 'assignmentOffer.decision', 20);
  if (!['accept', 'decline'].includes(decision)) {
    throw new PostgresCommandValidationError('Выберите: подтвердить или отказаться от даты.');
  }
  return {
    applicationLegacyId: normalizeApplicationLegacyId(command?.applicationId),
    token: normalizeAssignmentOfferToken(command?.token),
    decision
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

function assignmentOfferExpiresAt(now) {
  return new Date(now.getTime() + ASSIGNMENT_OFFER_TTL_MS).toISOString();
}

function applicationTelegramTag(app) {
  const username = String(app?.telegram_username || app?.telegramUsername || '').trim();
  if (username) return username.startsWith('@') ? username : `@${username}`;
  const code = String(app?.telegram_code || app?.telegramCode || '').trim();
  if (code) return code.startsWith('@') ? code : `@${code.replace(/^@/, '')}`;
  const userId = String(
    app?.trainee_telegram_user_id
    || app?.trainee_telegram_chat_id
    || app?.telegramUserId
    || app?.telegramChatId
    || ''
  ).trim();
  return userId ? `ID ${userId}` : 'Telegram не указан';
}

function applicationSnapshotFromRow(row, overrides = {}) {
  return {
    id: Number(row.legacy_id),
    shiftId: row.shift_legacy_id ? Number(row.shift_legacy_id) : null,
    name: row.name || '',
    phone: row.phone || '',
    status: String(row.status || ''),
    telegramCode: row.telegram_code || '',
    telegramChatId: row.trainee_telegram_chat_id || row.trainee_telegram_user_id || '',
    telegramUserId: row.trainee_telegram_user_id || '',
    telegramUsername: row.telegram_username || '',
    groupLink: row.group_link || '',
    venueId: row.venue_id || null,
    recruiterQueueComment: row.recruiter_queue_comment || '',
    ...overrides
  };
}

function shiftSnapshotFromRow(row, prefix = 'shift_') {
  return {
    id: Number(row[`${prefix}legacy_id`]),
    date: shiftDateAsString(row[`${prefix}date`]),
    seats: Number(row[`${prefix}seats`] || row.seats || 0),
    open: Boolean(row[`${prefix}open`]),
    canceled: Boolean(row[`${prefix}canceled`])
  };
}

function assignmentOfferSnapshotFromRow(row) {
  return {
    token: row.token,
    shiftId: Number(row.offer_shift_legacy_id || row.shift_legacy_id),
    requestedAt: shiftUpdatedAtAsString(row.requested_at),
    expiresAt: shiftUpdatedAtAsString(row.expires_at),
    requestedByTelegramUserId: row.requested_by_telegram_user_id || '',
    messageChatId: row.message_chat_id || '',
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id)
  };
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

function composeMentorResultNotificationText({ result }) {
  const passed = result.decision === 'Стажировка пройдена';
  const decisionLine = passed ? '🟢 Стажировка пройдена.' : '🔴 Стажировка не пройдена.';
  const topics = result.topicsToRepeat
    .map(topic => `• ${topic.order}. ${escapeTelegramHtml(topic.title)}`);
  const lines = [
    '📋 <b>Итоги стажировки</b>',
    '',
    `Дата: ${escapeTelegramHtml(displayShiftDate(result.date))}`,
    `Площадка: ${escapeTelegramHtml(result.venue || '—')}`,
    '',
    `Освоено: ${result.mastered} из ${result.total} тем.`,
    ''
  ];

  if (topics.length) {
    lines.push('📚 <b>Темы для повторения</b>', '', ...topics);
  } else if (passed) {
    lines.push('🎉 Поздравляем! Все темы успешно освоены.');
  } else {
    lines.push('📚 Темы для повторения не указаны наставником.');
  }

  lines.push('', '━━━━━━━━━━━━━━━', '', decisionLine);
  return lines.join('\n').trim();
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

function mentorResultNotificationRow({ app, mentorReportId, result, nextStatus, nowIso }) {
  const chatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'mentor_report_result',
    applicationLegacyId: Number(app.legacy_id),
    nextStatus,
    mentorReportId
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    mentorReportId,
    type: 'mentor_result',
    chatId: chatId || null,
    chatTarget: 'trainee',
    text: composeMentorResultNotificationText({ result }),
    parseMode: 'HTML',
    status,
    error: status === 'skipped' ? 'telegram_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function mentorReportGroupNotificationRow({ app, mentorReportId, reportText, reportChatId, nowIso }) {
  const chatId = String(reportChatId || '').trim();
  const notificationKey = stableNotificationKey({
    action: 'mentor_report_group',
    applicationLegacyId: Number(app.legacy_id),
    mentorReportId
  });
  const status = chatId ? 'pending' : 'skipped';
  return {
    id: randomUUID(),
    applicationId: app.id,
    mentorReportId,
    type: 'mentor_report',
    chatId: chatId || null,
    chatTarget: 'mentor_report_group',
    text: reportText,
    parseMode: null,
    status,
    error: status === 'skipped' ? 'mentor_report_chat_missing' : null,
    idempotencyKey: notificationKey,
    nextAttemptAt: status === 'pending' ? nowIso : null,
    createdAt: nowIso,
    updatedAt: nowIso
  };
}

function traineeReportChecksum(reportText) {
  return createHash('sha256')
    .update(reportText)
    .digest('hex')
    .slice(0, 32);
}

function traineeReportNotificationRow({ actor, reportText, reportChatId, nowIso }) {
  const telegramUserId = actorTelegramUserId(actor);
  const reportChecksum = traineeReportChecksum(reportText);
  const notificationKey = `trainee_report_submission:${telegramUserId}:${reportChecksum}`;
  return {
    id: randomUUID(),
    applicationId: null,
    mentorReportId: null,
    type: 'trainee_report',
    chatId: reportChatId,
    chatTarget: 'trainee_report_group',
    text: reportText,
    parseMode: null,
    status: 'pending',
    error: null,
    idempotencyKey: notificationKey,
    reportChecksum,
    nextAttemptAt: nowIso,
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
          id, application_id, mentor_report_id, type, chat_id, chat_target, text, parse_mode,
          status, error, idempotency_key, next_attempt_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (idempotency_key) DO NOTHING
      `,
      [
        row.id,
        row.applicationId,
        row.mentorReportId || null,
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

async function countShiftSeatUsageInPostgres(client, {
  shiftUuid,
  excludedApplicationUuid = null,
  now = new Date()
}) {
  const result = await client.query(
    `
      SELECT
        (
          SELECT COUNT(*)::int
            FROM applications
           WHERE shift_id = $1
             AND status = ANY($2::text[])
             AND ($3::uuid IS NULL OR id <> $3::uuid)
        ) AS assigned,
        (
          SELECT COUNT(*)::int
            FROM application_assignment_offers
            JOIN applications
              ON applications.id = application_assignment_offers.application_id
           WHERE application_assignment_offers.shift_id = $1
             AND application_assignment_offers.status = 'active'
             AND application_assignment_offers.expires_at > $4::timestamptz
             AND ($3::uuid IS NULL OR application_assignment_offers.application_id <> $3::uuid)
        ) AS offered
    `,
    [
      shiftUuid,
      SEAT_HOLDING_STATUS_VALUES,
      excludedApplicationUuid,
      now.toISOString()
    ]
  );
  const row = result.rows[0] || {};
  return (Number(row.assigned) || 0) + (Number(row.offered) || 0);
}

async function cancelActiveAssignmentOffers(client, { applicationUuid, nowIso }) {
  await client.query(
    `UPDATE application_assignment_offers
        SET status = 'canceled',
            updated_at = $1
      WHERE application_id = $2
        AND status = 'active'`,
    [nowIso, applicationUuid]
  );
}

export async function upsertTraineeApplicationInPostgres({
  pool,
  actor,
  command,
  now = new Date()
}) {
  requireTrainee(actor);
  let application = normalizeTraineeApplicationInput(command, actor);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (application.baseVersion !== meta.version) throw new PostgresCommandConflictError();

    let shift = null;
    if (application.shiftLegacyId !== null) {
      const shiftResult = await client.query(
        `SELECT id, legacy_id, seats, open, canceled, date::text AS date
           FROM shifts
          WHERE legacy_id = $1
          FOR UPDATE`,
        [application.shiftLegacyId]
      );
      if (shiftResult.rowCount !== 1) {
        throw new PostgresCommandValidationError('application.shiftId references an unknown shift.');
      }
      shift = shiftResult.rows[0];
      if (shift.canceled) {
        throw new PostgresCommandValidationError('trainee cannot book a canceled shift.');
      }
      if (!shift.open) {
        throw new PostgresCommandValidationError('trainee cannot book a closed shift.');
      }

      const usageResult = await client.query(
        `SELECT COUNT(*)::int AS used
           FROM applications
          WHERE shift_id = $1
            AND status = ANY($2::text[])
            AND legacy_id <> $3`,
        [shift.id, SEAT_HOLDING_STATUS_VALUES, application.applicationLegacyId]
      );
      const usedSeats = Number(usageResult.rows[0]?.used || 0);
      const seats = Number(shift.seats) || 0;
      if (usedSeats >= seats) {
        throw new PostgresCommandValidationError('На выбранную дату больше нет свободных мест.');
      }
    }

    const existingResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              shifts.legacy_id AS shift_legacy_id,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.telegram_code,
              applications.name,
              applications.phone,
              applications.training,
              applications.training_date::text AS training_date,
              applications.attempt,
              applications.limits,
              applications.recruiter_comment,
              applications.recruiter_queue_comment
         FROM applications
         LEFT JOIN shifts ON shifts.id = applications.shift_id
        WHERE applications.legacy_id = $1
        FOR UPDATE OF applications`,
      [application.applicationLegacyId]
    );

    const existing = existingResult.rowCount === 1 ? existingResult.rows[0] : null;
    if (existing) {
      if (!applicationRowBelongsToTrainee(existing, actor)) {
        throw new PostgresCommandAuthorizationError('Нельзя изменить чужую заявку.');
      }
      if (!TRAINEE_MUTABLE_STATUSES.has(String(existing.status || ''))) {
        throw new PostgresCommandValidationError('application cannot be changed in current status.');
      }
    } else {
      const ownApplicationsResult = await client.query(
        `SELECT legacy_id, status
           FROM applications
          WHERE trainee_telegram_user_id = $1
             OR trainee_telegram_chat_id = $1
          ORDER BY legacy_id DESC
          FOR UPDATE`,
        [application.telegramUserId]
      );
      const ownApplications = ownApplicationsResult.rows || [];
      const activeApplication = ownApplications.find(row =>
        ACTIVE_TRAINEE_APPLICATION_STATUSES.has(String(row.status || ''))
      );
      if (activeApplication) {
        throw new PostgresCommandValidationError('У вас уже есть активная заявка на стажировку.');
      }
      const latestApplication = ownApplications[0] || null;
      const latestStatus = String(latestApplication?.status || '');
      if (latestApplication) {
        if (TRAINEE_REAPPLY_SOURCE_STATUSES.has(latestStatus)) {
          application = { ...application, attempt: 'repeat' };
        } else if (!TRAINEE_QUEUE_REJOIN_SOURCE_STATUSES.has(latestStatus)) {
          throw new PostgresCommandValidationError(
            'Повторная запись доступна только после завершенной неудачной попытки.'
          );
        }
      }
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const shiftUuid = shift?.id ?? null;
    const trainingDate = application.trainingDate || null;
    const eventRows = [];

    if (!existing) {
      const applicationId = randomUUID();
      await client.query(
        `INSERT INTO applications (
            id, legacy_id, shift_id, invite_group_id,
            trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username, telegram_code,
            name, phone, training, training_date, attempt, limits, status,
            recruiter_comment, recruiter_queue_comment,
            venue_id, group_link, candidate_report, experience,
            mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
            mentor_decision, mentor_report_venue_id, mentor_report_venue,
            mentor_report_loft, mentor_report_hall, mentor_comment_for_trainee,
            mentor_comment_sent_at, mentor_comment_delivery_status, mentor_comment_delivery_error,
            created_at, updated_at
          )
          VALUES (
            $1, $2, $3, NULL,
            $4, $5, $6, $7,
            $8, $9, $10, $11::date, $12, $13, $14,
            $15, '',
            NULL, '', false, NULL,
            false, NULL, NULL,
            '', '', '',
            '', '', '',
            NULL, NULL, '',
            $16, $16
          )`,
        [
          applicationId,
          application.applicationLegacyId,
          shiftUuid,
          application.telegramUserId,
          application.telegramChatId,
          application.telegramUsername,
          application.telegramCode,
          application.name,
          application.phone,
          application.training,
          trainingDate,
          application.attempt,
          application.limits,
          application.status,
          application.comment,
          nowIso
        ]
      );

      eventRows.push({
        eventType: 'application_created',
        applicationId: application.applicationLegacyId,
        shiftId: application.shiftLegacyId,
        actorType: 'trainee',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'upsert_trainee_application',
          baseVersion: application.baseVersion,
          previousVersion: meta.version,
          nextVersion,
          application: compactApplicationPayload(application)
        },
        createdAt: nowIso
      });
    } else {
      const previous = {
        name: existing.name ?? '',
        phone: existing.phone ?? '',
        training: existing.training ?? '',
        trainingDate: shiftDateAsString(existing.training_date),
        attempt: existing.attempt ?? '',
        limits: existing.limits ?? '',
        telegramCode: existing.telegram_code ?? '',
        telegramChatId: existing.trainee_telegram_chat_id ?? '',
        telegramUserId: existing.trainee_telegram_user_id ?? '',
        telegramUsername: existing.telegram_username ?? ''
      };
      const next = {
        name: application.name,
        phone: application.phone,
        training: application.training,
        trainingDate: application.trainingDate,
        attempt: application.attempt,
        limits: application.limits,
        telegramCode: application.telegramCode,
        telegramChatId: application.telegramChatId,
        telegramUserId: application.telegramUserId,
        telegramUsername: application.telegramUsername
      };
      const previousStatus = String(existing.status || '');
      const previousShiftLegacyId = existing.shift_legacy_id ? Number(existing.shift_legacy_id) : null;

      await client.query(
        `UPDATE applications
            SET shift_id = $1,
                invite_group_id = NULL,
                trainee_telegram_user_id = $2,
                trainee_telegram_chat_id = $3,
                telegram_username = $4,
                telegram_code = $5,
                name = $6,
                phone = $7,
                training = $8,
                training_date = $9::date,
                attempt = $10,
                limits = $11,
                status = $12,
                recruiter_comment = $13,
                recruiter_queue_comment = CASE WHEN $12 = 'queue' THEN recruiter_queue_comment ELSE '' END,
                venue_id = NULL,
                group_link = '',
                candidate_report = false,
                experience = NULL,
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
                updated_at = $14,
                row_version = row_version + 1
          WHERE id = $15`,
        [
          shiftUuid,
          application.telegramUserId,
          application.telegramChatId,
          application.telegramUsername,
          application.telegramCode,
          application.name,
          application.phone,
          application.training,
          trainingDate,
          application.attempt,
          application.limits,
          application.status,
          application.comment,
          nowIso,
          existing.id
        ]
      );

      if (previousStatus !== application.status) {
        eventRows.push({
          eventType: application.status === 'queue' ? 'application_returned_to_queue' : 'application_status_changed',
          applicationId: application.applicationLegacyId,
          shiftId: application.shiftLegacyId,
          actorType: 'trainee',
          actorTelegramUserId: actorTelegramUserId(actor),
          payload: {
            action: 'upsert_trainee_application',
            baseVersion: application.baseVersion,
            previousVersion: meta.version,
            nextVersion,
            previousStatus,
            nextStatus: application.status,
            previousShiftId: previousShiftLegacyId,
            nextShiftId: application.shiftLegacyId
          },
          createdAt: nowIso
        });
      }

      const changedFields = changedTraineeProfileFields(previous, next);
      if (changedFields.length) {
        eventRows.push({
          eventType: 'application_updated',
          applicationId: application.applicationLegacyId,
          shiftId: application.shiftLegacyId,
          actorType: 'trainee',
          actorTelegramUserId: actorTelegramUserId(actor),
          payload: {
            action: 'upsert_trainee_application',
            baseVersion: application.baseVersion,
            previousVersion: meta.version,
            nextVersion,
            changedFields
          },
          createdAt: nowIso
        });
      }

      if (previousShiftLegacyId !== application.shiftLegacyId && application.shiftLegacyId !== null) {
        eventRows.push({
          eventType: 'application_assigned_to_shift',
          applicationId: application.applicationLegacyId,
          shiftId: application.shiftLegacyId,
          actorType: 'trainee',
          actorTelegramUserId: actorTelegramUserId(actor),
          payload: {
            action: 'upsert_trainee_application',
            baseVersion: application.baseVersion,
            previousVersion: meta.version,
            nextVersion,
            previousShiftId: previousShiftLegacyId,
            nextShiftId: application.shiftLegacyId,
            date: shift?.date ?? null
          },
          createdAt: nowIso
        });
      }
    }

    await insertApplicationEvents(client, eventRows);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId: application.applicationLegacyId,
      previousStatus: existing ? String(existing.status || '') : null,
      nextStatus: application.status,
      previousShiftId: existing?.shift_legacy_id ? Number(existing.shift_legacy_id) : null,
      shiftLegacyId: application.shiftLegacyId,
      created: !existing,
      updated: Boolean(existing),
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function cancelApplicationInPostgres({ pool, actor, command, now = new Date() }) {
  if (!['trainee', 'recruiter'].includes(String(actor?.role || ''))) {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для отмены заявки.');
  }
  const { applicationLegacyId, baseVersion } = normalizeCancelApplicationInput(command);

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
              applications.group_link,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.name,
              applications.mentor_report_received
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
    if (actor.role === 'trainee' && !applicationRowBelongsToTrainee(app, actor)) {
      throw new PostgresCommandAuthorizationError('Нельзя отменить чужую заявку.');
    }

    const previousStatus = String(app.status || '');
    if (!CANCEL_APPLICATION_STATUSES.has(previousStatus)) {
      throw new PostgresCommandValidationError(
        'application cannot be canceled in current status.'
      );
    }
    if (app.invite_group_id || String(app.group_link || '').trim()) {
      throw new PostgresCommandValidationError(
        'application with invite group must be canceled by cancel_internship.'
      );
    }
    if (app.mentor_report_received) {
      throw new PostgresCommandValidationError(
        'application with mentor report cannot be deleted by cancel_application.'
      );
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const shiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;

    await insertApplicationEvents(client, [{
      eventType: 'application_cancelled',
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: actor.role === 'recruiter' ? 'recruiter' : 'trainee',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'cancel_application',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        previousStatus,
        previousShiftId: shiftLegacyId
      },
      createdAt: nowIso
    }]);

    await client.query(
      'DELETE FROM applications WHERE id = $1',
      [app.id]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      applicationId: app.id,
      previousStatus,
      previousShiftId: shiftLegacyId,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function linkTelegramApplicationInPostgres({ pool, actor, command, now = new Date() }) {
  requireTelegramApplicationLinkActor(actor);
  const { applicationLegacyId } = normalizeLinkTelegramInput(command);
  const telegramUserId = actorTelegramUserId(actor);
  if (!telegramUserId) {
    throw new PostgresCommandAuthorizationError('Не удалось определить Telegram ID.');
  }
  const telegramUsername = normalizeUsername(actorTelegramUsername(actor));

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    const appResult = await client.query(
      `SELECT id,
              legacy_id,
              trainee_telegram_user_id,
              trainee_telegram_chat_id,
              telegram_username
         FROM applications
        WHERE legacy_id = $1
        FOR UPDATE`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandNotFoundError('application_not_found');
    }

    const app = appResult.rows[0];
    const existingOwner = String(app.trainee_telegram_user_id || app.trainee_telegram_chat_id || '').trim();
    if (existingOwner && existingOwner !== telegramUserId) {
      throw new PostgresCommandAuthorizationError('application_owner_mismatch');
    }

    const previousTelegramUserId = String(app.trainee_telegram_user_id || '').trim();
    const previousTelegramChatId = String(app.trainee_telegram_chat_id || '').trim();
    const previousTelegramUsername = String(app.telegram_username || '').trim();
    const changed = (
      previousTelegramUserId !== telegramUserId
      || previousTelegramChatId !== telegramUserId
      || previousTelegramUsername !== telegramUsername
    );

    if (!changed) {
      return {
        applicationLegacyId,
        changed: false,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        telegramUserId,
        telegramChatId: telegramUserId,
        telegramUsername
      };
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;

    await client.query(
      `UPDATE applications
          SET trainee_telegram_user_id = $1,
              trainee_telegram_chat_id = $2,
              telegram_username = $3,
              updated_at = $4,
              row_version = row_version + 1
        WHERE id = $5`,
      [telegramUserId, telegramUserId, telegramUsername, nowIso, app.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'telegram_application_linked',
      applicationId: applicationLegacyId,
      shiftId: null,
      actorType: actor.role === 'recruiter' ? 'recruiter' : 'trainee',
      actorTelegramUserId: telegramUserId,
      payload: {
        action: 'link_telegram_application',
        previousVersion: meta.version,
        nextVersion,
        hadPreviousOwner: Boolean(existingOwner),
        previousTelegramUsername,
        nextTelegramUsername: telegramUsername
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      changed: true,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      telegramUserId,
      telegramChatId: telegramUserId,
      telegramUsername
    };
  });
}

export async function clearStateInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { baseVersion } = normalizeStateAdminInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const removed = await clearBookingStateRows(client);

    await insertApplicationEvents(client, [{
      eventType: 'booking_state_cleared',
      applicationId: null,
      shiftId: null,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'clear_state',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        removed
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      removed
    };
  });
}

export async function resetDemoStateInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { baseVersion } = normalizeStateAdminInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const removed = await clearBookingStateRows(client);
    const demoState = seedPostgresDemoBookingState(now);
    const plan = buildBookingImportPlan(demoState, now);
    await insertPlannedDemoRows(client, plan);

    const inserted = {
      shifts: plan.shifts.length,
      applications: plan.applications.length,
      inviteGroups: plan.inviteGroups.length
    };

    await insertApplicationEvents(client, [{
      eventType: 'booking_state_reset',
      applicationId: null,
      shiftId: null,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'reset_demo_state',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        removed,
        inserted
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      removed,
      inserted
    };
  });
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

export async function toggleShiftInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { shiftLegacyId, requestedOpen, baseVersion } = normalizeToggleShiftInput(command);

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
    const previousOpen = Boolean(shift.open);
    const nextOpen = requestedOpen === null ? !previousOpen : requestedOpen;
    const date = shiftDateAsString(shift.date);
    const nowIso = now.toISOString();

    if (previousOpen === nextOpen) {
      return {
        shiftLegacyId,
        previousOpen,
        open: nextOpen,
        canceled: Boolean(shift.canceled),
        date,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nextVersion = meta.version + 1;
    await client.query(
      `UPDATE shifts
          SET open = $1,
              canceled = CASE WHEN $1 THEN false ELSE canceled END,
              canceled_at = CASE WHEN $1 THEN NULL ELSE canceled_at END,
              updated_at = $2,
              row_version = row_version + 1
        WHERE id = $3`,
      [nextOpen, nowIso, shift.id]
    );

    await insertApplicationEvents(client, [{
      eventType: nextOpen ? 'shift_opened' : 'shift_closed',
      applicationId: null,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'toggle_shift',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        date,
        previousOpen,
        nextOpen
      },
      createdAt: nowIso
    }]);

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      shiftLegacyId,
      previousOpen,
      open: nextOpen,
      canceled: nextOpen ? false : Boolean(shift.canceled),
      date,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
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
                recruiter_queue_comment = '',
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
      await client.query(
        `UPDATE application_assignment_offers
            SET status = 'canceled',
                updated_at = $1
          WHERE application_id = ANY($2::uuid[])
            AND status = 'active'`,
        [nowIso, affectedUuids]
      );
    }

    await client.query(
      `UPDATE application_assignment_offers
          SET status = 'unavailable',
              updated_at = $1
        WHERE shift_id = $2
          AND status = 'active'`,
      [nowIso, shift.id]
    );

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

    const usedSeats = await countShiftSeatUsageInPostgres(client, {
      shiftUuid: shift.id,
      now
    });
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

export async function updateQueueCommentInPostgres({ pool, actor, command, now = new Date() }) {
  requireRecruiter(actor);
  const { applicationLegacyId, comment, baseVersion } = normalizeUpdateQueueCommentInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT id, legacy_id, status, recruiter_queue_comment
         FROM applications
        WHERE legacy_id = $1
        FOR UPDATE`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    if (String(app.status || '') !== 'queue') {
      throw new PostgresCommandValidationError('Комментарий можно сохранить только для очереди.');
    }

    const previousComment = String(app.recruiter_queue_comment || '');
    if (previousComment === comment) {
      return {
        applicationLegacyId,
        applicationId: app.id,
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

    await client.query(
      `UPDATE applications
          SET recruiter_queue_comment = $1,
              updated_at = $2,
              row_version = row_version + 1
        WHERE id = $3`,
      [comment, nowIso, app.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'application_queue_comment_updated',
      applicationId: applicationLegacyId,
      shiftId: null,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'update_queue_comment',
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
              recruiter_queue_comment = CASE WHEN $1 = 'queue' THEN recruiter_queue_comment ELSE '' END,
              updated_at = $3,
              row_version = row_version + 1
        WHERE id = $4`,
      [nextStatus, nextExperience, nowIso, app.id]
    );
    if (nextStatus !== 'queue') {
      await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });
    }

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

export async function mentorReportResultInPostgres({
  pool,
  actor,
  command,
  reportChatId = '',
  now = new Date()
}) {
  requireMentor(actor);
  const {
    applicationLegacyId,
    mentorTraineeName,
    mentorDecision,
    mentorCommentForTrainee,
    reportText,
    mentorTraineeResult,
    nextStatus
  } = normalizeMentorReportInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
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
              applications.name,
              applications.mentor_report_received
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

    const activeReportResult = await client.query(
      `SELECT id
         FROM mentor_reports
        WHERE application_id = $1
          AND voided_at IS NULL
        FOR UPDATE`,
      [app.id]
    );
    if (activeReportResult.rowCount > 0) {
      throw new PostgresCommandConflictError('Отчёт по этому стажёру уже отправлен.');
    }
    if (!applicationRowCanReceiveMentorReport(app)) {
      throw new PostgresCommandValidationError('application cannot receive mentor report.');
    }
    ensureMentorReportTargetMatchesRow(app, mentorTraineeName);
    ensureMentorReportVenueMatchesRow(app, mentorTraineeResult);

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const mentorReportId = randomUUID();
    const shiftLegacyId = app.shift_legacy_id ? Number(app.shift_legacy_id) : null;
    const traineeMessageText = composeMentorResultNotificationText({ result: mentorTraineeResult });
    const mentorUsername = actorTelegramUsername(actor);
    const mentorName = actorTelegramName(actor);

    await client.query(
      `INSERT INTO mentor_reports (
          id, application_id, mentor_telegram_user_id, mentor_username, mentor_name,
          result_status, decision, mastered, total,
          venue_id, venue_label, venue_loft, hall,
          mentor_comment, trainee_message_text, report_text, source, created_at
        )
        VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, $13,
          $14, $15, $16, 'api_report', $17
        )`,
      [
        mentorReportId,
        app.id,
        actorTelegramUserId(actor),
        mentorUsername,
        mentorName,
        nextStatus,
        mentorDecision,
        mentorTraineeResult.mastered,
        mentorTraineeResult.total,
        mentorTraineeResult.venueId,
        mentorTraineeResult.venue,
        mentorTraineeResult.venueLoft,
        mentorTraineeResult.hall,
        mentorCommentForTrainee,
        traineeMessageText,
        reportText,
        nowIso
      ]
    );

    for (const topic of mentorTraineeResult.topicsToRepeat) {
      await client.query(
        `INSERT INTO mentor_report_topics (
            id, mentor_report_id, topic_order, title, created_at
          )
          VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), mentorReportId, topic.order, topic.title, nowIso]
      );
    }

    const traineeNotificationRow = mentorResultNotificationRow({
      app,
      mentorReportId,
      result: mentorTraineeResult,
      nextStatus,
      nowIso
    });
    const reportGroupNotificationRow = mentorReportGroupNotificationRow({
      app,
      mentorReportId,
      reportText,
      reportChatId,
      nowIso
    });
    const notificationRows = [traineeNotificationRow, reportGroupNotificationRow];
    const mentorCommentDeliveryStatus = MENTOR_COMMENT_DELIVERY_STATUSES.has(traineeNotificationRow.status)
      ? traineeNotificationRow.status
      : null;
    const mentorCommentDeliveryError = traineeNotificationRow.status === 'skipped'
      ? traineeNotificationRow.error || ''
      : '';

    await client.query(
      `UPDATE applications
          SET status = $1,
              mentor_report_received = true,
              mentor_report_at = $2,
              mentor_reporter_telegram_user_id = $3,
              mentor_decision = $4,
              mentor_report_venue_id = $5,
              mentor_report_venue = $6,
              mentor_report_loft = $7,
              mentor_report_hall = $8,
              mentor_comment_for_trainee = $9,
              mentor_comment_sent_at = NULL,
              mentor_comment_delivery_status = $10,
              mentor_comment_delivery_error = $11,
              updated_at = $2,
              row_version = row_version + 1
        WHERE id = $12`,
      [
        nextStatus,
        nowIso,
        actorTelegramUserId(actor),
        mentorDecision,
        mentorTraineeResult.venueId,
        mentorTraineeResult.venue,
        mentorTraineeResult.venueLoft,
        mentorTraineeResult.hall,
        mentorCommentForTrainee,
        mentorCommentDeliveryStatus,
        mentorCommentDeliveryError,
        app.id
      ]
    );

    const notificationResult = await insertNotifications(client, notificationRows);

    let shiftAutoClosed = false;
    let shiftDateText = app.shift_date || '';
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

    const events = [
      {
        eventType: 'mentor_report_received',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'mentor',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          mentorReportId,
          previousStatus,
          nextStatus,
          mentorDecision,
          venueId: mentorTraineeResult.venueId,
          hall: mentorTraineeResult.hall,
          mastered: mentorTraineeResult.mastered,
          total: mentorTraineeResult.total,
          topicCount: mentorTraineeResult.topicsToRepeat.length
        },
        createdAt: nowIso
      },
      {
        eventType: MENTOR_RESULT_STATUS_EVENTS[nextStatus],
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'mentor',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          previousStatus,
          nextStatus,
          mentorReportId
        },
        createdAt: nowIso
      }
    ];
    if (traineeNotificationRow.status === 'pending') {
      events.push({
        eventType: 'mentor_result_notification_queued',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'system',
        actorTelegramUserId: null,
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          mentorReportId,
          idempotencyKey: traineeNotificationRow.idempotencyKey
        },
        createdAt: nowIso
      });
    }
    if (traineeNotificationRow.status === 'skipped') {
      events.push({
        eventType: 'mentor_result_notification_skipped',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'system',
        actorTelegramUserId: null,
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          mentorReportId,
          reason: traineeNotificationRow.error || 'telegram_chat_missing'
        },
        createdAt: nowIso
      });
    }
    if (reportGroupNotificationRow.status === 'pending') {
      events.push({
        eventType: 'mentor_report_group_notification_queued',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'system',
        actorTelegramUserId: null,
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          mentorReportId,
          idempotencyKey: reportGroupNotificationRow.idempotencyKey
        },
        createdAt: nowIso
      });
    }
    if (reportGroupNotificationRow.status === 'skipped') {
      events.push({
        eventType: 'mentor_report_group_notification_skipped',
        applicationId: applicationLegacyId,
        shiftId: shiftLegacyId,
        actorType: 'system',
        actorTelegramUserId: null,
        payload: {
          action: 'mentor_report_result',
          previousVersion: meta.version,
          nextVersion,
          mentorReportId,
          reason: reportGroupNotificationRow.error || 'mentor_report_chat_missing'
        },
        createdAt: nowIso
      });
    }
    if (shiftAutoClosed) {
      events.push({
        eventType: 'shift_auto_closed',
        applicationId: null,
        shiftId: shiftLegacyId,
        actorType: 'system',
        actorTelegramUserId: null,
        payload: {
          action: 'mentor_report_result',
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
      mentorReportId,
      previousStatus,
      nextStatus,
      shiftLegacyId,
      shiftDate: shiftDateText,
      shiftAutoClosed,
      mentorCommentDeliveryStatus: mentorCommentDeliveryStatus || '',
      mentorCommentDeliveryError,
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

export async function traineeReportSubmissionInPostgres({
  pool,
  actor,
  command,
  reportChatId = '',
  now = new Date()
}) {
  requireTrainee(actor);
  const telegramUserId = actorTelegramUserId(actor);
  if (!telegramUserId) {
    throw new PostgresCommandAuthorizationError('Не удалось определить Telegram ID стажёра.');
  }
  const { reportText } = normalizeTraineeReportInput(command);
  const normalizedReportChatId = normalizeReportChatId(reportChatId, 'traineeReportChatId');

  return runInPostgresTransaction(pool, async client => {
    const nowIso = now.toISOString();
    const notificationRow = traineeReportNotificationRow({
      actor,
      reportText,
      reportChatId: normalizedReportChatId,
      nowIso
    });
    const notificationResult = await insertNotifications(client, [notificationRow]);
    const inserted = notificationResult.inserted === 1;

    if (inserted) {
      await insertApplicationEvents(client, [{
        eventType: 'trainee_report_received',
        applicationId: null,
        shiftId: null,
        actorType: 'trainee',
        actorTelegramUserId: telegramUserId,
        payload: {
          action: 'trainee_report_submission',
          idempotencyKey: notificationRow.idempotencyKey,
          notificationId: notificationRow.id,
          notificationStatus: notificationRow.status,
          chatTarget: notificationRow.chatTarget,
          reportChecksum: notificationRow.reportChecksum,
          reportLength: reportText.length
        },
        createdAt: nowIso
      }]);
    }

    return {
      changed: inserted,
      duplicate: !inserted,
      idempotencyKey: notificationRow.idempotencyKey,
      reportChecksum: notificationRow.reportChecksum,
      notificationId: inserted ? notificationRow.id : null,
      notificationStatus: notificationRow.status,
      notifications: {
        total: 1,
        pending: inserted ? 1 : 0,
        skipped: 0,
        inserted: notificationResult.inserted
      },
      updatedAt: nowIso
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

    const usedSeats = await countShiftSeatUsageInPostgres(client, {
      shiftUuid: shift.id,
      excludedApplicationUuid: app.id,
      now
    });
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
              recruiter_queue_comment = '',
              updated_at = $3,
              row_version = row_version + 1
        WHERE id = $4`,
      [shift.id, nextStatus, nowIso, app.id]
    );
    await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });

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

export async function requestAssignmentConfirmationInPostgres({
  pool,
  actor,
  command,
  now = new Date()
}) {
  requireRecruiter(actor);
  const { applicationLegacyId, shiftLegacyId, baseVersion } =
    normalizeRequestAssignmentConfirmationInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    if (baseVersion !== meta.version) throw new PostgresCommandConflictError();

    const appResult = await client.query(
      `SELECT id,
              legacy_id,
              status,
              shift_id,
              trainee_telegram_user_id,
              trainee_telegram_chat_id,
              telegram_username,
              telegram_code,
              name,
              phone,
              recruiter_queue_comment
         FROM applications
        WHERE legacy_id = $1
        FOR UPDATE`,
      [applicationLegacyId]
    );
    if (appResult.rowCount !== 1) {
      throw new PostgresCommandValidationError('application not found.');
    }
    const app = appResult.rows[0];
    if (String(app.status || '') !== 'queue' || app.shift_id !== null) {
      throw new PostgresCommandValidationError(
        'Подтверждение даты можно запросить только у стажёра в очереди.'
      );
    }
    const traineeChatId = String(app.trainee_telegram_chat_id || app.trainee_telegram_user_id || '').trim();
    if (!traineeChatId) {
      throw new PostgresCommandValidationError(
        'У стажёра ещё не подключен Telegram. Сначала он должен открыть мини-приложение.'
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
    if (shift.canceled || !shift.open) {
      throw new PostgresCommandValidationError('Эта дата закрыта для записи.');
    }

    const usedSeats = await countShiftSeatUsageInPostgres(client, {
      shiftUuid: shift.id,
      excludedApplicationUuid: app.id,
      now
    });
    const seats = Number(shift.seats) || 0;
    if (usedSeats >= seats) {
      throw new PostgresCommandValidationError('На выбранную дату больше нет свободных мест.');
    }

    const nowIso = now.toISOString();
    const expiresAt = assignmentOfferExpiresAt(now);
    const nextVersion = meta.version + 1;
    const offerId = randomUUID();
    const token = randomUUID();

    await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });
    await client.query(
      `INSERT INTO application_assignment_offers (
          id, application_id, shift_id, token, status, requested_by_telegram_user_id,
          requested_at, expires_at, message_chat_id, message_id, responded_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, NULL, NULL, NULL, $6, $6)`,
      [
        offerId,
        app.id,
        shift.id,
        token,
        actorTelegramUserId(actor) || '',
        nowIso,
        expiresAt
      ]
    );
    await client.query(
      `UPDATE applications
          SET updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, app.id]
    );

    await insertApplicationEvents(client, [{
      eventType: 'assignment_offer_requested',
      applicationId: applicationLegacyId,
      shiftId: shiftLegacyId,
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'request_assignment_confirmation',
        baseVersion,
        previousVersion: meta.version,
        nextVersion,
        expiresAt,
        trainee: applicationTelegramTag(app)
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
      shiftId: shift.id,
      previousStatus: 'queue',
      nextStatus: 'queue',
      assignmentOffer: {
        token,
        shiftId: shiftLegacyId,
        requestedAt: nowIso,
        expiresAt,
        requestedByTelegramUserId: actorTelegramUserId(actor) || '',
        messageChatId: '',
        messageId: null
      },
      shift: {
        id: shiftLegacyId,
        date: shiftDateAsString(shift.date),
        seats,
        open: Boolean(shift.open),
        canceled: Boolean(shift.canceled)
      },
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function recordAssignmentOfferMessageInPostgres({
  pool,
  actor,
  command,
  now = new Date()
}) {
  requireRecruiter(actor);
  const { applicationLegacyId, token, messageChatId, messageId } =
    normalizeRecordAssignmentOfferMessageInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    const offerResult = await client.query(
      `SELECT application_assignment_offers.id,
              application_assignment_offers.message_chat_id,
              application_assignment_offers.message_id,
              applications.id AS application_id,
              shifts.legacy_id AS shift_legacy_id
         FROM application_assignment_offers
         JOIN applications ON applications.id = application_assignment_offers.application_id
         JOIN shifts ON shifts.id = application_assignment_offers.shift_id
        WHERE applications.legacy_id = $1
          AND application_assignment_offers.token = $2
          AND application_assignment_offers.status = 'active'
        FOR UPDATE OF application_assignment_offers`,
      [applicationLegacyId, token]
    );
    if (offerResult.rowCount !== 1) {
      return {
        applicationLegacyId,
        token,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }
    const offer = offerResult.rows[0];
    const previousChatId = String(offer.message_chat_id || '');
    const previousMessageId = offer.message_id === null || offer.message_id === undefined
      ? null
      : Number(offer.message_id);
    if (previousChatId === messageChatId && previousMessageId === messageId) {
      return {
        applicationLegacyId,
        token,
        messageChatId,
        messageId,
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    await client.query(
      `UPDATE application_assignment_offers
          SET message_chat_id = $1,
              message_id = $2,
              updated_at = $3
        WHERE id = $4`,
      [messageChatId, messageId, nowIso, offer.id]
    );
    await insertApplicationEvents(client, [{
      eventType: 'assignment_offer_message_recorded',
      applicationId: applicationLegacyId,
      shiftId: Number(offer.shift_legacy_id),
      actorType: 'recruiter',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'record_assignment_offer_message',
        previousVersion: meta.version,
        nextVersion,
        messageChatId,
        messageId
      },
      createdAt: nowIso
    }]);
    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      applicationLegacyId,
      token,
      messageChatId,
      messageId,
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function respondAssignmentOfferInPostgres({
  pool,
  actor,
  command,
  now = new Date()
}) {
  requireTrainee(actor);
  const { applicationLegacyId, token, decision } = normalizeRespondAssignmentOfferInput(command);

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    const offerResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.telegram_code,
              applications.name,
              applications.phone,
              applications.recruiter_queue_comment,
              applications.venue_id,
              applications.group_link,
              application_assignment_offers.id AS offer_id,
              application_assignment_offers.token,
              application_assignment_offers.requested_at,
              application_assignment_offers.expires_at,
              application_assignment_offers.requested_by_telegram_user_id,
              application_assignment_offers.message_chat_id,
              application_assignment_offers.message_id,
              shifts.id AS offer_shift_id,
              shifts.legacy_id AS offer_shift_legacy_id,
              shifts.date::text AS offer_shift_date,
              shifts.seats AS offer_shift_seats,
              shifts.open AS offer_shift_open,
              shifts.canceled AS offer_shift_canceled
         FROM application_assignment_offers
         JOIN applications ON applications.id = application_assignment_offers.application_id
         JOIN shifts ON shifts.id = application_assignment_offers.shift_id
        WHERE applications.legacy_id = $1
          AND application_assignment_offers.token = $2
          AND application_assignment_offers.status = 'active'
        FOR UPDATE OF applications, application_assignment_offers, shifts`,
      [applicationLegacyId, token]
    );
    if (offerResult.rowCount !== 1) {
      throw new PostgresCommandValidationError(
        'Этот запрос уже неактуален. Откройте последнее сообщение от рекрута.'
      );
    }
    const row = offerResult.rows[0];
    if (!applicationRowBelongsToTrainee(row, actor)) {
      throw new PostgresCommandAuthorizationError('Эта заявка принадлежит другому Telegram-аккаунту.');
    }
    if (String(row.status || '') !== 'queue') {
      throw new PostgresCommandValidationError(
        'Этот запрос уже неактуален. Откройте последнее сообщение от рекрута.'
      );
    }

    const nowIso = now.toISOString();
    const nextVersion = meta.version + 1;
    const previousOffer = assignmentOfferSnapshotFromRow(row);
    const shift = shiftSnapshotFromRow(row, 'offer_shift_');
    const expired = new Date(row.expires_at).getTime() <= now.getTime();
    let resultStatus = '';

    if (expired) {
      resultStatus = 'expired';
      await client.query(
        `UPDATE applications
            SET status = 'queue_expired',
                recruiter_queue_comment = '',
                updated_at = $1,
                row_version = row_version + 1
          WHERE id = $2`,
        [nowIso, row.id]
      );
      await client.query(
        `UPDATE application_assignment_offers
            SET status = 'expired',
                responded_at = $1,
                updated_at = $1
          WHERE id = $2`,
        [nowIso, row.offer_id]
      );
    } else if (decision === 'decline') {
      resultStatus = 'declined';
      await client.query(
        `UPDATE application_assignment_offers
            SET status = 'declined',
                responded_at = $1,
                updated_at = $1
          WHERE id = $2`,
        [nowIso, row.offer_id]
      );
      await client.query(
        `UPDATE applications
            SET updated_at = $1,
                row_version = row_version + 1
          WHERE id = $2`,
        [nowIso, row.id]
      );
    } else if (row.offer_shift_canceled || !row.offer_shift_open) {
      resultStatus = 'unavailable';
      await client.query(
        `UPDATE application_assignment_offers
            SET status = 'unavailable',
                responded_at = $1,
                updated_at = $1
          WHERE id = $2`,
        [nowIso, row.offer_id]
      );
      await client.query(
        `UPDATE applications
            SET updated_at = $1,
                row_version = row_version + 1
          WHERE id = $2`,
        [nowIso, row.id]
      );
    } else {
      const usedSeats = await countShiftSeatUsageInPostgres(client, {
        shiftUuid: row.offer_shift_id,
        excludedApplicationUuid: row.id,
        now
      });
      const seats = Number(row.offer_shift_seats) || 0;
      if (usedSeats >= seats) {
        resultStatus = 'unavailable';
        await client.query(
          `UPDATE application_assignment_offers
              SET status = 'unavailable',
                  responded_at = $1,
                  updated_at = $1
            WHERE id = $2`,
          [nowIso, row.offer_id]
        );
        await client.query(
          `UPDATE applications
              SET updated_at = $1,
                  row_version = row_version + 1
            WHERE id = $2`,
          [nowIso, row.id]
        );
      } else {
        resultStatus = 'accepted';
        await client.query(
          `UPDATE applications
              SET shift_id = $1,
                  status = 'confirmed',
                  recruiter_queue_comment = '',
                  updated_at = $2,
                  row_version = row_version + 1
            WHERE id = $3`,
          [row.offer_shift_id, nowIso, row.id]
        );
        await client.query(
          `UPDATE application_assignment_offers
              SET status = 'accepted',
                  responded_at = $1,
                  updated_at = $1
            WHERE id = $2`,
          [nowIso, row.offer_id]
        );
      }
    }

    const eventType = {
      accepted: 'assignment_offer_accepted',
      declined: 'assignment_offer_declined',
      expired: 'assignment_offer_expired',
      unavailable: 'assignment_offer_unavailable'
    }[resultStatus];
    const events = [{
      eventType,
      applicationId: applicationLegacyId,
      shiftId: Number(row.offer_shift_legacy_id),
      actorType: 'trainee',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'respond_assignment_offer',
        previousVersion: meta.version,
        nextVersion,
        decision,
        result: resultStatus,
        previousStatus: 'queue',
        nextStatus: resultStatus === 'accepted'
          ? 'confirmed'
          : resultStatus === 'expired'
            ? 'queue_expired'
            : 'queue'
      },
      createdAt: nowIso
    }];
    if (resultStatus === 'accepted') {
      events.push({
        eventType: 'application_assigned_to_shift',
        applicationId: applicationLegacyId,
        shiftId: Number(row.offer_shift_legacy_id),
        actorType: 'trainee',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'respond_assignment_offer',
          previousVersion: meta.version,
          nextVersion,
          previousShiftId: null,
          nextShiftId: Number(row.offer_shift_legacy_id),
          date: shiftDateAsString(row.offer_shift_date)
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
      applicationId: row.id,
      previousStatus: 'queue',
      nextStatus: resultStatus === 'accepted'
        ? 'confirmed'
        : resultStatus === 'expired'
          ? 'queue_expired'
          : 'queue',
      status: resultStatus,
      decision,
      shift,
      previousOffer,
      previousApplication: applicationSnapshotFromRow(row, {
        assignmentOffer: previousOffer
      }),
      version: nextVersion,
      previousVersion: meta.version,
      updatedAt: nowIso,
      changed: true
    };
  });
}

export async function expireAssignmentOffersInPostgres({
  pool,
  actor = { role: 'system' },
  now = new Date()
}) {
  if (!['system', 'recruiter'].includes(String(actor?.role || ''))) {
    throw new PostgresCommandAuthorizationError('Недостаточно прав для истечения запросов даты.');
  }

  return runInPostgresTransaction(pool, async client => {
    const meta = await lockBookingStateMeta(client);
    const nowIso = now.toISOString();
    const expiredResult = await client.query(
      `SELECT applications.id,
              applications.legacy_id,
              applications.status,
              applications.shift_id,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.telegram_code,
              applications.name,
              applications.phone,
              applications.recruiter_queue_comment,
              applications.venue_id,
              applications.group_link,
              application_assignment_offers.id AS offer_id,
              application_assignment_offers.token,
              application_assignment_offers.requested_at,
              application_assignment_offers.expires_at,
              application_assignment_offers.requested_by_telegram_user_id,
              application_assignment_offers.message_chat_id,
              application_assignment_offers.message_id,
              shifts.id AS offer_shift_id,
              shifts.legacy_id AS offer_shift_legacy_id,
              shifts.date::text AS offer_shift_date,
              shifts.seats AS offer_shift_seats,
              shifts.open AS offer_shift_open,
              shifts.canceled AS offer_shift_canceled
         FROM application_assignment_offers
         JOIN applications ON applications.id = application_assignment_offers.application_id
         JOIN shifts ON shifts.id = application_assignment_offers.shift_id
        WHERE application_assignment_offers.status = 'active'
          AND application_assignment_offers.expires_at <= $1::timestamptz
          AND applications.status = 'queue'
        ORDER BY application_assignment_offers.expires_at, applications.legacy_id
        FOR UPDATE OF applications, application_assignment_offers`,
      [nowIso]
    );
    const rows = expiredResult.rows;
    if (!rows.length) {
      return {
        expired: [],
        version: meta.version,
        previousVersion: meta.version,
        updatedAt: shiftUpdatedAtAsString(meta.updatedAt),
        changed: false
      };
    }

    const nextVersion = meta.version + 1;
    const applicationUuids = rows.map(row => row.id);
    const offerUuids = rows.map(row => row.offer_id);

    await client.query(
      `UPDATE applications
          SET status = 'queue_expired',
              recruiter_queue_comment = '',
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = ANY($2::uuid[])`,
      [nowIso, applicationUuids]
    );
    await client.query(
      `UPDATE application_assignment_offers
          SET status = 'expired',
              responded_at = $1,
              updated_at = $1
        WHERE id = ANY($2::uuid[])`,
      [nowIso, offerUuids]
    );

    await insertApplicationEvents(client, rows.map(row => ({
      eventType: 'assignment_offer_expired',
      applicationId: Number(row.legacy_id),
      shiftId: Number(row.offer_shift_legacy_id),
      actorType: 'system',
      actorTelegramUserId: null,
      payload: {
        action: 'expire_assignment_offers',
        previousVersion: meta.version,
        nextVersion,
        previousStatus: 'queue',
        nextStatus: 'queue_expired',
        expiresAt: shiftUpdatedAtAsString(row.expires_at)
      },
      createdAt: nowIso
    })));

    await client.query(
      'UPDATE booking_state_meta SET version = $1, updated_at = $2 WHERE singleton = true',
      [nextVersion, nowIso]
    );

    return {
      expired: rows.map(row => ({
        application: applicationSnapshotFromRow(row, {
          assignmentOffer: assignmentOfferSnapshotFromRow(row)
        }),
        shift: shiftSnapshotFromRow(row, 'offer_shift_'),
        offer: assignmentOfferSnapshotFromRow(row)
      })),
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
              recruiter_queue_comment = '',
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
              recruiter_queue_comment = '',
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
    await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });

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

export async function withdrawConfirmedAssignmentInPostgres({
  pool,
  actor,
  command,
  now = new Date()
}) {
  requireTrainee(actor);
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
              shifts.date::text AS shift_date,
              shifts.seats AS shift_seats,
              shifts.open AS shift_open,
              shifts.canceled AS shift_canceled,
              applications.invite_group_id,
              invite_groups.legacy_id AS invite_group_legacy_id,
              applications.venue_id,
              applications.group_link,
              applications.trainee_telegram_user_id,
              applications.trainee_telegram_chat_id,
              applications.telegram_username,
              applications.telegram_code,
              applications.name,
              applications.phone,
              applications.recruiter_queue_comment
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
    if (!applicationRowBelongsToTrainee(app, actor)) {
      throw new PostgresCommandAuthorizationError('Нельзя изменить чужую заявку.');
    }
    const previousStatus = String(app.status || '');
    if (!['confirmed', 'invited'].includes(previousStatus) || !app.shift_id) {
      throw new PostgresCommandValidationError(
        'Отказаться от выхода можно только после подтверждения даты или отправки рабочей группы.'
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
    const previousShiftLegacyId = Number(app.shift_legacy_id);
    const previousInviteGroupLegacyId = app.invite_group_legacy_id
      ? Number(app.invite_group_legacy_id)
      : null;
    const previousApplication = applicationSnapshotFromRow(app);
    const previousShift = shiftSnapshotFromRow(app, 'shift_');

    await client.query(
      `UPDATE applications
          SET shift_id = NULL,
              invite_group_id = NULL,
              status = 'queue',
              venue_id = NULL,
              group_link = '',
              candidate_report = false,
              recruiter_queue_comment = '',
              updated_at = $1,
              row_version = row_version + 1
        WHERE id = $2`,
      [nowIso, app.id]
    );
    await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });

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
        await client.query('DELETE FROM invite_groups WHERE id = $1', [inviteGroup.id]);
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
        actorType: 'trainee',
        actorTelegramUserId: actorTelegramUserId(actor),
        payload: {
          action: 'withdraw_confirmed_assignment',
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
      eventType: 'assignment_withdrawn_by_trainee',
      applicationId: applicationLegacyId,
      shiftId: previousShiftLegacyId,
      actorType: 'trainee',
      actorTelegramUserId: actorTelegramUserId(actor),
      payload: {
        action: 'withdraw_confirmed_assignment',
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
      assignmentWithdrawalTarget: {
        application: previousApplication,
        shift: previousShift
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
              recruiter_queue_comment = '',
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
    await cancelActiveAssignmentOffers(client, { applicationUuid: app.id, nowIso });

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
