import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditBookingStateShape,
  buildBookingImportPlan
} from '../src/postgres/import-booking-state.js';
import {
  bookingStateParitySnapshot,
  verifyBookingStateParity
} from '../src/postgres/read-booking-state.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, '../db/migrations');

async function allMigrationSql() {
  const files = (await fs.readdir(migrationsDir))
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
  return (await Promise.all(
    files.map(file => fs.readFile(path.join(migrationsDir, file), 'utf8'))
  )).join('\n');
}

function sourceState() {
  return {
    version: 7,
    updatedAt: '2026-07-26T18:00:00.000Z',
    shifts: [{
      id: 100,
      date: '2026-07-26',
      seats: 4,
      open: false,
      canceled: false
    }],
    applications: [
      {
        id: 200,
        shiftId: 100,
        inviteGroupId: 300,
        name: 'Passed Trainee',
        phone: '+7 999 111-22-33',
        training: 'passed',
        trainingDate: '2026-07-20',
        attempt: 'first',
        limits: '',
        status: 'passed',
        venueId: 'loft5_small',
        groupLink: 'https://t.me/+group',
        telegramUserId: '900',
        telegramChatId: '900',
        telegramUsername: 'passed_trainee',
        mentorReport: true,
        mentorReportAt: '2026-07-26T18:00:00.000Z',
        mentorReporterTelegramUserId: '800',
        mentorDecision: 'Стажировка пройдена',
        mentorCommentDeliveryStatus: 'sent'
      },
      {
        id: 201,
        shiftId: 100,
        inviteGroupId: 300,
        name: 'Waiting Trainee',
        phone: '+7 999 444-55-66',
        training: 'not_passed',
        attempt: 'repeat',
        limits: '',
        status: 'feedback',
        venueId: 'loft5_small',
        groupLink: 'https://t.me/+group',
        telegramUserId: '901',
        telegramChatId: '901',
        telegramUsername: 'waiting_trainee'
      }
    ],
    inviteGroups: [{
      id: 300,
      shiftId: 100,
      venueId: 'loft5_small',
      link: 'https://t.me/+group',
      memberIds: [200, 201],
      sentAt: '2026-07-26T12:00:00.000Z'
    }]
  };
}

