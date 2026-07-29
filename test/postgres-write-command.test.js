import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresCommandAuthorizationError,
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  createShiftInPostgres,
  setApplicationStatusInPostgres,
  updateShiftCapacityInPostgres
} from '../src/postgres/write-booking-command.js';

const DEFAULT_META_UPDATED_AT = '2026-07-01T00:00:00.000Z';

function fakePool({
  currentVersion = 10,
  metaUpdatedAt = DEFAULT_META_UPDATED_AT,
  existingShifts = [],
  existingApplications = [],
  rollbackThrows = false
} = {}) {
  const calls = [];
  const shifts = existingShifts.map(row => ({ ...row }));
  const apps = existingApplications.map(row => ({ ...row }));
  let version = currentVersion;
  let updatedAt = metaUpdatedAt;

  function findAppByLegacyId(legacyId) {
    return apps.find(app => Number(app.legacy_id) === Number(legacyId));
  }
  function findShiftByUuid(uuid) {
    return shifts.find(row => String(row.id) === String(uuid));
  }

  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^BEGIN$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^COMMIT$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^ROLLBACK$/i.test(sql)) {
        if (rollbackThrows) throw new Error('rollback failure');
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT version.*FROM booking_state_meta/is.test(sql)) {
        return { rowCount: 1, rows: [{ version, updated_at: updatedAt }] };
      }
      if (/SELECT 1 FROM shifts WHERE date/.test(sql)) {
        const hit = shifts.find(row => row.date === params[0]);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT COALESCE\(MAX\(legacy_id\), 0\) AS max_legacy_id FROM shifts/.test(sql)) {
        const max = shifts.reduce((acc, row) => Math.max(acc, Number(row.legacy_id) || 0), 0);
        return { rowCount: 1, rows: [{ max_legacy_id: max }] };
      }
      if (/SELECT id, legacy_id, seats, date::text AS date/i.test(sql)) {
        const row = shifts.find(item => Number(item.legacy_id) === Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          seats: row.seats,
          date: row.date
        }] : [] };
      }
      if (/SELECT id, legacy_id, open, canceled, date::text AS date/i.test(sql)) {
        const row = findShiftByUuid(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          open: row.open,
          canceled: row.canceled,
          date: row.date
        }] : [] };
      }
      if (/SELECT id, legacy_id, status, shift_id, invite_group_id, group_link, experience/i.test(sql)) {
        const row = findAppByLegacyId(params[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          status: row.status,
          shift_id: row.shift_id,
          invite_group_id: row.invite_group_id,
          group_link: row.group_link,
          experience: row.experience
        }] : [] };
      }
      if (/SELECT status, mentor_report_received\s+FROM applications\s+WHERE shift_id/i.test(sql)) {
        const shiftUuid = String(params[0]);
        const rows = apps
          .filter(app => String(app.shift_id) === shiftUuid)
          .map(app => ({
            status: app.status,
            mentor_report_received: Boolean(app.mentor_report_received)
          }));
        return { rowCount: rows.length, rows };
      }
      if (/SELECT COUNT\(\*\)::int AS used\s+FROM applications/i.test(sql)) {
        const shiftUuid = String(params[0]);
        const allowedStatuses = new Set((params[1] || []).map(String));
        const used = apps.filter(app => (
          String(app.shift_id) === shiftUuid && allowedStatuses.has(String(app.status))
        )).length;
        return { rowCount: 1, rows: [{ used }] };
      }
      if (/INSERT INTO shifts/.test(sql)) {
        shifts.push({
          id: params[0],
          legacy_id: params[1],
          date: params[2],
          seats: params[3],
          open: true,
          canceled: false
        });
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE shifts\s+SET seats/i.test(sql)) {
        const seatsValue = Number(params[0]);
        const shiftUuid = String(params[2]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.seats = seatsValue;
          target.updated_at = params[1];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE shifts\s+SET open = false/i.test(sql)) {
        const shiftUuid = String(params[1]);
        const target = findShiftByUuid(shiftUuid);
        if (target) {
          target.open = false;
          target.updated_at = params[0];
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE applications\s+SET status/i.test(sql)) {
        const nextStatus = params[0];
        const nextExperience = params[1];
        const nowIso = params[2];
        const appUuid = String(params[3]);
        const target = apps.find(app => String(app.id) === appUuid);
        if (target) {
          target.status = nextStatus;
          target.experience = nextExperience;
          target.updated_at = nowIso;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE booking_state_meta/.test(sql)) {
        version = Number(params[0]);
        updatedAt = params[1];
        return { rowCount: 1, rows: [] };
      }
      if (/FROM applications WHERE legacy_id = ANY/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = apps
          .filter(app => requested.has(String(app.legacy_id)))
          .map(app => ({ legacy_id: app.legacy_id, id: app.id }));
        return { rowCount: rows.length, rows };
      }
      if (/FROM shifts WHERE legacy_id = ANY/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = shifts
          .filter(row => requested.has(String(row.legacy_id)))
          .map(row => ({ legacy_id: row.legacy_id, id: row.id }));
        return { rowCount: rows.length, rows };
      }
      if (/INSERT INTO application_events/.test(sql)) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    }
  };
  return {
    calls,
    getVersion: () => version,
    getUpdatedAt: () => updatedAt,
    getShifts: () => shifts,
    getApplications: () => apps,
    async connect() {
      calls.push({ sql: 'CONNECT' });
      return client;
    }
  };
}

