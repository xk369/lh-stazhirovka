import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PostgresCommandAuthorizationError,
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  createShiftInPostgres
} from '../src/postgres/write-booking-command.js';

function fakePool({ currentVersion = 10, existingShifts = [], rollbackThrows = false } = {}) {
  const calls = [];
  let existing = [...existingShifts];
  let version = currentVersion;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^BEGIN$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^COMMIT$/i.test(sql)) return { rowCount: 0, rows: [] };
      if (/^ROLLBACK$/i.test(sql)) {
        if (rollbackThrows) throw new Error('rollback failure');
        return { rowCount: 0, rows: [] };
      }
      if (/SELECT version FROM booking_state_meta/.test(sql)) {
        return { rowCount: 1, rows: [{ version }] };
      }
      if (/SELECT 1 FROM shifts WHERE date/.test(sql)) {
        const hit = existing.find(row => row.date === params[0]);
        return { rowCount: hit ? 1 : 0, rows: hit ? [{ '?column?': 1 }] : [] };
      }
      if (/SELECT COALESCE\(MAX\(legacy_id\), 0\) AS max_legacy_id FROM shifts/.test(sql)) {
        const max = existing.reduce((acc, row) => Math.max(acc, Number(row.legacy_id) || 0), 0);
        return { rowCount: 1, rows: [{ max_legacy_id: max }] };
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
      if (/UPDATE booking_state_meta/.test(sql)) {
        version = Number(params[0]);
        return { rowCount: 1, rows: [] };
      }
      // write-application-events lookups + insert
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
  assert.ok(between.some(sql => /SELECT version FROM booking_state_meta.*FOR UPDATE/.test(sql)));
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