test('PostgreSQL schema contains every target business table', async () => {
  const sql = await allMigrationSql();
  const tables = [
    'booking_state_meta',
    'data_imports',
    'telegram_users',
    'recruiters',
    'candidate_profiles',
    'candidate_identity_review_items',
    'shifts',
    'invite_groups',
    'applications',
    'interview_slots',
    'interview_participants',
    'candidate_resource_deliveries',
    'candidate_link_clicks',
    'invite_group_members',
    'mentor_reports',
    'mentor_report_topics',
    'notifications',
    'application_events',
    'candidate_events'
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(sql, /idempotency_key text UNIQUE/);
  assert.match(sql, /row_version bigint NOT NULL DEFAULT 1/);
  assert.match(sql, /ADD COLUMN candidate_profile_id uuid REFERENCES candidate_profiles\(id\)/);
  assert.match(sql, /ADD COLUMN queue_joined_at timestamptz/);
  assert.match(sql, /interview_slots_active_datetime_idx/);
  assert.match(sql, /candidate_identity_review_items_open_unique_idx/);
  assert.match(sql, /'registration_bot'/);
  assert.match(sql, /'staff_bot'/);
  assert.match(sql, /'unattested_group'/);
  assert.match(sql, /'helper_bot'/);
  assert.match(sql, /'self_employment'/);
});

test('Docker image contains PostgreSQL migration runtime files', async () => {
  const dockerfile = await fs.readFile(
    new URL('../Dockerfile', import.meta.url),
    'utf8'
  );

  assert.match(dockerfile, /^COPY db \.\/db$/m);
  assert.match(dockerfile, /^COPY scripts \.\/scripts$/m);
});

test('JSON import plan preserves counts, relationships, statuses and mentor result', () => {
  const plan = buildBookingImportPlan(sourceState(), new Date('2026-07-26T19:00:00.000Z'));

  assert.equal(plan.state.version, 7);
  assert.equal(plan.shifts.length, 1);
  assert.equal(plan.applications.length, 2);
  assert.equal(plan.inviteGroups.length, 1);
  assert.equal(plan.inviteGroupMembers.length, 2);
  assert.equal(plan.candidateProfiles.length, 2);
  assert.equal(plan.telegramUsers.length, 2);
  assert.equal(plan.mentorReports.length, 1);
  assert.deepEqual(plan.applications.map(row => row.status), ['passed', 'feedback']);
  assert.ok(plan.applications.every(application => uuidPattern.test(application.candidateProfileId)));
  assert.ok(plan.candidateProfiles.every(profile => uuidPattern.test(profile.id)));
  assert.equal(plan.mentorReports[0].resultStatus, 'passed');
  assert.equal(plan.inviteGroupMembers[0].inviteGroupId, plan.inviteGroups[0].id);
  assert.ok(plan.inviteGroupMembers.every(link => (
    plan.applications.some(application => application.id === link.applicationId)
  )));
  assert.ok(plan.applications.every(application => uuidPattern.test(application.id)));
});

test('JSON import plan preserves queue join time only for queue applications', () => {
  const source = sourceState();
  source.applications[0].queueJoinedAt = '2026-07-01T10:00:00.000Z';
  source.applications.push({
    id: 202,
    shiftId: null,
    inviteGroupId: null,
    name: 'Queue Trainee',
    phone: '+7 999 777-88-99',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: '',
    status: 'queue',
    queueJoinedAt: '2026-07-02T09:00:00.000Z',
    telegramUserId: '902',
    telegramChatId: '902',
    telegramUsername: 'queue_trainee'
  });
  source.applications.push({
    id: 203,
    shiftId: null,
    inviteGroupId: null,
    name: 'Legacy Queue Trainee',
    phone: '+7 999 222-33-44',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: '',
    status: 'queue',
    telegramUserId: '903',
    telegramChatId: '903',
    telegramUsername: 'legacy_queue_trainee',
    createdAt: '2026-07-03T08:00:00.000Z'
  });
  source.applications.push({
    id: 204,
    shiftId: null,
    inviteGroupId: null,
    name: 'Old Queue Trainee',
    phone: '+7 999 555-66-77',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: '',
    status: 'queue',
    telegramUserId: '904',
    telegramChatId: '904',
    telegramUsername: 'old_queue_trainee'
  });

  const plan = buildBookingImportPlan(source, new Date('2026-07-26T19:00:00.000Z'));
  const byLegacyId = new Map(plan.applications.map(application => [application.legacyId, application]));

  assert.equal(byLegacyId.get(200).queueJoinedAt, null);
  assert.equal(byLegacyId.get(202).queueJoinedAt, '2026-07-02T09:00:00.000Z');
  assert.equal(byLegacyId.get(203).queueJoinedAt, '2026-07-03T08:00:00.000Z');
  assert.equal(byLegacyId.get(204).queueJoinedAt, '2026-07-26T18:00:00.000Z');
});

test('JSON import plan never merges candidates by weak identity fields', () => {
  const source = sourceState();
  for (const application of source.applications) {
    application.telegramUserId = '';
    application.telegramChatId = '';
    application.telegramUsername = 'same_username_after_rename';
    application.phone = '+7 999 111-22-33';
  }

  const plan = buildBookingImportPlan(source, new Date('2026-07-26T19:00:00.000Z'));
  const profileIds = new Set(plan.applications.map(application => application.candidateProfileId));

  assert.equal(plan.candidateProfiles.length, 2);
  assert.equal(profileIds.size, 2);
});

test('JSON import plan deduplicates group membership stored on both sides', () => {
  const plan = buildBookingImportPlan(sourceState());
  const uniqueLinks = new Set(
    plan.inviteGroupMembers.map(link => `${link.inviteGroupId}:${link.applicationId}`)
  );

  assert.equal(uniqueLinks.size, 2);
  assert.equal(plan.inviteGroupMembers.length, 2);
});

test('JSON import refuses unknown fields instead of silently losing them', () => {
  const source = sourceState();
  source.applications[0].futureImportantField = 'must not disappear';

  assert.throws(
    () => auditBookingStateShape(source),
    /applications\[0\]\.futureImportantField/
  );
});

test('PostgreSQL parity snapshot ignores storage-only ordering and timestamps', () => {
  const source = sourceState();
  const restored = structuredClone(source);
  restored.applications.reverse();
  restored.applications.forEach(application => {
    application.createdAt = '2026-07-26T19:00:00.000Z';
  });
  restored.inviteGroups[0].memberIds.reverse();

  assert.deepEqual(
    bookingStateParitySnapshot(restored),
    bookingStateParitySnapshot(source)
  );
  assert.deepEqual(verifyBookingStateParity(source, restored), {
    shifts: 1,
    applications: 2,
    inviteGroups: 1,
    statuses: {
      feedback: 1,
      passed: 1
    }
  });
});

test('PostgreSQL parity snapshot accepts imported queueJoinedAt backfill', () => {
  const source = sourceState();
  const restored = structuredClone(source);
  const legacyQueueApplication = {
    id: 203,
    shiftId: null,
    inviteGroupId: null,
    name: 'Legacy Queue Trainee',
    phone: '+7 999 222-33-44',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: '',
    status: 'queue',
    telegramUserId: '903',
    telegramChatId: '903',
    telegramUsername: 'legacy_queue_trainee',
    createdAt: '2026-07-03T08:00:00.000Z'
  };
  source.applications.push(legacyQueueApplication);
  restored.applications.push({
    ...legacyQueueApplication,
    queueJoinedAt: '2026-07-03T08:00:00.000Z'
  });
  source.applications.push({
    ...legacyQueueApplication,
    id: 204,
    telegramUserId: '904',
    telegramChatId: '904',
    telegramUsername: 'old_queue_trainee',
    createdAt: ''
  });
  restored.applications.push({
    ...legacyQueueApplication,
    id: 204,
    telegramUserId: '904',
    telegramChatId: '904',
    telegramUsername: 'old_queue_trainee',
    createdAt: '',
    queueJoinedAt: source.updatedAt
  });

  assert.deepEqual(
    bookingStateParitySnapshot(restored),
    bookingStateParitySnapshot(source)
  );
});

test('PostgreSQL parity verification rejects a changed business field', () => {
  const source = sourceState();
  const restored = structuredClone(source);
  restored.applications[0].phone = '+7 000 000-00-00';

  assert.throws(
    () => verifyBookingStateParity(source, restored),
    /state\.applications\.0\.phone/
  );
});