const recruiter = { role: 'recruiter', telegram: { user: { id: '111' } } };

test('createShiftInPostgres commits shift + event + version bump for a fresh future date', async () => {
  const pool = fakePool({ currentVersion: 10 });
  const now = new Date('2026-07-29T12:00:00.000Z');
  const result = await createShiftInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
    now
  });

  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.date, '2026-08-01');
  assert.equal(result.seats, 5);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(typeof result.shiftId, 'string');
  assert.ok(result.legacyId > 0);
  assert.equal(pool.getVersion(), 11);
  assert.equal(pool.getShifts().length, 1);

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  const beginIndex = sqlOrder.indexOf('BEGIN');
  const commitIndex = sqlOrder.indexOf('COMMIT');
  const releaseIndex = sqlOrder.indexOf('RELEASE');
  assert.ok(beginIndex >= 0 && commitIndex > beginIndex && releaseIndex > commitIndex);

  const between = sqlOrder.slice(beginIndex + 1, commitIndex);
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO shifts/.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO application_events/.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'shift_created');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'create_shift');
  assert.equal(payload.baseVersion, 10);
  assert.equal(payload.previousVersion, 10);
  assert.equal(payload.nextVersion, 11);
  assert.equal(payload.date, '2026-08-01');
  assert.equal(payload.seats, 5);
  assert.equal(payload.legacyShiftId, result.legacyId);
});

test('createShiftInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({ currentVersion: 42 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 41, date: '2026-08-01', seats: 3 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
      && err.code === 'POSTGRES_COMMAND_VERSION_CONFLICT'
  );
  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.includes('BEGIN'));
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(sqls.includes('RELEASE'));
  assert.equal(sqls.includes('COMMIT'), false);
  assert.equal(pool.getVersion(), 42);
  assert.equal(pool.getShifts().length, 0);
});

test('createShiftInPostgres rejects duplicate date and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ id: 'old', legacy_id: 111, date: '2026-08-01' }]
  });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже создана/.test(err.message)
  );
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getShifts().length, 1);
  const sqls = pool.calls.map(call => call.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.equal(sqls.includes('COMMIT'), false);
});

test('createShiftInPostgres rejects past dates before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2020-01-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /в прошлом/.test(err.message)
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres treats today by Europe/Moscow, not UTC', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-07-29', seats: 5 },
      now: new Date('2026-07-29T21:30:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /в прошлом/.test(err.message)
  );
  assert.equal(pool.calls.length, 0);

  const acceptingPool = fakePool({ currentVersion: 10 });
  const result = await createShiftInPostgres({
    pool: acceptingPool,
    actor: recruiter,
    command: { action: 'create_shift', baseVersion: 10, date: '2026-07-30', seats: 5 },
    now: new Date('2026-07-29T21:30:00.000Z')
  });
  assert.equal(result.date, '2026-07-30');
  assert.equal(result.version, 11);
});

test('createShiftInPostgres rejects invalid seats and malformed dates before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 0 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 31 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 10, date: '01-08-2026', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /date must be YYYY-MM-DD/
  );
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 0, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10 });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '222' } } },
      command: { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
      && err.code === 'POSTGRES_COMMAND_FORBIDDEN'
  );
  assert.equal(pool.calls.length, 0);
});

