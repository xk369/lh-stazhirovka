import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';
import { readBookingStateFromPostgres } from '../src/postgres/read-booking-state.js';
import {
  PostgresCommandConflictError,
  PostgresCommandValidationError,
  markExperiencedInPostgres
} from '../src/postgres/write-booking-command.js';

const pool = createPostgresPool();
const recruiter = {
  role: 'recruiter',
  telegram: {
    user: {
      id: 'postgres-smoke-recruiter'
    }
  }
};

const SHIFT_LEGACY_ID = 940000;
const PASSED_APP_LEGACY_ID = 940001;
const FEEDBACK_APP_LEGACY_ID = 940002;

async function seedExperiencedCandidates(seedIso) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftUuid = randomUUID();
    const passedUuid = randomUUID();
    const feedbackUuid = randomUUID();

    await client.query(
      `
        INSERT INTO shifts (
          id, legacy_id, date, seats, open, canceled,
          created_at, updated_at
        )
        VALUES ($1, $2, '2026-09-14', 2, false, false, $3, $3)
      `,
      [shiftUuid, SHIFT_LEGACY_ID, seedIso]
    );

    await client.query(
      `
        INSERT INTO applications (
          id, legacy_id, shift_id, invite_group_id,
          trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username,
          name, phone, training, training_date, attempt, limits, status,
          venue_id, group_link, candidate_report, experience,
          mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
          mentor_decision, mentor_report_venue_id, mentor_report_venue,
          mentor_report_loft, mentor_report_hall,
          mentor_comment_for_trainee, mentor_comment_sent_at,
          mentor_comment_delivery_status, mentor_comment_delivery_error,
          created_at, updated_at
        ) VALUES
          ($1, $2, $3, NULL,
           '940001', '940001', 'mark_experienced_passed',
           'Mark Experienced Passed', '+7 999 040-00-01', 'passed', '2026-08-01',
           'first', '', 'passed',
           'loft1', 'https://t.me/+mark_experienced_smoke', true, NULL,
           true, $6, 'mentor-smoke',
           'passed', 'loft1', 'LOFT #1',
           'LOFT #1', '',
           '', NULL,
           NULL, '',
           $6, $6),
          ($4, $5, $3, NULL,
           '940002', '940002', 'mark_experienced_feedback',
           'Mark Experienced Feedback', '+7 999 040-00-02', 'passed', '2026-08-01',
           'repeat', '', 'feedback',
           'loft1', 'https://t.me/+mark_experienced_smoke', false, NULL,
           false, NULL, NULL,
           '', '', '',
           '', '',
           '', NULL,
           NULL, '',
           $6, $6)
      `,
      [
        passedUuid,
        PASSED_APP_LEGACY_ID,
        shiftUuid,
        feedbackUuid,
        FEEDBACK_APP_LEGACY_ID,
        seedIso
      ]
    );

    await client.query(
      'UPDATE booking_state_meta SET version = version + 1, updated_at = $1 WHERE singleton = true',
      [seedIso]
    );
    await client.query('COMMIT');
    return { passedUuid, feedbackUuid };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

