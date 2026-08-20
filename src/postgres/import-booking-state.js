import { randomUUID } from 'node:crypto';
import { normalizeBookingState } from '../booking-state.js';

const ROOT_FIELDS = new Set(['version', 'updatedAt', 'shifts', 'applications', 'inviteGroups']);
const SHIFT_FIELDS = new Set(['id', 'date', 'seats', 'open', 'canceled', 'canceledAt', 'status']);
const APPLICATION_FIELDS = new Set([
  'id',
  'shiftId',
  'name',
  'phone',
  'training',
  'trainingDate',
  'attempt',
  'limits',
  'status',
  'comment',
  'recruiterComment',
  'recruiterQueueComment',
  'queueComment',
  'queueJoinedAt',
  'assignmentOffer',
  'inviteGroupId',
  'venueId',
  'groupLink',
  'telegramCode',
  'telegramChatId',
  'telegramUserId',
  'telegramUsername',
  'candidateReport',
  'mentorReport',
  'mentorReportAt',
  'mentorReporterTelegramUserId',
  'mentorDecision',
  'mentorReportVenueId',
  'mentorReportVenue',
  'mentorReportLoft',
  'mentorReportHall',
  'mentorCommentForTrainee',
  'mentorCommentSentAt',
  'mentorCommentDeliveryStatus',
  'mentorCommentDeliveryError',
  'experience',
  'createdAt'
]);
const ASSIGNMENT_OFFER_FIELDS = new Set([
  'token',
  'shiftId',
  'requestedAt',
  'expiresAt',
  'requestedByTelegramUserId',
  'messageChatId',
  'messageId'
]);
const INVITE_GROUP_FIELDS = new Set([
  'id',
  'shiftId',
  'venueId',
  'link',
  'memberIds',
  'sentAt'
]);

function unknownFields(value, allowedFields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter(field => !allowedFields.has(field));
}

export function auditBookingStateShape(sourceState) {
  if (!sourceState || typeof sourceState !== 'object' || Array.isArray(sourceState)) {
    throw new Error('Booking JSON root must be an object.');
  }
  for (const field of ['shifts', 'applications', 'inviteGroups']) {
    if (!Array.isArray(sourceState[field])) {
      throw new Error(`Booking JSON ${field} must be an array.`);
    }
  }

  const findings = [];
  for (const field of unknownFields(sourceState, ROOT_FIELDS)) {
    findings.push(`root.${field}`);
  }
  sourceState.shifts.forEach((shift, index) => {
    for (const field of unknownFields(shift, SHIFT_FIELDS)) {
      findings.push(`shifts[${index}].${field}`);
    }
  });
  sourceState.applications.forEach((application, index) => {
    for (const field of unknownFields(application, APPLICATION_FIELDS)) {
      findings.push(`applications[${index}].${field}`);
    }
    if (application?.assignmentOffer && typeof application.assignmentOffer === 'object') {
      for (const field of unknownFields(application.assignmentOffer, ASSIGNMENT_OFFER_FIELDS)) {
        findings.push(`applications[${index}].assignmentOffer.${field}`);
      }
    }
  });
  sourceState.inviteGroups.forEach((group, index) => {
    for (const field of unknownFields(group, INVITE_GROUP_FIELDS)) {
      findings.push(`inviteGroups[${index}].${field}`);
    }
  });

  if (findings.length) {
    throw new Error(
      `Booking JSON contains fields not covered by the migration: ${findings.join(', ')}.`
    );
  }
}

