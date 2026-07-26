import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  auditBookingStateShape,
  buildBookingImportPlan
} from '../src/postgres/import-booking-state.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const sql = await fs.readFile(
    new URL('../db/migrations/001_initial.sql', import.meta.url),
    'utf8'
  );
  const tables = [
    'booking_state_meta',
    'data_imports',
    'telegram_users',
    'recruiters',
    'shifts',
    'invite_groups',
    'applications',
    'invite_group_members',
    'mentor_reports',
    'mentor_report_topics',
    'notifications',
    'application_events'
  ];

  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  assert.match(sql, /idempotency_key text UNIQUE/);
  assert.match(sql, /row_version bigint NOT NULL DEFAULT 1/);
});

test('JSON import plan preserves counts, relationships, statuses and mentor result', () => {
  const plan = buildBookingImportPlan(sourceState(), new Date('2026-07-26T19:00:00.000Z'));

  assert.equal(plan.state.version, 7);
  assert.equal(plan.shifts.length, 1);
  assert.equal(plan.applications.length, 2);
  assert.equal(plan.inviteGroups.length, 1);
  assert.equal(plan.inviteGroupMembers.length, 2);
  assert.equal(plan.telegramUsers.length, 2);
  assert.equal(plan.mentorReports.length, 1);
  assert.deepEqual(plan.applications.map(row => row.status), ['passed', 'feedback']);
  assert.equal(plan.mentorReports[0].resultStatus, 'passed');
  assert.equal(plan.inviteGroupMembers[0].inviteGroupId, plan.inviteGroups[0].id);
  assert.ok(plan.inviteGroupMembers.every(link => (
    plan.applications.some(application => application.id === link.applicationId)
  )));
  assert.ok(plan.applications.every(application => uuidPattern.test(application.id)));
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
