import { randomUUID } from 'node:crypto';
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

const SEAT_HOLDING_STATUS_VALUES = Object.freeze([
  'pending',
  'confirmed',
  'invited',
  'feedback',
  'passed',
  'failed',
  'noshow'
]);

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
