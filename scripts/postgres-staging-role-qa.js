import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPostgresPool } from '../src/postgres/connection.js';

const baseUrl = String(process.env.STAGING_QA_BASE_URL || 'http://127.0.0.1:3502').replace(/\/$/, '');
const botToken = String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const recruiterIds = String(process.env.RECRUITER_TELEGRAM_IDS || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

if (!botToken) throw new Error('BOT_TOKEN is required for signed staging QA initData.');
if (!recruiterIds.length) throw new Error('RECRUITER_TELEGRAM_IDS is required for staging QA.');

function telegramInitData(user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `staging-qa-${user.id}-${Date.now()}`,
    user: JSON.stringify(user)
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

async function jsonRequest(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, options);
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    throw new Error(`${route} failed with ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function stateCommand(initData, payload) {
  return jsonRequest('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData, ...payload })
  });
}

function futureQaDate(existingDates) {
  const used = new Set(existingDates);
  for (let day = 1; day <= 28; day += 1) {
    const date = `2031-01-${String(day).padStart(2, '0')}`;
    if (!used.has(date)) return date;
  }
  throw new Error('Could not find a free QA date.');
}

function nextSyntheticApplicationId(applications) {
  const maxId = applications.reduce((max, application) => {
    const id = Number(application.id) || 0;
    return Math.max(max, id);
  }, 0);
  return maxId + 100_000;
}

async function recruiterState(initData) {
  return jsonRequest('/api/state', {
    headers: { 'x-telegram-init-data': initData }
  });
}

const recruiterInitData = telegramInitData({
  id: Number(recruiterIds[0]),
  first_name: 'Migration',
  last_name: 'Recruiter'
});
const traineeUserId = Number(process.env.STAGING_QA_TRAINEE_ID || 990_000_901);
const mentorUserId = Number(process.env.STAGING_QA_MENTOR_ID || 990_000_902);
const linkTraineeUserId = Number(process.env.STAGING_QA_LINK_TRAINEE_ID || 990_000_903);
const traineeInitData = telegramInitData({
  id: traineeUserId,
  first_name: 'QA',
  last_name: 'Trainee',
  username: 'qa_migration_trainee'
});
const mentorInitData = telegramInitData({
  id: mentorUserId,
  first_name: 'QA',
  last_name: 'Mentor',
  username: 'qa_migration_mentor'
});
const linkTraineeInitData = telegramInitData({
  id: linkTraineeUserId,
  first_name: 'QA',
  last_name: 'Link',
  username: 'qa_migration_link'
});

const health = await jsonRequest('/api/health');
assert.equal(health.telegramDeliveryMode, 'dry_run');
assert.equal(health.bookingStorageMode, 'postgres');
assert.equal(health.bookingStorageWritable, true);

let current = await recruiterState(recruiterInitData);
assert.equal(current.role, 'recruiter');
let version = current.state.version;

const qaDate = futureQaDate(current.state.shifts.map(shift => shift.date));
const applicationId = nextSyntheticApplicationId(current.state.applications);
const traineeName = `QA Migration ${applicationId}`;

let response = await stateCommand(recruiterInitData, {
  action: 'create_shift',
  baseVersion: version,
  date: qaDate,
  seats: 2
});
version = response.state.version;
const shift = response.state.shifts.find(item => item.date === qaDate);
assert.ok(shift, 'created shift is returned in recruiter state');

response = await stateCommand(traineeInitData, {
  action: 'upsert_trainee_application',
  baseVersion: version,
  application: {
    id: applicationId,
    shiftId: null,
    name: traineeName,
    phone: '+7 999 000-00-01',
    training: 'passed',
    trainingDate: '2026-07-20',
    attempt: 'first',
    limits: 'QA dry-run',
    status: 'queue',
    telegramCode: 'qa_migration_trainee'
  }
});
assert.equal(response.role, 'trainee');

current = await recruiterState(recruiterInitData);
version = current.state.version;
const queuedApplication = current.state.applications.find(item => item.id === applicationId);
assert.equal(queuedApplication?.status, 'queue');
assert.equal(queuedApplication?.shiftId ?? null, null);
assert.ok(queuedApplication?.queueJoinedAt, 'queue application stores queueJoinedAt');

response = await stateCommand(recruiterInitData, {
  action: 'request_assignment_confirmation',
  baseVersion: version,
  applicationId,
  shiftId: shift.id
});
version = response.state.version;
const assignmentOffer = response.result?.assignmentOffer
  || response.state.applications.find(item => item.id === applicationId)?.assignmentOffer;
assert.ok(assignmentOffer?.token, 'assignment offer token is returned');

response = await jsonRequest('/api/assignment-offer/respond', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: traineeInitData,
    applicationId,
    token: assignmentOffer.token,
    decision: 'accept'
  })
});
assert.equal(response.result.status, 'accepted');
assert.equal(response.result.nextStatus, 'confirmed');

current = await recruiterState(recruiterInitData);
version = current.state.version;
const confirmedApplication = current.state.applications.find(item => item.id === applicationId);
assert.equal(confirmedApplication?.status, 'confirmed');
assert.equal(confirmedApplication?.shiftId, shift.id);
assert.ok(!confirmedApplication?.queueJoinedAt, 'queueJoinedAt is cleared after assignment');

response = await stateCommand(recruiterInitData, {
  action: 'send_invites',
  baseVersion: version,
  shiftId: shift.id,
  venueId: 'loft5_small',
  link: 'https://t.me/+MigrationDryRunQa',
  memberIds: [applicationId]
});
version = response.state.version;
assert.equal(response.result.notifications.pending, 1);

response = await stateCommand(recruiterInitData, {
  action: 'set_application_status',
  baseVersion: version,
  applicationId,
  status: 'feedback'
});
version = response.state.version;
assert.equal(response.result.nextStatus, 'feedback');

const reportText = [
  'Дата стажировки: 2031-01-01',
  'Зал: LOFT #5 SMALL',
  'Наставник: QA Mentor',
  `Стажёр: ${traineeName} (@qa_migration_trainee)`,
  'Выполнено: 29 из 29 пунктов',
  'РЕШЕНИЕ',
  '🟢 Стажировка пройдена.'
].join('\n');

const reportResult = await jsonRequest('/api/report', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    initData: mentorInitData,
    role: 'mentor',
    applicationId,
    mentorTraineeName: traineeName,
    mentorDecision: 'Стажировка пройдена',
    mentorCommentForTrainee: 'QA комментарий для dry-run.',
    mentorTraineeResult: {
      date: qaDate,
      venue: 'LOFT #5 SMALL',
      venueId: 'loft5_small',
      venueLoft: 'LOFT #5',
      hall: 'SMALL',
      mastered: 29,
      total: 29,
      decision: 'Стажировка пройдена',
      topicsToRepeat: []
    },
    reportText
  })
});
assert.equal(reportResult.queued, true);
assert.equal(reportResult.messageId, null);
assert.equal(reportResult.result.nextStatus, 'passed');
assert.equal(reportResult.result.notifications.total, 2);

current = await recruiterState(recruiterInitData);
const finalApplication = current.state.applications.find(item => item.id === applicationId);
assert.equal(finalApplication.status, 'passed');
assert.equal(finalApplication.mentorReport, true);

const pool = createPostgresPool();
try {
  const linkIdResult = await pool.query(
    'SELECT COALESCE(MAX(legacy_id), 0) + 200000 AS next_legacy_id FROM applications'
  );
  const linkApplicationId = Number(linkIdResult.rows[0].next_legacy_id);
  const linkApplicationUuid = crypto.randomUUID();
  const linkCandidateProfileUuid = crypto.randomUUID();
  const linkName = `QA Link ${linkApplicationId}`;
  const linkPhone = '+7 999 000-00-03';
  await pool.query(
    `
      INSERT INTO candidate_profiles (
        id, telegram_user_id, telegram_chat_id, telegram_username, full_name,
        phone, source, current_stage, created_at, updated_at
      )
      VALUES ($1, NULL, NULL, '', $2, $3, 'staging_role_qa', 'internship_queue', now(), now())
    `,
    [linkCandidateProfileUuid, linkName, linkPhone]
  );
  await pool.query(
    `
      INSERT INTO applications (
        id, legacy_id, candidate_profile_id, name, phone, training, training_date, attempt,
        limits, status, telegram_code, queue_joined_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'passed', $6, 'first', $7, 'queue', $8, now(), now(), now())
    `,
    [
      linkApplicationUuid,
      linkApplicationId,
      linkCandidateProfileUuid,
      linkName,
      linkPhone,
      '2026-07-20',
      'telegram link QA',
      'qa_migration_link'
    ]
  );

  const linkResult = await jsonRequest('/api/telegram/link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      initData: linkTraineeInitData,
      applicationId: linkApplicationId
    })
  });
  assert.equal(linkResult.role, 'trainee');
  assert.equal(linkResult.application.telegramUserId, String(linkTraineeUserId));
  assert.equal(linkResult.application.telegramChatId, String(linkTraineeUserId));
  assert.equal(linkResult.application.telegramUsername, 'qa_migration_link');

  const linkRows = await pool.query(
    `
      SELECT trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username
        FROM applications
       WHERE id = $1
    `,
    [linkApplicationUuid]
  );
  assert.equal(linkRows.rowCount, 1);
  assert.equal(linkRows.rows[0].trainee_telegram_user_id, String(linkTraineeUserId));
  assert.equal(linkRows.rows[0].trainee_telegram_chat_id, String(linkTraineeUserId));
  assert.equal(linkRows.rows[0].telegram_username, 'qa_migration_link');

  const notificationRows = await pool.query(
    `
      SELECT type, chat_target, status, COUNT(*)::int AS count
        FROM notifications
       WHERE application_id = (SELECT id FROM applications WHERE legacy_id = $1)
       GROUP BY type, chat_target, status
       ORDER BY type, chat_target, status
    `,
    [applicationId]
  );
  const notificationSummary = notificationRows.rows.map(row => ({
    type: row.type,
    chatTarget: row.chat_target,
    status: row.status,
    count: Number(row.count)
  }));
  assert.ok(notificationSummary.some(row => row.type === 'send_invites' && row.status === 'pending'));
  assert.ok(notificationSummary.some(row => row.type === 'mentor_report' && row.status === 'pending'));
  assert.ok(notificationSummary.some(row => row.type === 'mentor_result' && row.status === 'pending'));

  const eventRows = await pool.query(
    `
      SELECT event_type
        FROM application_events
       WHERE application_id = (SELECT id FROM applications WHERE legacy_id = $1)
       ORDER BY created_at, event_type
    `,
    [applicationId]
  );
  const eventTypes = eventRows.rows.map(row => row.event_type);
  for (const expectedEvent of [
    'application_created',
    'assignment_offer_requested',
    'assignment_offer_accepted',
    'application_assigned_to_shift',
    'application_invited',
    'attendance_marked_feedback',
    'mentor_report_received',
    'application_passed',
    'mentor_result_notification_queued',
    'mentor_report_group_notification_queued'
  ]) {
    assert.ok(eventTypes.includes(expectedEvent), `missing ${expectedEvent}`);
  }

  const linkEventRows = await pool.query(
    `
      SELECT event_type
        FROM application_events
       WHERE application_id = $1
         AND event_type = 'telegram_application_linked'
    `,
    [linkApplicationUuid]
  );
  assert.equal(linkEventRows.rowCount, 1);

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    date: qaDate,
    shiftId: shift.id,
    applicationId,
    linkApplicationId,
    finalStatus: finalApplication.status,
    notificationSummary,
    checkedEvents: eventTypes.length
  }, null, 2));
} finally {
  await pool.end();
}
