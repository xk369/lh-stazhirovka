import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandValidationError,
  updateShiftCapacityInPostgres
} from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const now = new Date('2026-07-29T12:30:00.000Z');
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

const SHIFT_LEGACY_ID = 910030;
const APPLICATION_LEGACY_IDS = [910031, 910032, 910033, 910034];

async function seedCapacityTarget(seedIso) {
  const shiftId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
        )
        VALUES ($1, $2, '2026-10-03'::date, 4, true, false, NULL, $3, $3)
      `,
      [shiftId, SHIFT_LEGACY_ID, seedIso]
    );
    for (const [index, legacyId] of APPLICATION_LEGACY_IDS.entries()) {
      const status = ['pending', 'confirmed', 'invited', 'feedback'][index];
      const chatId = legacyId === 910033 ? '' : String(930030 + index);
      await client.query(
        `
          INSERT INTO applications (
            id, legacy_id, shift_id, invite_group_id,
            trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
            name, phone, training, training_date, attempt, limits, status,
            venue_id, group_link,
            candidate_report, mentor_report_received,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, NULL,
            $4, $4, $5,
            $6, '+7 999 000-10-03', 'passed', '2026-09-22', 'first', '', $7,
            NULL, '',
            false, false,
            $8, $8
          )
        `,
        [
          randomUUID(),
          legacyId,
          shiftId,
          chatId,
          `capacity_smoke_${index + 1}`,
          `Capacity Smoke ${index + 1}`,
          status,
          seedIso
        ]
      );
    }
    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T12:20:00.000Z';
  await seedCapacityTarget(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const targetShift = seededState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(targetShift);
  assert.equal(targetShift.seats, 4);

  const result = await updateShiftCapacityInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'update_shift_capacity',
      baseVersion: seededState.version,
      shiftId: SHIFT_LEGACY_ID,
      seats: 6
    },
    now
  });

  assert.equal(result.changed, true);
  assert.equal(result.legacyId, SHIFT_LEGACY_ID);
  assert.equal(result.previousSeats, 4);
  assert.equal(result.seats, 6);
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);
  assert.equal(result.updatedAt, now.toISOString());
  assert.deepEqual(result.notifications, {
    total: 3,
    pending: 2,
    skipped: 1,
    inserted: 3
  });

  const afterState = await readBookingStateFromPostgres(pool);
  assert.equal(afterState.version, seededState.version + 1);
  assert.equal(afterState.updatedAt, now.toISOString());
  const updatedShift = afterState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(updatedShift);
  assert.equal(updatedShift.seats, 6);

  const eventResult = await pool.query(
    `
      SELECT
        application_events.event_type,
        application_events.actor_type,
        application_events.actor_telegram_user_id,
        application_events.payload,
        shifts.legacy_id AS shift_legacy_id
      FROM application_events
      JOIN shifts ON shifts.id = application_events.shift_id
      WHERE application_events.event_type = 'shift_capacity_changed'
        AND shifts.legacy_id = $1
    `,
    [SHIFT_LEGACY_ID]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'recruiter');
  assert.equal(event.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(event.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(event.payload.action, 'update_shift_capacity');
  assert.equal(event.payload.baseVersion, seededState.version);
  assert.equal(event.payload.previousVersion, seededState.version);
  assert.equal(event.payload.nextVersion, seededState.version + 1);
  assert.equal(event.payload.previousSeats, 4);
  assert.equal(event.payload.nextSeats, 6);
  assert.equal(event.payload.date, '2026-10-03');
  assert.equal(event.payload.legacyShiftId, SHIFT_LEGACY_ID);

  const notificationResult = await pool.query(
    `
      SELECT type, chat_target, text, parse_mode, status, error, idempotency_key
        FROM notifications
       WHERE type = 'shift_capacity_changed'
         AND created_at = $1::timestamptz
       ORDER BY idempotency_key
    `,
    [now.toISOString()]
  );
  assert.equal(notificationResult.rowCount, 3);
  for (const row of notificationResult.rows) {
    assert.equal(row.type, 'shift_capacity_changed');
    assert.equal(row.chat_target, 'trainee');
    assert.equal(row.parse_mode, 'HTML');
    assert.match(row.text, /Изменения по стажировке/);
    assert.match(row.text, /03\.10\.2026/);
    assert.match(row.idempotency_key, /^update_shift_capacity:/);
  }
  assert.equal(
    notificationResult.rows.filter(row => row.status === 'pending' || row.status === 'skipped').length,
    3
  );
  assert.equal(notificationResult.rows.filter(row => row.status === 'pending').length, 2);
  assert.equal(notificationResult.rows.filter(row => row.status === 'skipped').length, 1);

  await assert.rejects(
    () => updateShiftCapacityInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'update_shift_capacity',
        baseVersion: afterState.version,
        shiftId: SHIFT_LEGACY_ID,
        seats: 3
      },
      now: new Date('2026-07-29T12:31:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError
      && /уже записано 4 стажёров/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterState.version);
  const finalShift = finalState.shifts.find(shift => Number(shift.id) === SHIFT_LEGACY_ID);
  assert.ok(finalShift);
  assert.equal(finalShift.seats, 6);

  console.log('PostgreSQL update_shift_capacity write smoke test passed.');
} finally {
  await pool.end();
}
