import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresCommandAuthorizationError,
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  createShiftInPostgres,
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
  let existing = existingShifts.map(row => ({ ...row }));
  const apps = existingApplications.map(row => ({ ...row }));
  let version = currentVersion;
  let updatedAt = metaUpdatedAt;
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
        const hit = existing.find(row => row.date === params[0]);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT COALESCE\(MAX\(legacy_id\), 0\) AS max_legacy_id FROM shifts/.test(sql)) {
        const max = existing.reduce((acc, row) => Math.max(acc, Number(row.legacy_id) || 0), 0);
        return { rowCount: 1, rows: [{ max_legacy_id: max }] };
      }
      if (/SELECT id, legacy_id, seats, date::text AS date/i.test(sql)) {
        const row = existing.find(item => Number(item.legacy_id) === Number(params[0]));
        return { rowCount: row ? 1 : 0, rows: row ? [{
          id: row.id,
          legacy_id: row.legacy_id,
          seats: row.seats,
          date: row.date
        }] : [] };
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
        existing.push({
          id: params[0],
          legacy_id: params[1],
          date: params[2],
          seats: params[3]
        });
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE shifts\s+SET seats/i.test(sql)) {
        const seatsValue = Number(params[0]);
        const updatedAtValue = params[1];
        const shiftUuid = String(params[2]);
        const target = existing.find(row => String(row.id) === shiftUuid);
        if (target) {
          target.seats = seatsValue;
          target.updated_at = updatedAtValue;
        }
        return { rowCount: target ? 1 : 0, rows: [] };
      }
      if (/UPDATE booking_state_meta/.test(sql)) {
        version = Number(params[0]);
        updatedAt = params[1];
        return { rowCount: 1, rows: [] };
      }
      if (/FROM applications WHERE legacy_id/.test(sql)) return { rowCount: 0, rows: [] };
      if (/FROM shifts WHERE legacy_id = ANY/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        const rows = existing
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
    getShifts: () => existing,
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
  // 2026-07-29T21:30:00.000Z is already 2026-07-30T00:30 in Moscow (UTC+3),
  // so a shift for 2026-07-29 must be rejected as past even though UTC calendar
  // still shows 2026-07-29.
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

  // Same instant, the Moscow-today date (2026-07-30) is still accepted, so
  // the check really depends on the Europe/Moscow calendar boundary and not
  // just on a stricter comparison.
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
      { shift_id: 'shift-uuid-1', status: 'pending' },
      { shift_id: 'shift-uuid-1', status: 'confirmed' },
      { shift_id: 'shift-uuid-1', status: 'invited' },
      { shift_id: 'shift-uuid-1', status: 'queue' } // не занимает место — не должна учитываться
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
      { shift_id: 'shift-uuid-1', status: 'pending' },
      { shift_id: 'shift-uuid-1', status: 'confirmed' },
      { shift_id: 'shift-uuid-1', status: 'invited' }
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