test('createShiftInPostgres releases the client even if ROLLBACK also fails', async () => {
  const pool = fakePool({ currentVersion: 42, rollbackThrows: true });
  await assert.rejects(
    () => createShiftInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'create_shift', baseVersion: 41, date: '2026-08-01', seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  assert.ok(pool.calls.some(call => call.sql === 'RELEASE'));
});

const shiftFixture = { id: 'shift-uuid-1', legacy_id: 555, date: '2026-08-01', seats: 4 };

test('updateShiftCapacityInPostgres commits UPDATE shifts + event + version bump when seats change', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture }]
  });
  const now = new Date('2026-07-29T12:00:00.000Z');
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 6 },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.legacyId, 555);
  assert.equal(result.shiftId, 'shift-uuid-1');
  assert.equal(result.seats, 6);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.version, 11);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getVersion(), 11);
  assert.equal(pool.getShifts()[0].seats, 6);

  const sqlOrder = pool.calls.map(call => call.sql.trim().replace(/\s+/g, ' '));
  assert.ok(sqlOrder.includes('BEGIN'));
  assert.ok(sqlOrder.includes('COMMIT'));
  const between = sqlOrder.slice(sqlOrder.indexOf('BEGIN') + 1, sqlOrder.indexOf('COMMIT'));
  assert.ok(between.some(sql => /SELECT version.*FROM booking_state_meta.*FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /SELECT id, legacy_id, seats, date::text AS date/i.test(sql)
    && /FOR UPDATE/i.test(sql)));
  assert.ok(between.some(sql => /COUNT\(\*\)::int AS used/i.test(sql) && /FROM applications/i.test(sql)));
  assert.ok(between.some(sql => /UPDATE shifts/i.test(sql) && /row_version = row_version \+ 1/i.test(sql)));
  assert.ok(between.some(sql => /INSERT INTO application_events/.test(sql)));
  assert.ok(between.some(sql => /UPDATE booking_state_meta/.test(sql)));

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'shift_capacity_changed');
  assert.equal(eventInsert.params[4], 'recruiter');
  assert.equal(eventInsert.params[5], '111');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'update_shift_capacity');
  assert.equal(payload.baseVersion, 10);
  assert.equal(payload.previousVersion, 10);
  assert.equal(payload.nextVersion, 11);
  assert.equal(payload.previousSeats, 4);
  assert.equal(payload.nextSeats, 6);
  assert.equal(payload.date, '2026-08-01');
  assert.equal(payload.legacyShiftId, 555);
});

test('updateShiftCapacityInPostgres is a no-op when requested seats equal current seats', async () => {
  const pool = fakePool({
    currentVersion: 10,
    metaUpdatedAt: '2026-06-01T00:00:00.000Z',
    existingShifts: [{ ...shiftFixture }]
  });
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 4 },
    now: new Date('2026-07-29T12:00:00.000Z')
  });

  assert.equal(result.changed, false);
  assert.equal(result.seats, 4);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.version, 10);
  assert.equal(result.previousVersion, 10);
  assert.equal(result.updatedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getUpdatedAt(), '2026-06-01T00:00:00.000Z');
  assert.equal(pool.getShifts()[0].seats, 4);

  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^BEGIN$/i.test(sql)));
  assert.ok(sqls.some(sql => /^COMMIT$/i.test(sql)));
  assert.equal(sqls.some(sql => /UPDATE shifts/i.test(sql)), false);
  assert.equal(sqls.some(sql => /INSERT INTO application_events/i.test(sql)), false);
  assert.equal(sqls.some(sql => /UPDATE booking_state_meta/i.test(sql)), false);
  assert.equal(sqls.some(sql => /COUNT\(\*\)/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rejects seats lower than current usage and rolls back', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture, seats: 5 }],
    existingApplications: [
      { id: 'a-1', legacy_id: 701, shift_id: 'shift-uuid-1', status: 'pending' },
      { id: 'a-2', legacy_id: 702, shift_id: 'shift-uuid-1', status: 'confirmed' },
      { id: 'a-3', legacy_id: 703, shift_id: 'shift-uuid-1', status: 'invited' },
      { id: 'a-4', legacy_id: 704, shift_id: 'shift-uuid-1', status: 'queue' }
    ]
  });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 2 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже записано 3 стажёров/.test(err.message)
  );
  assert.equal(pool.getVersion(), 10);
  assert.equal(pool.getShifts()[0].seats, 5);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(sqls.some(sql => /UPDATE shifts/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres accepts seats equal to current usage', async () => {
  const pool = fakePool({
    currentVersion: 10,
    existingShifts: [{ ...shiftFixture, seats: 5 }],
    existingApplications: [
      { id: 'a-1', legacy_id: 701, shift_id: 'shift-uuid-1', status: 'pending' },
      { id: 'a-2', legacy_id: 702, shift_id: 'shift-uuid-1', status: 'confirmed' },
      { id: 'a-3', legacy_id: 703, shift_id: 'shift-uuid-1', status: 'invited' }
    ]
  });
  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 3 },
    now: new Date('2026-07-29T12:00:00.000Z')
  });
  assert.equal(result.changed, true);
  assert.equal(result.seats, 3);
  assert.equal(result.previousSeats, 5);
  assert.equal(result.version, 11);
});

