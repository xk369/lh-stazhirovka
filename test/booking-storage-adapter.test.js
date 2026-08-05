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
const trainee = { role: 'trainee', userId: '222', telegram: { user: { id: '222', username: 'trainee_user' } } };
const mentor = {
  role: 'mentor',
  telegram: { user: { id: '333', username: 'mentor_user', first_name: 'Софья', last_name: 'Сучкова' } }
};

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

test('Postgres write adapter routes upsert_trainee_application and returns fresh state', async () => {
  const fakeState = {
    version: 11,
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
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 10 }] };
        }
        if (/SELECT id, legacy_id, seats, open, canceled, date::text AS date/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-88',
              legacy_id: 88,
              seats: 4,
              open: true,
              canceled: false,
              date: '2026-08-01'
            }]
          };
        }
        if (/SELECT COUNT\(\*\)::int AS used/i.test(sql)) {
          return { rowCount: 1, rows: [{ used: 0 }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return { rowCount: 0, rows: [] };
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
      action: 'upsert_trainee_application',
      baseVersion: 10,
      application: {
        id: 501,
        shiftId: null,
        name: 'Иван Иванов',
        phone: '+7 999 123-45-67',
        training: 'passed',
        trainingDate: '2026-07-20',
        attempt: 'first',
        limits: '',
        telegramCode: '',
        status: 'queue',
        comment: ''
      }
    },
    trainee
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 11);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.created, true);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes cancel_application and returns fresh state', async () => {
  const fakeState = {
    version: 12,
    updatedAt: '2026-07-29T12:20:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:20:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11 }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'queue',
              shift_id: null,
              shift_legacy_id: null,
              invite_group_id: null,
              invite_group_legacy_id: null,
              group_link: '',
              trainee_telegram_user_id: '222',
              trainee_telegram_chat_id: '222',
              telegram_username: 'trainee_user',
              name: 'Иван Иванов',
              mentor_report_received: false
            }]
          };
        }
        if (/FROM applications WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 501, id: 'app-uuid-501' }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'cancel_application', baseVersion: 11, applicationId: 501 },
    trainee
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 12);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.previousStatus, 'queue');
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes clear_state and returns fresh state', async () => {
  const fakeState = { version: 12, updatedAt: '2026-07-29T12:30:00.000Z', shifts: [], applications: [], inviteGroups: [] };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:30:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT\s+\(SELECT count\(\*\)::int FROM shifts\) AS shifts/is.test(sql)) {
          return { rowCount: 1, rows: [{ shifts: 1, applications: 2, invite_groups: 1, invite_group_members: 2, active_mentor_reports: 1, notifications: 1 }] };
        }
        if (/FROM applications WHERE legacy_id/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'clear_state', baseVersion: 11 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 12);
  assert.equal(outcome.result.removed.applications, 2);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes reset_demo_state and returns fresh state', async () => {
  const fakeState = { version: 12, updatedAt: '2026-07-29T12:35:00.000Z', shifts: [], applications: [], inviteGroups: [] };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:35:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT\s+\(SELECT count\(\*\)::int FROM shifts\) AS shifts/is.test(sql)) {
          return { rowCount: 1, rows: [{ shifts: 1, applications: 2, invite_groups: 1, invite_group_members: 2, active_mentor_reports: 1, notifications: 1 }] };
        }
        if (/FROM applications WHERE legacy_id/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'reset_demo_state', baseVersion: 11 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 12);
  assert.deepEqual(outcome.result.inserted, { shifts: 3, applications: 3, inviteGroups: 0 });
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes link_telegram_application and returns fresh state', async () => {
  const fakeState = {
    version: 12,
    updatedAt: '2026-07-29T12:38:00.000Z',
    shifts: [],
    applications: [{
      id: 501,
      telegramChatId: '222',
      telegramUserId: '222',
      telegramUsername: 'trainee_user'
    }],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T12:38:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+WHERE legacy_id = \$1\s+FOR UPDATE/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              trainee_telegram_user_id: null,
              trainee_telegram_chat_id: null,
              telegram_username: ''
            }]
          };
        }
        if (/FROM applications WHERE legacy_id = ANY/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 501, id: 'app-uuid-501' }] };
        }
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'link_telegram_application', applicationId: 501 },
    trainee
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 12);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.telegramUserId, '222');
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
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

test('Postgres write adapter routes toggle_shift through the transactional writer and returns fresh state', async () => {
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
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), params });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 11, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM shifts/i.test(sql) && /FOR UPDATE/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-88',
              legacy_id: 88,
              date: '2026-08-01',
              open: true,
              canceled: false,
              canceled_at: null
            }]
          };
        }
        if (/FROM applications WHERE legacy_id/i.test(sql)) return { rowCount: 0, rows: [] };
        if (/FROM shifts WHERE legacy_id = ANY/i.test(sql)) return { rowCount: 1, rows: [{ legacy_id: 88, id: 'shift-uuid-88' }] };
        return { rowCount: 1, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    { action: 'toggle_shift', baseVersion: 11, shiftId: 88, open: false },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.version, 12);
  assert.equal(outcome.result.previousVersion, 11);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.open, false);
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

