import { BOOKING_STORAGE_MODES, BookingStorageReadOnlyError } from '../booking-storage-mode.js';
import { readBookingStateFromPostgres } from '../postgres/read-booking-state.js';
import {
  assignShiftInPostgres,
  cancelInternshipInPostgres,
  cancelShiftInPostgres,
  createShiftInPostgres,
  markExperiencedInPostgres,
  sendInvitesInPostgres,
  setApplicationStatusInPostgres,
  stepBackApplicationInPostgres,
  updateShiftCapacityInPostgres
} from '../postgres/write-booking-command.js';

export class BookingCommandNotImplementedError extends Error {
  constructor(action) {
    super(`Postgres write path for "${action || 'unknown'}" is not implemented yet.`);
    this.name = 'BookingCommandNotImplementedError';
    this.code = 'BOOKING_COMMAND_NOT_IMPLEMENTED_IN_POSTGRES';
    this.status = 501;
  }
}

export function createJsonBookingStorageAdapter({ readState, applyCommand }) {
  if (typeof readState !== 'function' || typeof applyCommand !== 'function') {
    throw new TypeError('json adapter requires readState() and applyCommand() functions.');
  }
  return {
    mode: BOOKING_STORAGE_MODES.JSON,
    readState: () => readState(),
    applyCommand: (command, actor) => applyCommand(command, actor)
  };
}

export function createPostgresReadOnlyBookingStorageAdapter({ pool }) {
  if (!pool) throw new TypeError('postgres_readonly adapter requires a pg pool.');
  return {
    mode: BOOKING_STORAGE_MODES.POSTGRES_READONLY,
    readState: () => readBookingStateFromPostgres(pool),
    applyCommand: () => {
      throw new BookingStorageReadOnlyError();
    }
  };
}

export function createPostgresWriteBookingStorageAdapter({
  pool,
  now = () => new Date(),
  readFreshState = () => readBookingStateFromPostgres(pool)
}) {
  if (!pool) throw new TypeError('postgres write adapter requires a pg pool.');

  const commandHandlers = {
    async create_shift(command, actor) {
      const result = await createShiftInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async update_shift_capacity(command, actor) {
      const result = await updateShiftCapacityInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async set_application_status(command, actor) {
      const result = await setApplicationStatusInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async assign_shift(command, actor) {
      const result = await assignShiftInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async send_invites(command, actor) {
      const result = await sendInvitesInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async cancel_internship(command, actor) {
      const result = await cancelInternshipInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async cancel_shift(command, actor) {
      const result = await cancelShiftInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async step_back_application(command, actor) {
      const result = await stepBackApplicationInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    },
    async mark_experienced(command, actor) {
      const result = await markExperiencedInPostgres({ pool, actor, command, now: now() });
      const state = await readFreshState();
      return { state, result };
    }
  };

  return {
    mode: BOOKING_STORAGE_MODES.POSTGRES,
    readState: () => readBookingStateFromPostgres(pool),
    async applyCommand(command, actor) {
      const action = String(command?.action || '').trim();
      const handler = commandHandlers[action];
      if (!handler) throw new BookingCommandNotImplementedError(action);
      return handler(command, actor);
    }
  };
}
