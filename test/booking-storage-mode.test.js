import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOOKING_STORAGE_MODES,
  BookingStorageReadOnlyError,
  bookingStorageMode
} from '../src/booking-storage-mode.js';

test('booking storage defaults to JSON and accepts explicit Postgres read-only mode', () => {
  assert.equal(bookingStorageMode({}), BOOKING_STORAGE_MODES.JSON);
  assert.equal(
    bookingStorageMode({ BOOKING_STORAGE_MODE: ' POSTGRES_READONLY ' }),
    BOOKING_STORAGE_MODES.POSTGRES_READONLY
  );
  assert.throws(
    () => bookingStorageMode({ BOOKING_STORAGE_MODE: 'postgres' }),
    /must be "json" or "postgres_readonly"/
  );
});

test('Postgres read-only writes fail with a stable API error', () => {
  const error = new BookingStorageReadOnlyError();

  assert.equal(error.status, 503);
  assert.equal(error.code, 'BOOKING_STORAGE_READ_ONLY');
  assert.match(error.message, /только для чтения/);
});