function optionalTimestamp(value) {
  const clean = String(value || '').trim();
  if (!clean) return null;
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function requiredTimestamp(value, fallback) {
  return optionalTimestamp(value) || fallback.toISOString();
}

function mentorResultStatus(application) {
  if (application.status === 'passed' || application.status === 'failed') {
    return application.status;
  }
  if (application.mentorDecision === 'Стажировка пройдена') return 'passed';
  if (application.mentorDecision === 'Требуется повторная стажировка') return 'failed';
  return '';
}

function mapByLegacyId(items) {
  return new Map(items.map(item => [String(item.id), randomUUID()]));
}

function candidateProfileKey(application) {
  const telegramUserId = String(application.traineeTelegramUserId || '').trim();
  if (telegramUserId) return `telegram_user_id:${telegramUserId}`;

  return `application:${application.legacyId}`;
}

function candidateStageFromApplicationStatus(status) {
  const normalized = String(status || 'queue').trim() || 'queue';
  return `internship_${normalized}`;
}

function buildCandidateProfiles(applications, fallbackTimestamp) {
  const profilesByKey = new Map();
  const profileIdByApplicationId = new Map();

  for (const application of applications) {
    const key = candidateProfileKey(application);
    const existing = profilesByKey.get(key);
    const profile = existing || {
      id: randomUUID(),
      telegramUserId: application.traineeTelegramUserId || null,
      telegramChatId: application.traineeTelegramChatId || null,
      telegramUsername: application.telegramUsername || '',
      fullName: application.name,
      phone: application.phone || '',
      source: 'internship_json_import',
      currentStage: candidateStageFromApplicationStatus(application.status),
      createdAt: application.createdAt || fallbackTimestamp,
      updatedAt: fallbackTimestamp
    };

    profile.telegramUserId = profile.telegramUserId || application.traineeTelegramUserId || null;
    profile.telegramChatId = application.traineeTelegramChatId || profile.telegramChatId || null;
    profile.telegramUsername = application.telegramUsername || profile.telegramUsername || '';
    profile.fullName = application.name || profile.fullName;
    profile.phone = application.phone || profile.phone || '';
    profile.currentStage = candidateStageFromApplicationStatus(application.status);
    profile.updatedAt = fallbackTimestamp;

    profilesByKey.set(key, profile);
    profileIdByApplicationId.set(application.id, profile.id);
  }

  return {
    candidateProfiles: [...profilesByKey.values()],
    profileIdByApplicationId
  };
}

function uniqueMemberLinks(state, applicationIdByLegacy, inviteGroupIdByLegacy) {
  const links = new Map();
  const add = (groupLegacyId, applicationLegacyId) => {
    const inviteGroupId = inviteGroupIdByLegacy.get(String(groupLegacyId));
    const applicationId = applicationIdByLegacy.get(String(applicationLegacyId));
    if (!inviteGroupId || !applicationId) return;
    links.set(`${inviteGroupId}:${applicationId}`, { inviteGroupId, applicationId });
  };

  for (const group of state.inviteGroups) {
    for (const applicationId of group.memberIds) add(group.id, applicationId);
  }
  for (const application of state.applications) {
    if (application.inviteGroupId) add(application.inviteGroupId, application.id);
  }
  return [...links.values()];
}

function normalizeAssignmentOfferRows(state, applicationIdByLegacy, shiftIdByLegacy, now) {
  const rows = [];
  for (const application of state.applications) {
    if (application.status !== 'queue') continue;
    const offer = application.assignmentOffer;
    if (!offer || typeof offer !== 'object' || Array.isArray(offer)) continue;

    const token = String(offer.token || '').trim();
    if (!token) {
      throw new Error(`applications.${application.id}.assignmentOffer.token is required.`);
    }
    const applicationId = applicationIdByLegacy.get(String(application.id));
    const shiftId = shiftIdByLegacy.get(String(offer.shiftId));
    if (!applicationId || !shiftId) {
      throw new Error(`applications.${application.id}.assignmentOffer.shiftId references an unknown shift.`);
    }
    const requestedAt = requiredTimestamp(offer.requestedAt, now);
    rows.push({
      id: randomUUID(),
      applicationId,
      shiftId,
      token,
      status: 'active',
      requestedByTelegramUserId: String(offer.requestedByTelegramUserId || '').trim(),
      requestedAt,
      expiresAt: requiredTimestamp(offer.expiresAt, now),
      messageChatId: String(offer.messageChatId || '').trim() || null,
      messageId: offer.messageId === null || offer.messageId === undefined || offer.messageId === ''
        ? null
        : Number(offer.messageId),
      createdAt: requestedAt,
      updatedAt: requestedAt
    });
  }
  return rows;
}

export function buildBookingImportPlan(sourceState, now = new Date()) {
  auditBookingStateShape(sourceState);
  const state = normalizeBookingState(sourceState);
  const shiftIdByLegacy = mapByLegacyId(state.shifts);
  const inviteGroupIdByLegacy = mapByLegacyId(state.inviteGroups);
  const applicationIdByLegacy = mapByLegacyId(state.applications);
  const fallbackTimestamp = requiredTimestamp(state.updatedAt, now);

  const shifts = state.shifts.map(shift => ({
    id: shiftIdByLegacy.get(String(shift.id)),
    legacyId: shift.id,
    date: shift.date,
    seats: shift.seats,
    open: shift.open,
    canceled: shift.canceled,
    canceledAt: optionalTimestamp(shift.canceledAt),
    createdAt: fallbackTimestamp,
    updatedAt: fallbackTimestamp
  }));

  const inviteGroups = state.inviteGroups.map(group => ({
    id: inviteGroupIdByLegacy.get(String(group.id)),
    legacyId: group.id,
    shiftId: shiftIdByLegacy.get(String(group.shiftId)),
    venueId: group.venueId,
    link: group.link,
    sentAt: requiredTimestamp(group.sentAt, now),
    createdAt: requiredTimestamp(group.sentAt, now),
    updatedAt: requiredTimestamp(group.sentAt, now)
  }));

  const applications = state.applications.map(application => ({
    id: applicationIdByLegacy.get(String(application.id)),
    legacyId: application.id,
    shiftId: application.shiftId === null
      ? null
      : shiftIdByLegacy.get(String(application.shiftId)) || null,
    inviteGroupId: application.inviteGroupId
      ? inviteGroupIdByLegacy.get(String(application.inviteGroupId)) || null
      : null,
    traineeTelegramUserId: application.telegramUserId || null,
    traineeTelegramChatId: application.telegramChatId || null,
    telegramUsername: application.telegramUsername || null,
    telegramCode: application.telegramCode || null,
    name: application.name,
    phone: application.phone || '',
    training: application.training,
    trainingDate: application.trainingDate || null,
    attempt: application.attempt,
    limits: application.limits || '',
    status: application.status,
    recruiterComment: application.comment || '',
    recruiterQueueComment: application.recruiterQueueComment || '',
    queueJoinedAt: application.status === 'queue' ? optionalTimestamp(application.queueJoinedAt) : null,
    venueId: application.venueId || null,
    groupLink: application.groupLink || '',
    candidateReport: Boolean(application.candidateReport),
    experience: application.experience || null,
    mentorReportReceived: Boolean(application.mentorReport),
    mentorReportAt: optionalTimestamp(application.mentorReportAt),
    mentorReporterTelegramUserId: application.mentorReporterTelegramUserId || null,
    mentorDecision: application.mentorDecision || '',
    mentorReportVenueId: application.mentorReportVenueId || '',
    mentorReportVenue: application.mentorReportVenue || '',
    mentorReportLoft: application.mentorReportLoft || '',
    mentorReportHall: application.mentorReportHall || '',
    mentorCommentForTrainee: application.mentorCommentForTrainee || '',
    mentorCommentSentAt: optionalTimestamp(application.mentorCommentSentAt),
    mentorCommentDeliveryStatus: application.mentorCommentDeliveryStatus || null,
    mentorCommentDeliveryError: application.mentorCommentDeliveryError || '',
    createdAt: requiredTimestamp(application.createdAt, now),
    updatedAt: fallbackTimestamp
  }));

  const {
    candidateProfiles,
    profileIdByApplicationId
  } = buildCandidateProfiles(applications, fallbackTimestamp);
  for (const application of applications) {
    application.candidateProfileId = profileIdByApplicationId.get(application.id) || null;
  }

  const telegramUsersById = new Map();
  for (const application of applications) {
    if (!application.traineeTelegramUserId) continue;
    const existing = telegramUsersById.get(application.traineeTelegramUserId);
    telegramUsersById.set(application.traineeTelegramUserId, {
      id: existing?.id || randomUUID(),
      telegramUserId: application.traineeTelegramUserId,
      telegramChatId: application.traineeTelegramChatId || existing?.telegramChatId || null,
      username: application.telegramUsername || existing?.username || null,
      createdAt: existing?.createdAt || application.createdAt,
      updatedAt: fallbackTimestamp
    });
  }

  const mentorReports = state.applications.flatMap(application => {
    if (!application.mentorReport) return [];
    const resultStatus = mentorResultStatus(application);
    if (!resultStatus) return [];
    return [{
      id: randomUUID(),
      applicationId: applicationIdByLegacy.get(String(application.id)),
      mentorTelegramUserId: application.mentorReporterTelegramUserId || null,
      resultStatus,
      decision: application.mentorDecision || (
        resultStatus === 'passed' ? 'Стажировка пройдена' : 'Требуется повторная стажировка'
      ),
      venueId: application.mentorReportVenueId || application.venueId || null,
      venueLabel: application.mentorReportVenue || null,
      venueLoft: application.mentorReportLoft || null,
      hall: application.mentorReportHall || null,
      mentorComment: application.mentorCommentForTrainee || null,
      createdAt: requiredTimestamp(application.mentorReportAt, now)
    }];
  });

  const events = applications.map(application => ({
    id: randomUUID(),
    applicationId: application.id,
    shiftId: application.shiftId,
    eventType: 'legacy_application_imported',
    payload: {
      legacyId: application.legacyId,
      status: application.status,
      sourceVersion: state.version
    },
    createdAt: fallbackTimestamp
  }));

  return {
    state,
    candidateProfiles,
    telegramUsers: [...telegramUsersById.values()],
    shifts,
    inviteGroups,
    applications,
    assignmentOffers: normalizeAssignmentOfferRows(state, applicationIdByLegacy, shiftIdByLegacy, now),
    inviteGroupMembers: uniqueMemberLinks(
      state,
      applicationIdByLegacy,
      inviteGroupIdByLegacy
    ),
    mentorReports,
    events
  };
}

async function assertEmptyTarget(client) {
  const tables = [
    'booking_state_meta',
    'data_imports',
    'candidate_profiles',
    'candidate_identity_review_items',
    'interview_slots',
    'interview_participants',
    'candidate_resource_deliveries',
    'candidate_link_clicks',
    'candidate_events',
    'shifts',
    'applications',
    'application_assignment_offers',
    'invite_groups'
  ];
  for (const table of tables) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table}`);
    if (result.rows[0].count !== 0) {
      throw new Error(`PostgreSQL import target is not empty: ${table}.`);
    }
  }
}

async function insertCandidateProfiles(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO candidate_profiles (
        id, telegram_user_id, telegram_chat_id, telegram_username,
        full_name, phone, source, current_stage, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      row.id,
      row.telegramUserId,
      row.telegramChatId,
      row.telegramUsername,
      row.fullName,
      row.phone,
      row.source,
      row.currentStage,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertTelegramUsers(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO telegram_users (
        id, telegram_user_id, telegram_chat_id, username, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      row.id,
      row.telegramUserId,
      row.telegramChatId,
      row.username,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertRecruiters(client, recruiterTelegramIds, now) {
  for (const telegramUserId of recruiterTelegramIds) {
    await client.query(`
      INSERT INTO recruiters (id, telegram_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, $3)
      ON CONFLICT (telegram_user_id) DO NOTHING
    `, [randomUUID(), telegramUserId, now.toISOString()]);
  }
}

async function insertShifts(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO shifts (
        id, legacy_id, date, seats, open, canceled, canceled_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      row.id,
      row.legacyId,
      row.date,
      row.seats,
      row.open,
      row.canceled,
      row.canceledAt,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertInviteGroups(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO invite_groups (
        id, legacy_id, shift_id, venue_id, link, sent_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      row.id,
      row.legacyId,
      row.shiftId,
      row.venueId,
      row.link,
      row.sentAt,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertApplications(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO applications (
        id, legacy_id, candidate_profile_id, shift_id, invite_group_id,
        trainee_telegram_user_id, trainee_telegram_chat_id, telegram_username, telegram_code,
        name, phone, training, training_date, attempt, limits, status,
        recruiter_comment, recruiter_queue_comment, queue_joined_at,
        venue_id, group_link, candidate_report, experience,
        mentor_report_received, mentor_report_at, mentor_reporter_telegram_user_id,
        mentor_decision, mentor_report_venue_id, mentor_report_venue, mentor_report_loft,
        mentor_report_hall, mentor_comment_for_trainee, mentor_comment_sent_at,
        mentor_comment_delivery_status, mentor_comment_delivery_error,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16,
        $17, $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26,
        $27, $28, $29, $30,
        $31, $32, $33,
        $34, $35,
        $36, $37
      )
    `, [
      row.id,
      row.legacyId,
      row.candidateProfileId,
      row.shiftId,
      row.inviteGroupId,
      row.traineeTelegramUserId,
      row.traineeTelegramChatId,
      row.telegramUsername,
      row.telegramCode,
      row.name,
      row.phone,
      row.training,
      row.trainingDate,
      row.attempt,
      row.limits,
      row.status,
      row.recruiterComment,
      row.recruiterQueueComment,
      row.queueJoinedAt,
      row.venueId,
      row.groupLink,
      row.candidateReport,
      row.experience,
      row.mentorReportReceived,
      row.mentorReportAt,
      row.mentorReporterTelegramUserId,
      row.mentorDecision,
      row.mentorReportVenueId,
      row.mentorReportVenue,
      row.mentorReportLoft,
      row.mentorReportHall,
      row.mentorCommentForTrainee,
      row.mentorCommentSentAt,
      row.mentorCommentDeliveryStatus,
      row.mentorCommentDeliveryError,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertAssignmentOffers(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO application_assignment_offers (
        id, application_id, shift_id, token, status, requested_by_telegram_user_id,
        requested_at, expires_at, message_chat_id, message_id, responded_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12)
    `, [
      row.id,
      row.applicationId,
      row.shiftId,
      row.token,
      row.status,
      row.requestedByTelegramUserId,
      row.requestedAt,
      row.expiresAt,
      row.messageChatId,
      row.messageId,
      row.createdAt,
      row.updatedAt
    ]);
  }
}

async function insertInviteGroupMembers(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO invite_group_members (invite_group_id, application_id)
      VALUES ($1, $2)
    `, [row.inviteGroupId, row.applicationId]);
  }
}