test('updateShiftCapacityInPostgres rejects unknown shift and rolls back', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 999, seats: 5 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /shift not found/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rolls back on stale baseVersion without touching the shift', async () => {
  const pool = fakePool({
    currentVersion: 42,
    existingShifts: [{ ...shiftFixture }]
  });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 41, shiftId: 555, seats: 8 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
      && err.code === 'POSTGRES_COMMAND_VERSION_CONFLICT'
  );
  assert.equal(pool.getVersion(), 42);
  assert.equal(pool.getShifts()[0].seats, 4);
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
});

test('updateShiftCapacityInPostgres rejects invalid inputs before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [{ ...shiftFixture }] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 0 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 31 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /seats must be an integer between 1 and 30/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 0, seats: 4 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /shiftId must be a positive integer/
  );
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'update_shift_capacity', baseVersion: 0, shiftId: 555, seats: 4 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('updateShiftCapacityInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 10, existingShifts: [{ ...shiftFixture }] });
  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '222' } } },
      command: { action: 'update_shift_capacity', baseVersion: 10, shiftId: 555, seats: 6 },
      now: new Date('2026-07-29T12:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
      && err.code === 'POSTGRES_COMMAND_FORBIDDEN'
  );
  assert.equal(pool.calls.length, 0);
});

// -----------------------------------------------------------------------------
// set_application_status
// -----------------------------------------------------------------------------

const openShift = {
  id: 'shift-uuid-99',
  legacy_id: 999,
  date: '2026-08-05',
  seats: 4,
  open: true,
  canceled: false
};

const pendingApp = {
  id: 'app-uuid-1',
  legacy_id: 1001,
  shift_id: 'shift-uuid-99',
  status: 'pending',
  invite_group_id: null,
  group_link: '',
  experience: null,
  mentor_report_received: false
};

const invitedApp = {
  id: 'app-uuid-2',
  legacy_id: 1002,
  shift_id: 'shift-uuid-99',
  status: 'invited',
  invite_group_id: 'group-uuid-1',
  group_link: 'https://t.me/+xyz',
  experience: null,
  mentor_report_received: false
};

test('setApplicationStatusInPostgres pending → confirmed emits recruiter_confirmed and bumps version', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.previousStatus, 'pending');
  assert.equal(result.nextStatus, 'confirmed');
  assert.equal(result.eventType, 'recruiter_confirmed');
  assert.equal(result.shiftLegacyId, 999);
  assert.equal(result.shiftAutoClosed, false);
  assert.equal(result.version, 21);
  assert.equal(result.updatedAt, now.toISOString());
  assert.equal(pool.getVersion(), 21);
  assert.equal(pool.getApplications()[0].status, 'confirmed');
  assert.equal(pool.getShifts()[0].open, true);

  const eventInsert = pool.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInsert.params[3], 'recruiter_confirmed');
  const payload = JSON.parse(eventInsert.params[6]);
  assert.equal(payload.action, 'set_application_status');
  assert.equal(payload.previousStatus, 'pending');
  assert.equal(payload.nextStatus, 'confirmed');
  assert.equal(payload.shiftId, 999);
  assert.equal(payload.legacyApplicationId, 1001);
});

test('setApplicationStatusInPostgres invited → feedback passes invite-group guard', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp }]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'feedback' },
    now
  });

  assert.equal(result.eventType, 'attendance_marked_feedback');
  assert.equal(pool.getApplications()[0].status, 'feedback');
  assert.equal(result.shiftAutoClosed, false);
});

test('setApplicationStatusInPostgres invited → noshow auto-closes shift when it is the last non-final application', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [
      { ...invitedApp },
      {
        id: 'app-uuid-3',
        legacy_id: 1003,
        shift_id: 'shift-uuid-99',
        status: 'passed',
        invite_group_id: 'group-uuid-1',
        group_link: 'https://t.me/+xyz',
        experience: 'experienced',
        mentor_report_received: true
      }
    ]
  });
  const now = new Date('2026-07-29T13:00:00.000Z');
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
    now
  });

  assert.equal(result.eventType, 'attendance_marked_noshow');
  assert.equal(result.shiftAutoClosed, true);
  assert.equal(pool.getShifts()[0].open, false);

  const eventInserts = pool.calls.filter(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(eventInserts.length, 2);
  assert.deepEqual(eventInserts.map(call => call.params[3]), ['attendance_marked_noshow', 'shift_auto_closed']);
  const closeEventInsert = eventInserts.find(call => call.params[3] === 'shift_auto_closed');
  assert.ok(closeEventInsert, 'shift_auto_closed event must be inserted');
  const closePayload = JSON.parse(closeEventInsert.params[6]);
  assert.equal(closePayload.action, 'set_application_status');
  assert.equal(closePayload.date, '2026-08-05');
});

