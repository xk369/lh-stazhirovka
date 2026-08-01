import assert from 'node:assert/strict';
import test from 'node:test';
import { insertApplicationEvents } from '../src/postgres/write-application-events.js';

function fakeClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM applications/.test(sql)) {
        return {
          rows: [
            { legacy_id: '100', id: '00000000-0000-4000-8000-000000000100' }
          ]
        };
      }
      if (/FROM shifts/.test(sql)) {
        return {
          rows: [
            { legacy_id: '1', id: '00000000-0000-4000-8000-000000000001' }
          ]
        };
      }
      return { rows: [], rowCount: 1 };
    }
  };
}

test('PostgreSQL application event writer resolves legacy ids and preserves them in payload', async () => {
  const client = fakeClient();
  const result = await insertApplicationEvents(client, [{
    eventType: 'mentor_report_received',
    applicationId: 100,
    shiftId: 1,
    actorType: 'mentor',
    actorTelegramUserId: '700',
    payload: { mentorDecision: 'Стажировка пройдена' },
    createdAt: '2026-07-29T10:00:00.000Z'
  }]);

  assert.equal(result.inserted, 1);
  const insert = client.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.params[1], '00000000-0000-4000-8000-000000000100');
  assert.equal(insert.params[2], '00000000-0000-4000-8000-000000000001');
  assert.equal(insert.params[3], 'mentor_report_received');
  assert.equal(insert.params[4], 'mentor');
  assert.equal(insert.params[5], '700');
  assert.deepEqual(JSON.parse(insert.params[6]), {
    mentorDecision: 'Стажировка пройдена',
    legacyApplicationId: 100,
    legacyShiftId: 1
  });
});

test('PostgreSQL application event writer keeps deleted entity events auditable', async () => {
  const client = fakeClient();
  await insertApplicationEvents(client, [{
    eventType: 'application_cancelled',
    applicationId: 999,
    shiftId: 1,
    actorType: 'recruiter',
    actorTelegramUserId: '1294774551',
    payload: {},
    createdAt: '2026-07-29T10:00:00.000Z'
  }]);

  const insert = client.calls.find(call => /INSERT INTO application_events/.test(call.sql));
  assert.equal(insert.params[1], null);
  assert.equal(insert.params[2], '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(JSON.parse(insert.params[6]), {
    legacyApplicationId: 999,
    legacyShiftId: 1
  });
});