async function insertMentorReports(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO mentor_reports (
        id, application_id, mentor_telegram_user_id, result_status, decision,
        venue_id, venue_label, venue_loft, hall, mentor_comment, source, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'application_state', $11)
    `, [
      row.id,
      row.applicationId,
      row.mentorTelegramUserId,
      row.resultStatus,
      row.decision,
      row.venueId,
      row.venueLabel,
      row.venueLoft,
      row.hall,
      row.mentorComment,
      row.createdAt
    ]);
  }
}

async function insertEvents(client, rows) {
  for (const row of rows) {
    await client.query(`
      INSERT INTO application_events (
        id, application_id, shift_id, event_type, actor_type, payload, created_at
      ) VALUES ($1, $2, $3, $4, 'migration', $5::jsonb, $6)
    `, [
      row.id,
      row.applicationId,
      row.shiftId,
      row.eventType,
      JSON.stringify(row.payload),
      row.createdAt
    ]);
  }
}

async function verifyImportedCounts(client, plan) {
  const expected = {
    shifts: plan.shifts.length,
    applications: plan.applications.length,
    candidate_profiles: plan.candidateProfiles.length,
    invite_groups: plan.inviteGroups.length,
    application_assignment_offers: plan.assignmentOffers.length,
    invite_group_members: plan.inviteGroupMembers.length,
    mentor_reports: plan.mentorReports.length
  };
  const actual = {};

  for (const table of Object.keys(expected)) {
    const result = await client.query(`SELECT count(*)::integer AS count FROM ${table}`);
    actual[table] = result.rows[0].count;
    if (actual[table] !== expected[table]) {
      throw new Error(
        `PostgreSQL import verification failed for ${table}: `
        + `expected ${expected[table]}, got ${actual[table]}.`
      );
    }
  }

  const sourceStatuses = Object.create(null);
  for (const application of plan.applications) {
    sourceStatuses[application.status] = (sourceStatuses[application.status] || 0) + 1;
  }
  const statusRows = await client.query(`
    SELECT status, count(*)::integer AS count
    FROM applications
    GROUP BY status
    ORDER BY status
  `);
  const targetStatuses = Object.fromEntries(
    statusRows.rows.map(row => [row.status, row.count])
  );
  if (JSON.stringify(targetStatuses) !== JSON.stringify(
    Object.fromEntries(Object.entries(sourceStatuses).sort(([left], [right]) => left.localeCompare(right)))
  )) {
    throw new Error('PostgreSQL import status distribution does not match JSON.');
  }

  return { expected, actual, statuses: targetStatuses };
}

export async function importBookingState(client, sourceState, {
  sourceChecksum,
  recruiterTelegramIds = [],
  now = new Date()
} = {}) {
  if (!/^[0-9a-f]{64}$/i.test(String(sourceChecksum || ''))) {
    throw new Error('A SHA-256 sourceChecksum is required for PostgreSQL import.');
  }
  const plan = buildBookingImportPlan(sourceState, now);
  await client.query('BEGIN');

  try {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', ['7711012236']);
    await assertEmptyTarget(client);
    await client.query(
      'INSERT INTO booking_state_meta (singleton, version, updated_at) VALUES (true, $1, $2)',
      [plan.state.version, plan.state.updatedAt]
    );
    await insertCandidateProfiles(client, plan.candidateProfiles);
    await insertTelegramUsers(client, plan.telegramUsers);
    await insertRecruiters(client, recruiterTelegramIds, now);
    await insertShifts(client, plan.shifts);
    await insertInviteGroups(client, plan.inviteGroups);
    await insertApplications(client, plan.applications);
    await insertAssignmentOffers(client, plan.assignmentOffers);
    await insertInviteGroupMembers(client, plan.inviteGroupMembers);
    await insertMentorReports(client, plan.mentorReports);
    await insertEvents(client, plan.events);
    await client.query(`
      INSERT INTO data_imports (
        id, source_type, source_checksum, source_version, source_updated_at,
        shifts_count, applications_count, invite_groups_count, imported_at
      ) VALUES ($1, 'booking_json', $2, $3, $4, $5, $6, $7, $8)
    `, [
      randomUUID(),
      sourceChecksum,
      plan.state.version,
      plan.state.updatedAt,
      plan.shifts.length,
      plan.applications.length,
      plan.inviteGroups.length,
      now.toISOString()
    ]);

    const verification = await verifyImportedCounts(client, plan);
    await client.query('COMMIT');
    return { plan, verification };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
