import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_SOURCES,
  WRITE_TABLES,
  assertBookingWriteCommandContracts,
  bookingWriteCommandActions,
  bookingWriteCommandContract
} from '../src/postgres/booking-command-contracts.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, '..');

function applyBookingCommandCases() {
  const serverSource = fs.readFileSync(path.join(rootDir, 'src/server.js'), 'utf8');
  const match = serverSource.match(/function applyBookingCommand[\s\S]*?default:\n\s+throw new BookingValidationError/);
  assert.ok(match, 'applyBookingCommand switch block should be discoverable');
  return [...match[0].matchAll(/case '([^']+)'/g)]
    .map(item => item[1])
    .sort((left, right) => left.localeCompare(right));
}

test('PostgreSQL write command contracts are internally valid', () => {
  assert.equal(assertBookingWriteCommandContracts(), true);
});

test('every /api/state booking action has a PostgreSQL write contract', () => {
  assert.deepEqual(
    bookingWriteCommandActions({ source: COMMAND_SOURCES.API_STATE }),
    applyBookingCommandCases()
  );
});

test('mentor report finalization contract protects against duplicate submits', () => {
  const reportContract = bookingWriteCommandContract('mentor_report_result');

  assert.ok(reportContract);
  assert.equal(reportContract.source, COMMAND_SOURCES.API_REPORT);
  assert.equal(reportContract.requiresBaseVersion, false);
  assert.equal(reportContract.requiresOutbox, true);
  assert.ok(reportContract.idempotencyKey.includes('application_id'));
  assert.ok(reportContract.writes.includes(WRITE_TABLES.MENTOR_REPORTS));
  assert.ok(reportContract.writes.includes(WRITE_TABLES.NOTIFICATIONS));
  assert.ok(reportContract.eventTypes.includes('mentor_report_received'));
  assert.ok(reportContract.eventTypes.includes('application_passed'));
  assert.ok(reportContract.eventTypes.includes('application_failed'));
});

test('telegram link contract is outside /api/state but still audited', () => {
  const command = bookingWriteCommandContract('link_telegram_application');

  assert.ok(command);
  assert.equal(command.source, COMMAND_SOURCES.API_TELEGRAM_LINK);
  assert.equal(command.requiresBaseVersion, false);
  assert.deepEqual(command.actorRoles, ['trainee', 'recruiter']);
  assert.ok(command.writes.includes(WRITE_TABLES.APPLICATIONS));
  assert.ok(command.writes.includes(WRITE_TABLES.APPLICATION_EVENTS));
  assert.deepEqual(command.eventTypes, ['telegram_application_linked']);
});

test('commands that notify trainees declare outbox writes and idempotency', () => {
  const notifyingActions = [
    'step_back_application',
    'cancel_shift',
    'cancel_internship',
    'update_shift_capacity',
    'send_invites',
    'mentor_report_result',
    'trainee_report_submission'
  ];

  for (const action of notifyingActions) {
    const command = bookingWriteCommandContract(action);
    assert.ok(command, `${action} contract missing`);
    assert.equal(command.requiresOutbox, true, `${action} must require outbox`);
    assert.ok(command.writes.includes(WRITE_TABLES.NOTIFICATIONS), `${action} must write notifications`);
    assert.ok(command.idempotencyKey, `${action} must declare idempotency`);
  }
});

test('trainee report submission contract is report-only outbox plus audit event', () => {
  const command = bookingWriteCommandContract('trainee_report_submission');

  assert.ok(command);
  assert.equal(command.source, COMMAND_SOURCES.API_REPORT);
  assert.equal(command.requiresBaseVersion, false);
  assert.equal(command.returnsFreshState, false);
  assert.deepEqual(command.locks, []);
  assert.ok(command.writes.includes(WRITE_TABLES.NOTIFICATIONS));
  assert.ok(command.writes.includes(WRITE_TABLES.APPLICATION_EVENTS));
  assert.deepEqual(command.eventTypes, ['trainee_report_received']);
});

test('unknown write command has no contract', () => {
  assert.equal(bookingWriteCommandContract('unknown_action'), null);
});
