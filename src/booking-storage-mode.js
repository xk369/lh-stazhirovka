export const BOOKING_STORAGE_MODES = Object.freeze({
  JSON: 'json',
  POSTGRES_READONLY: 'postgres_readonly',
  POSTGRES: 'postgres'
});

const RUNTIME_WIRED_MODES = new Set([
  BOOKING_STORAGE_MODES.JSON,
  BOOKING_STORAGE_MODES.POSTGRES_READONLY,
  BOOKING_STORAGE_MODES.POSTGRES
]);

export function bookingStorageMode(env = process.env) {
  const mode = String(env.BOOKING_STORAGE_MODE || BOOKING_STORAGE_MODES.JSON)
    .trim()
    .toLowerCase();
  if (!Object.values(BOOKING_STORAGE_MODES).includes(mode)) {
    throw new Error('BOOKING_STORAGE_MODE must be "json", "postgres_readonly" or "postgres".');
  }
  return mode;
}

export function isRuntimeWiredBookingStorageMode(mode) {
  return RUNTIME_WIRED_MODES.has(mode);
}

export class BookingStorageReadOnlyError extends Error {
  constructor() {
    super('Хранилище staging работает только для чтения.');
    this.name = 'BookingStorageReadOnlyError';
    this.status = 503;
    this.code = 'BOOKING_STORAGE_READ_ONLY';
  }
}
