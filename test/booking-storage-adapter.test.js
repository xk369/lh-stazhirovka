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

test('Postgres write adapter routes set_application_status through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 13,
    updatedAt: '2026-07-29T13:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T13:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 12, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT id, legacy_id, status, shift_id, invite_group_id, group_link, experience/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-77',
              legacy_id: 77,
              status: 'pending',
              shift_id: 'shift-uuid-77',
              invite_group_id: null,
              group_link: '',
              experience: null
            }]
          };
        }
        if (/SELECT id, legacy_id, open, canceled, date::text AS date/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-77',
              legacy_id: 500,
              open: true,
              canceled: false,
              date: '2026-08-10'
            }]
          };
        }
        if (/SELECT status, mentor_report_received/i.test(sql)) {
          return { rowCount: 1, rows: [{ status: 'confirmed', mentor_report_received: false }] };
        }
        if (/FROM applications WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 77, id: 'app-uuid-77' }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 500, id: 'shift-uuid-77' }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'set_application_status', baseVersion: 12, applicationId: 77, status: 'confirmed' },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.previousStatus, 'pending');
  assert.equal(outcome.result.nextStatus, 'confirmed');
  assert.equal(outcome.result.eventType, 'recruiter_confirmed');
  assert.equal(outcome.result.shiftLegacyId, 500);
  assert.equal(outcome.result.version, 13);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes assign_shift through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 51,
    updatedAt: '2026-07-29T14:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T14:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 50, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT id, legacy_id, status, shift_id\s+FROM applications/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{ id: 'app-uuid-77', legacy_id: 77, status: 'queue', shift_id: null }]
          };
        }
        if (/SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-99',
              legacy_id: 99,
              seats: 4,
              open: true,
              canceled: false,
              date: '2026-08-15'
            }]
          };
        }
        if (/COUNT\(\*\)::int AS used/i.test(sql)) {
          return { rowCount: 1, rows: [{ used: 1 }] };
        }
        if (/FROM applications WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 77, id: 'app-uuid-77' }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 99, id: 'shift-uuid-99' }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'assign_shift', baseVersion: 50, applicationId: 77, shiftId: 99 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.previousStatus, 'queue');
  assert.equal(outcome.result.nextStatus, 'pending');
  assert.equal(outcome.result.shiftLegacyId, 99);
  assert.equal(outcome.result.shiftId, 'shift-uuid-99');
  assert.equal(outcome.result.version, 51);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes send_invites through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 61,
    updatedAt: '2026-07-29T15:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T15:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 60, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-88',
              legacy_id: 88,
              seats: 6,
              open: true,
              canceled: false,
              date: '2026-08-20'
            }]
          };
        }
        if (/SELECT id, legacy_id, status, shift_id, venue_id, group_link/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'confirmed',
              shift_id: 'shift-uuid-88',
              venue_id: null,
              group_link: '',
              trainee_telegram_user_id: '501',
              trainee_telegram_chat_id: '501',
              telegram_username: 'trainee501',
              name: 'Trainee 501'
            }]
          };
        }
        if (/MAX\(legacy_id\).*FROM invite_groups/i.test(sql)) {
          return { rowCount: 1, rows: [{ max_legacy_id: 300 }] };
        }
        if (/FROM applications WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 501, id: 'app-uuid-501' }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 88, id: 'shift-uuid-88' }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    {
      action: 'send_invites',
      baseVersion: 60,
      shiftId: 88,
      venueId: 'loft5_small',
      link: 'https://t.me/+abc',
      memberIds: [501]
    },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.shiftLegacyId, 88);
  assert.equal(outcome.result.venueId, 'loft5_small');
  assert.equal(outcome.result.link, 'https://t.me/+abc');
  assert.deepEqual(outcome.result.memberLegacyIds, [501]);
  assert.deepEqual(outcome.result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(outcome.result.version, 61);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter rejects still-unsupported commands with a stable code', async () => {
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { throw new Error('connect must not be called'); } }
  });
  await assert.rejects(
    () => adapter.applyCommand({ action: 'cancel_shift' }, recruiter),
    err => err instanceof BookingCommandNotImplementedError
      && err.code === 'BOOKING_COMMAND_NOT_IMPLEMENTED_IN_POSTGRES'
  );
  await assert.rejects(
    () => adapter.applyCommand({}, recruiter),
    err => err instanceof BookingCommandNotImplementedError
  );
});
