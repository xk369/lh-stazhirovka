import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  BOOKING_STORAGE_MODES,
  BookingStorageReadOnlyError,
  bookingStorageMode,
  isRuntimeWiredBookingStorageMode
} from '../src/booking-storage-mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('booking storage defaults to JSON and accepts explicit Postgres read-only mode', () => {
  assert.equal(bookingStorageMode({}), BOOKING_STORAGE_MODES.JSON);
  assert.equal(
    bookingStorageMode({ BOOKING_STORAGE_MODE: ' POSTGRES_READONLY ' }),
    BOOKING_STORAGE_MODES.POSTGRES_READONLY
  );
  assert.throws(
    () => bookingStorageMode({ BOOKING_STORAGE_MODE: 'sqlite' }),
    /must be "json", "postgres_readonly" or "postgres"/
  );
});

test('Postgres writable mode is a valid enum value but is not yet wired into runtime', () => {
  assert.equal(
    bookingStorageMode({ BOOKING_STORAGE_MODE: ' Postgres ' }),
    BOOKING_STORAGE_MODES.POSTGRES
  );
  assert.equal(isRuntimeWiredBookingStorageMode(BOOKING_STORAGE_MODES.JSON), true);
  assert.equal(isRuntimeWiredBookingStorageMode(BOOKING_STORAGE_MODES.POSTGRES_READONLY), true);
  assert.equal(isRuntimeWiredBookingStorageMode(BOOKING_STORAGE_MODES.POSTGRES), false);

  const serverSource = readFileSync(
    path.resolve(__dirname, '../src/server.js'),
    'utf8'
  );
  assert.equal(
    /BOOKING_STORAGE_MODES\.POSTGRES(?!_)/.test(serverSource),
    false,
    'src/server.js must not branch on BOOKING_STORAGE_MODES.POSTGRES until Codex wires the write path.'
  );
});

test('Postgres read-only writes fail with a stable API error', () => {
  const error = new BookingStorageReadOnlyError();

  assert.equal(error.status, 503);
  assert.equal(error.code, 'BOOKING_STORAGE_READ_ONLY');
  assert.match(error.message, /только для чтения/);
});
