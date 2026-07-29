import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BookingCommandNotImplementedError,
  createJsonBookingStorageAdapter,
  createPostgresReadOnlyBookingStorageAdapter,
  createPostgresWriteBookingStorageAdapter
} from '../src/booking-storage/adapter.js';
import { BOOKING_STORAGE_MODES, BookingStorageReadOnlyError } from '../src/booking-storage-mode.js';

const recruiter = { role: 'recruiter', telegram: { user: { id: '111' } } };

test('JSON adapter delegates readState and applyCommand to injected functions', async () => {
  const readState = async () => ({ version: 3 });
  const applyCommand = async (command, actor) => ({ command, actor });
  const adapter = createJsonBookingStorageAdapter({ readState, applyCommand });

  assert.equal(adapter.mode, BOOKING_STORAGE_MODES.JSON);
  assert.deepEqual(await adapter.readState(), { version: 3 });
  assert.deepEqual(
    await adapter.applyCommand({ action: 'create_shift' }, recruiter),
    { command: { action: 'create_shift' }, actor: recruiter }
  );
});

test('JSON adapter refuses to be constructed without required functions', () => {
  assert.throws(
    () => createJsonBookingStorageAdapter({}),
    /requires readState\(\) and applyCommand\(\) functions/
  );
});

test('Postgres read-only adapter reads from Postgres and refuses writes', async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/booking_state_meta/.test(sql)) {
        return { rowCount: 1, rows: [{ version: 7, updated_at: '2026-07-29T10:00:00.000Z' }] };
      }
      return { rowCount: 0, rows: [] };
    }
  };
  const adapter = createPostgresReadOnlyBookingStorageAdapter({ pool });

  assert.equal(adapter.mode, BOOKING_STORAGE_MODES.POSTGRES_READONLY);
  const state = await adapter.readState();
  assert.equal(state.version, 7);
  assert.throws(() => adapter.applyCommand({ action: 'create_shift' }), BookingStorageReadOnlyError);
});

test('Postgres write adapter routes create_shift through the transactional writer and returns fresh state', async () => {
  const fakeState = { version: 11, updatedAt: '2026-07-29T12:00:00.000Z', shifts: [], applications: [], inviteGroups: [] };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql, params) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 10 }] };
        }
        if (/FROM shifts WHERE date/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/MAX\(legacy_id\)/i.test(sql)) return { rowCount: 1, rows: [{ max_legacy_id: 0 }] };
        if (/FROM applications WHERE legacy_id/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'create_shift', baseVersion: 10, date: '2026-08-01', seats: 6 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 11);
  assert.equal(outcome.result.previousVersion, 10);
  assert.equal(outcome.result.date, '2026-08-01');
  assert.equal(outcome.result.seats, 6);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes update_shift_capacity through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 12,
    updatedAt: '2026-07-29T12:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT id, legacy_id, seats, date::text AS date/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ id: 'shift-uuid-42', legacy_id: 42, seats: 4, date: '2026-08-01' }]
          };
        }
        if (/COUNT\(\*\)::int AS used/i.test(sql)) {
          return { rowCount: 1, rows: [{ used: 1 }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 42, id: 'shift-uuid-42' }] };
        }
        if (/FROM applications WHERE legacy_id/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'update_shift_capacity', baseVersion: 11, shiftId: 42, seats: 7 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.legacyId, 42);
  assert.equal(outcome.result.previousSeats, 4);
  assert.equal(outcome.result.seats, 7);
  assert.equal(outcome.result.version, 12);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter rejects unsupported commands with a stable code', async () => {
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { throw new Error('connect must not be called'); } }
  });
  await assert.rejects(
    () => adapter.applyCommand({ action: 'set_application_status' }, recruiter),
    err => err instanceof BookingCommandNotImplementedError
      && err.code === 'BOOKING_COMMAND_NOT_IMPLEMENTED_IN_POSTGRES'
  );
  await assert.rejects(
    () => adapter.applyCommand({}, recruiter),
    err => err instanceof BookingCommandNotImplementedError
  );
});
