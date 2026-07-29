import { randomUUID } from 'node:crypto';
import {
  BOOKING_STATUSES,
  BOOKING_STATUS_LABELS,
  SEAT_HOLDING_STATUSES,
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

function normalizeUpdateShiftCapacityInput(command) {
  return {
    shiftLegacyId: normalizeShiftLegacyId(command?.shiftId),
    seats: normalizeSeats(command?.seats),
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