test('setApplicationStatusInPostgres does not auto-close when a non-final application remains', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [
      { ...invitedApp },
      {
        id: 'app-uuid-3',
        legacy_id: 1003,
        shift_id: 'shift-uuid-99',
        status: 'feedback',
        invite_group_id: 'group-uuid-1',
        group_link: 'https://t.me/+xyz',
        experience: null,
        mentor_report_received: false
      }
    ]
  });
  const result = await setApplicationStatusInPostgres({
    pool,
    actor: recruiter,
    command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
    now: new Date('2026-07-29T13:00:00.000Z')
  });

  assert.equal(result.shiftAutoClosed, false);
  assert.equal(pool.getShifts()[0].open, true);
});

test('setApplicationStatusInPostgres rejects invited → feedback when application has no invite group', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp, invite_group_id: null, group_link: '' }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'feedback' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отправьте кандидату приглашение/.test(err.message)
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getApplications()[0].status, 'invited');
});

test('setApplicationStatusInPostgres rejects invited → noshow when application has no invite group', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...invitedApp, invite_group_id: null, group_link: '' }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1002, status: 'noshow' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /отправьте кандидату приглашение/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rejects transitions disallowed by the recruiter state machine', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'feedback' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /недоступен/.test(err.message)
  );
});

test('setApplicationStatusInPostgres refuses back-to-pending transitions until a dedicated command exists', async () => {
  for (const previousStatus of ['confirmed', 'invited', 'feedback']) {
    const pool = fakePool({
      currentVersion: 20,
      existingShifts: [{ ...openShift }],
      existingApplications: [{ ...pendingApp, status: previousStatus, invite_group_id: 'group-uuid-1', group_link: 'https://t.me/+xyz' }]
    });
    await assert.rejects(
      () => setApplicationStatusInPostgres({
        pool,
        actor: recruiter,
        command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'pending' },
        now: new Date('2026-07-29T13:00:00.000Z')
      }),
      err => err instanceof PostgresCommandValidationError && /отдельной команды/.test(err.message),
      `expected reject for ${previousStatus} → pending`
    );
  }
});

test('setApplicationStatusInPostgres rejects confirmed target when the application has no shiftId', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingApplications: [{ ...pendingApp, shift_id: null }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /must have shiftId/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rolls back on stale baseVersion', async () => {
  const pool = fakePool({
    currentVersion: 20,
    existingShifts: [{ ...openShift }],
    existingApplications: [{ ...pendingApp }]
  });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 19, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );
  const sqls = pool.calls.map(call => call.sql.trim());
  assert.ok(sqls.some(sql => /^ROLLBACK$/i.test(sql)));
  assert.equal(sqls.some(sql => /^COMMIT$/i.test(sql)), false);
  assert.equal(pool.getApplications()[0].status, 'pending');
});

test('setApplicationStatusInPostgres rejects unknown application', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 99999, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /application not found/.test(err.message)
  );
});

test('setApplicationStatusInPostgres rejects invalid inputs before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [{ ...pendingApp }] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'bogus' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /application.status is invalid/
  );
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 0, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /applicationId must be a positive integer/
  );
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: recruiter,
      command: { action: 'set_application_status', baseVersion: 0, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    /baseVersion is required/
  );
  assert.equal(pool.calls.length, 0);
});

test('setApplicationStatusInPostgres rejects non-recruiter actors before opening a transaction', async () => {
  const pool = fakePool({ currentVersion: 20, existingApplications: [{ ...pendingApp }] });
  await assert.rejects(
    () => setApplicationStatusInPostgres({
      pool,
      actor: { role: 'trainee', telegram: { user: { id: '999' } } },
      command: { action: 'set_application_status', baseVersion: 20, applicationId: 1001, status: 'confirmed' },
      now: new Date('2026-07-29T13:00:00.000Z')
    }),
    err => err instanceof PostgresCommandAuthorizationError
  );
  assert.equal(pool.calls.length, 0);
});