test('Postgres write adapter routes update_comment through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 18,
    updatedAt: '2026-07-29T20:15:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T20:15:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 17, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              recruiter_comment: 'old'
            }]
          };
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
    { action: 'update_comment', baseVersion: 17, applicationId: 501, comment: 'new' },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.previousComment, 'old');
  assert.equal(outcome.result.nextComment, 'new');
  assert.equal(outcome.result.version, 18);
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

test('Postgres write adapter routes cancel_internship through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 72,
    updatedAt: '2026-07-29T17:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T17:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 71, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'invited',
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              shift_date: '2026-08-20',
              invite_group_id: 'group-uuid-300',
              invite_group_legacy_id: 300,
              venue_id: 'loft5_small',
              group_link: 'https://t.me/+abc',
              trainee_telegram_user_id: '501',
              trainee_telegram_chat_id: '501',
              telegram_username: 'trainee501',
              name: 'Trainee 501'
            }]
          };
        }
        if (/SELECT id, legacy_id, shift_id, venue_id, link\s+FROM invite_groups/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'group-uuid-300',
              legacy_id: 300,
              shift_id: 'shift-uuid-88',
              venue_id: 'loft5_small',
              link: 'https://t.me/+abc'
            }]
          };
        }
        if (/SELECT applications\.legacy_id\s+FROM invite_group_members/i.test(sql)) {
          return { rowCount: 1, rows: [{ legacy_id: 501 }] };
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
    { action: 'cancel_internship', baseVersion: 71, applicationId: 501 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.previousStatus, 'invited');
  assert.equal(outcome.result.nextStatus, 'queue');
  assert.equal(outcome.result.previousShiftId, 88);
  assert.equal(outcome.result.previousInviteGroupId, 300);
  assert.equal(outcome.result.inviteGroupRemoved, true);
  assert.deepEqual(outcome.result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(outcome.result.version, 72);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes cancel_shift through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 92,
    updatedAt: '2026-07-29T18:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T18:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 91, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/SELECT id, legacy_id, date::text AS date, open, canceled, canceled_at/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-88',
              legacy_id: 88,
              date: '2026-08-20',
              open: true,
              canceled: false,
              canceled_at: null
            }]
          };
        }
        if (/FROM applications\s+LEFT JOIN invite_groups ON invite_groups\.id = applications\.invite_group_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'confirmed',
              shift_id: 'shift-uuid-88',
              invite_group_id: null,
              invite_group_legacy_id: null,
              venue_id: null,
              group_link: '',
              trainee_telegram_user_id: '501',
              trainee_telegram_chat_id: '501',
              telegram_username: 'trainee501',
              name: 'Trainee 501'
            }]
          };
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
    { action: 'cancel_shift', baseVersion: 91, shiftId: 88 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.shiftLegacyId, 88);
  assert.deepEqual(outcome.result.affectedApplicationLegacyIds, [501]);
  assert.deepEqual(outcome.result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(outcome.result.version, 92);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes step_back_application through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 102,
    updatedAt: '2026-07-29T19:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T19:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 101, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'passed',
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              trainee_telegram_user_id: '501',
              trainee_telegram_chat_id: '501',
              telegram_username: 'trainee501',
              name: 'Trainee 501'
            }]
          };
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
    { action: 'step_back_application', baseVersion: 101, applicationId: 501 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.previousStatus, 'passed');
  assert.equal(outcome.result.nextStatus, 'feedback');
  assert.equal(outcome.result.mentorReportVoided, true);
  assert.deepEqual(outcome.result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.equal(outcome.result.version, 102);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes mark_experienced through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 112,
    updatedAt: '2026-07-29T20:00:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T20:00:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 111, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'passed',
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              experience: null
            }]
          };
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
    { action: 'mark_experienced', baseVersion: 111, applicationId: 501 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.nextExperience, 'experienced');
  assert.equal(outcome.result.version, 112);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes return_to_queue through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 122,
    updatedAt: '2026-07-29T20:10:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T20:10:00.000Z'),
    readFreshState: async () => fakeState
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 121, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'confirmed',
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              invite_group_id: null,
              invite_group_legacy_id: null,
              venue_id: null,
              group_link: ''
            }]
          };
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
    { action: 'return_to_queue', baseVersion: 121, applicationId: 501 },
    recruiter
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.previousStatus, 'confirmed');
  assert.equal(outcome.result.nextStatus, 'queue');
  assert.equal(outcome.result.version, 122);
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes mentor_report_result through the transactional writer and returns fresh state', async () => {
  const fakeState = {
    version: 132,
    updatedAt: '2026-07-29T20:20:00.000Z',
    shifts: [],
    applications: [],
    inviteGroups: []
  };
  const workedCommands = [];
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T20:20:00.000Z'),
    readFreshState: async () => fakeState,
    reportChatIds: { mentor: '-100mentor-report-group' }
  });

  function fakeClient() {
    return {
      async query(sql) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase() });
        if (/booking_state_meta/i.test(sql) && /SELECT/i.test(sql)) {
          return { rowCount: 1, rows: [{ version: 131, updated_at: '2026-07-01T00:00:00.000Z' }] };
        }
        if (/FROM applications\s+LEFT JOIN shifts ON shifts\.id = applications\.shift_id/is.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'app-uuid-501',
              legacy_id: 501,
              status: 'feedback',
              shift_id: 'shift-uuid-88',
              shift_legacy_id: 88,
              shift_date: '2026-08-01',
              invite_group_id: 'group-uuid-1',
              invite_group_legacy_id: 901,
              venue_id: 'loft5_small',
              group_link: 'https://t.me/+mentor',
              trainee_telegram_user_id: '501',
              trainee_telegram_chat_id: '501',
              telegram_username: 'trainee501',
              name: 'Иван Иванов',
              mentor_report_received: false
            }]
          };
        }
        if (/SELECT id\s+FROM mentor_reports\s+WHERE application_id/i.test(sql)) {
          return { rowCount: 0, rows: [] };
        }
        if (/FROM shifts\s+WHERE id = \$1/i.test(sql)) {
          return {
            rowCount: 1,
            rows: [{
              id: 'shift-uuid-88',
              legacy_id: 88,
              open: true,
              canceled: false,
              date: '2026-08-01'
            }]
          };
        }
        if (/SELECT status, mentor_report_received\s+FROM applications\s+WHERE shift_id/i.test(sql)) {
          return { rowCount: 1, rows: [{ status: 'passed', mentor_report_received: true }] };
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
      action: 'mentor_report_result',
      applicationId: 501,
      mentorTraineeName: 'Иван Иванов',
      mentorDecision: 'Стажировка пройдена',
      mentorCommentForTrainee: 'Комментарий наставника',
      reportText: 'Полный отчёт наставника',
      mentorTraineeResult: {
        date: '2026-08-01',
        venue: 'LOFT #5 · SMALL',
        venueId: 'loft5_small',
        venueLoft: 'LOFT #5',
        hall: 'SMALL',
        mastered: 29,
        total: 29,
        decision: 'Стажировка пройдена',
        topicsToRepeat: []
      }
    },
    mentor
  );
  assert.equal(outcome.state, fakeState);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.applicationLegacyId, 501);
  assert.equal(outcome.result.nextStatus, 'passed');
  assert.equal(outcome.result.version, 132);
  assert.deepEqual(outcome.result.notifications, {
    total: 2,
    pending: 2,
    skipped: 0,
    inserted: 2
  });
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter routes trainee_report_submission without reading fresh booking state', async () => {
  const workedCommands = [];
  let readFreshStateCalled = false;
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { return fakeClient(); } },
    now: () => new Date('2026-07-29T20:30:00.000Z'),
    readFreshState: async () => {
      readFreshStateCalled = true;
      throw new Error('readFreshState must not be called for report-only command');
    },
    reportChatIds: { trainee: '-1003951918570' }
  });

  function fakeClient() {
    return {
      async query(sql, params = []) {
        workedCommands.push({ sql: sql.trim().split(/\s+/)[0].toUpperCase(), rawSql: sql, params });
        return { rowCount: /INSERT INTO notifications/i.test(sql) ? 1 : 0, rows: [] };
      },
      release() {}
    };
  }

  const outcome = await adapter.applyCommand(
    {
      action: 'trainee_report_submission',
      reportText: 'Итоговый отчёт стажёра по смене.'
    },
    trainee
  );
  assert.equal(outcome.state, null);
  assert.equal(readFreshStateCalled, false);
  assert.equal(outcome.result.changed, true);
  assert.equal(outcome.result.notificationStatus, 'pending');
  assert.deepEqual(outcome.result.notifications, {
    total: 1,
    pending: 1,
    skipped: 0,
    inserted: 1
  });
  assert.ok(workedCommands.some(call => call.sql === 'BEGIN'));
  assert.ok(workedCommands.some(call => /INSERT INTO notifications/i.test(call.rawSql)));
  assert.ok(workedCommands.some(call => /INSERT INTO application_events/i.test(call.rawSql)));
  assert.ok(workedCommands.some(call => call.sql === 'COMMIT'));
});

test('Postgres write adapter rejects still-unsupported commands with a stable code', async () => {
  const adapter = createPostgresWriteBookingStorageAdapter({
    pool: { async connect() { throw new Error('connect must not be called'); } }
  });
  await assert.rejects(
    () => adapter.applyCommand({ action: 'future_unimplemented_command' }, trainee),
    err => err instanceof BookingCommandNotImplementedError
      && err.code === 'BOOKING_COMMAND_NOT_IMPLEMENTED_IN_POSTGRES'
  );
  await assert.rejects(
    () => adapter.applyCommand({}, recruiter),
    err => err instanceof BookingCommandNotImplementedError
  );
});