try {
  const beforeState = await readBookingStateFromPostgres(pool);
  const seedIso = '2026-07-29T20:40:00.000Z';
  await seedExperiencedCandidates(seedIso);

  const seededState = await readBookingStateFromPostgres(pool);
  assert.equal(seededState.version, beforeState.version + 1);
  const targetApp = seededState.applications.find(app => Number(app.id) === PASSED_APP_LEGACY_ID);
  assert.equal(targetApp.status, 'passed');
  assert.equal(targetApp.experience, undefined);

  const markNow = new Date('2026-07-29T20:45:00.000Z');
  const result = await markExperiencedInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'mark_experienced',
      baseVersion: seededState.version,
      applicationId: PASSED_APP_LEGACY_ID
    },
    now: markNow
  });
  assert.equal(result.changed, true);
  assert.equal(result.applicationLegacyId, PASSED_APP_LEGACY_ID);
  assert.equal(result.previousExperience, null);
  assert.equal(result.nextExperience, 'experienced');
  assert.equal(result.shiftLegacyId, SHIFT_LEGACY_ID);
  assert.equal(result.previousVersion, seededState.version);
  assert.equal(result.version, seededState.version + 1);

  const afterMarkState = await readBookingStateFromPostgres(pool);
  assert.equal(afterMarkState.version, result.version);
  const experiencedApp = afterMarkState.applications.find(
    app => Number(app.id) === PASSED_APP_LEGACY_ID
  );
  assert.equal(experiencedApp.status, 'passed');
  assert.equal(experiencedApp.experience, 'experienced');

  const eventResult = await pool.query(
    `
      SELECT application_events.event_type,
             application_events.actor_type,
             application_events.actor_telegram_user_id,
             application_events.payload,
             applications.legacy_id AS application_legacy_id,
             shifts.legacy_id AS shift_legacy_id
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
        JOIN shifts ON shifts.id = application_events.shift_id
       WHERE application_events.event_type = 'experienced_marked'
         AND applications.legacy_id = $1
    `,
    [PASSED_APP_LEGACY_ID]
  );
  assert.equal(eventResult.rowCount, 1);
  const event = eventResult.rows[0];
  assert.equal(event.actor_type, 'recruiter');
  assert.equal(event.actor_telegram_user_id, 'postgres-smoke-recruiter');
  assert.equal(Number(event.application_legacy_id), PASSED_APP_LEGACY_ID);
  assert.equal(Number(event.shift_legacy_id), SHIFT_LEGACY_ID);
  assert.equal(event.payload.action, 'mark_experienced');
  assert.equal(event.payload.previousExperience, null);
  assert.equal(event.payload.nextExperience, 'experienced');
  assert.equal(event.payload.previousVersion, seededState.version);
  assert.equal(event.payload.nextVersion, result.version);

  const noOpNow = new Date('2026-07-29T20:50:00.000Z');
  const noOpResult = await markExperiencedInPostgres({
    pool,
    actor: recruiter,
    command: {
      action: 'mark_experienced',
      baseVersion: afterMarkState.version,
      applicationId: PASSED_APP_LEGACY_ID
    },
    now: noOpNow
  });
  assert.equal(noOpResult.changed, false);
  assert.equal(noOpResult.version, afterMarkState.version);
  const afterNoOpState = await readBookingStateFromPostgres(pool);
  assert.equal(afterNoOpState.version, afterMarkState.version);
  const eventCount = await pool.query(
    `
      SELECT COUNT(*)::int AS count
        FROM application_events
        JOIN applications ON applications.id = application_events.application_id
       WHERE application_events.event_type = 'experienced_marked'
         AND applications.legacy_id = $1
    `,
    [PASSED_APP_LEGACY_ID]
  );
  assert.equal(eventCount.rows[0].count, 1);

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'mark_experienced',
        baseVersion: afterNoOpState.version - 1,
        applicationId: PASSED_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T20:55:00.000Z')
    }),
    err => err instanceof PostgresCommandConflictError
  );

  await assert.rejects(
    () => markExperiencedInPostgres({
      pool,
      actor: recruiter,
      command: {
        action: 'mark_experienced',
        baseVersion: afterNoOpState.version,
        applicationId: FEEDBACK_APP_LEGACY_ID
      },
      now: new Date('2026-07-29T21:00:00.000Z')
    }),
    err => err instanceof PostgresCommandValidationError && /прошёл стажировку/.test(err.message)
  );

  const finalState = await readBookingStateFromPostgres(pool);
  assert.equal(finalState.version, afterNoOpState.version);

  console.log('PostgreSQL mark_experienced write smoke passed.');
} finally {
  await pool.end();
}
